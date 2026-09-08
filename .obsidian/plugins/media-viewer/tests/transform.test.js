// Tests for the transform controls: rotation and flips carrying the crop, and
// the two ways a resize can be asked for.
//
//   node tests/transform.test.js
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const FILES = ["data/assets/a.png", "data/assets/b.png"];
let decodeTo = { width: 1600, height: 1200 };

document.createElement = ((base) => (tag) => {
  const element = base(tag);
  if (tag !== "img") return element;
  Object.defineProperty(element, "src", {
    set(value) {
      element.assignedSrc = value;
      element.naturalWidth = decodeTo.width;
      element.naturalHeight = decodeTo.height;
      setImmediate(() => element.fire("load"));
    },
    get() {
      return element.assignedSrc || "";
    },
    configurable: true,
  });
  return element;
})((tag) => new StubElement(tag));

function fakeApp(paths) {
  const files = paths.map((path) => ({ path }));
  const on = () => ({});
  return {
    files,
    vault: { getFiles: () => files, on, getResourcePath: (file) => "app://local/" + file.path },
    workspace: {
      on,
      getActiveFile: () => null,
      getLeavesOfType() {
        return this.leaves || [];
      },
      onLayoutReady: (fn) => fn(),
    },
    metadataCache: { on },
  };
}

async function editingPane(width, height) {
  dom.clearTimers();
  Notice.messages.length = 0;
  decodeTo = { width: width || 1600, height: height || 1200 };
  const app = fakeApp(FILES);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  await plugin.onload();
  const view = new MediaViewerView({}, plugin);
  view.contentEl = dom.root.createDiv({ cls: "view-content" });
  app.workspace.leaves = [{ view }];
  await view.onOpen();
  view.stageEl.clientWidth = 800;
  view.stageEl.clientHeight = 600;
  plugin.pinFolder("data/assets");
  plugin.select("data/assets/a.png");
  await view.startEdit();
  // Laid out at half size, so a display scale of 0.5 and easy arithmetic.
  view.editCanvasEl.clientWidth = Math.round(decodeTo.width / 2);
  view.editCanvasEl.clientHeight = Math.round(decodeTo.height / 2);
  return { plugin, view };
}

group("rotation", () => {
  test("the buttons turn each way and the readout follows", async () => {
    const { view } = await editingPane();
    ok(view.rotateEdit(90));
    equal(view.session.state.rotate, 90);
    deepEqual(view.session.outputSize, { width: 1200, height: 1600 });
    ok(view.rotateEdit(-90));
    equal(view.session.state.rotate, 0);
  });

  test("rotating with a crop set keeps the same region selected", async () => {
    const { view } = await editingPane();
    view.overlay.set({ x: 0, y: 0, w: 100, h: 600 });
    view.applyCrop();
    const crop = view.session.state.crop;
    deepEqual(crop, { x: 0, y: 0, w: 200, h: 1200 }, "the left-hand strip");
    const before = core.sourceRectFor(crop, 1600, 1200, 0, false, false);

    ok(view.rotateEdit(90));
    const after = core.sourceRectFor(view.session.state.crop, 1600, 1200, 90, false, false);
    deepEqual(after, before, "the same source pixels after the turn");
    deepEqual(view.session.outputSize, { width: 1200, height: 200 });
  });

  test("rotating clears a selection that no longer covers what it did", async () => {
    const { view } = await editingPane();
    view.overlay.set({ x: 10, y: 10, w: 100, h: 100 });
    view.rotateEdit(90);
    equal(view.overlay.selection, null);
  });

  test("the keys turn too", async () => {
    const { view } = await editingPane();
    ok(view.handleKey({ key: "]" }));
    equal(view.session.state.rotate, 90);
    ok(view.handleKey({ key: "[" }));
    equal(view.session.state.rotate, 0);
    ok(view.handleKey({ key: "r" }));
    equal(view.session.state.rotate, 90);
  });

  test("rotation buttons do nothing with no session", async () => {
    const { view } = await editingPane();
    view.endEdit();
    equal(view.rotateEdit(90), false);
    equal(view.rotateLeftEl.disabled, true);
  });
});

group("flips", () => {
  test("each axis toggles, and shows that it is on", async () => {
    const { view } = await editingPane();
    ok(view.flipEdit("h"));
    equal(view.session.state.flipH, true);
    ok(view.flipHEl.hasClass("is-active"));
    ok(view.flipEdit("h"));
    equal(view.session.state.flipH, false);
    equal(view.flipHEl.hasClass("is-active"), false);
  });

  test("the keys flip too, and only in edit mode", async () => {
    const { plugin, view } = await editingPane();
    ok(view.handleKey({ key: "h" }));
    equal(view.session.state.flipH, true);
    ok(view.handleKey({ key: "v" }));
    equal(view.session.state.flipV, true);

    view.endEdit();
    equal(view.handleKey({ key: "h" }), false, "H means nothing to the browsing pane");
  });

  test("a flip carries the crop with it", async () => {
    const { view } = await editingPane();
    view.overlay.set({ x: 0, y: 0, w: 100, h: 600 });
    view.applyCrop();
    const before = core.sourceRectFor(view.session.state.crop, 1600, 1200, 0, false, false);
    ok(view.flipEdit("h"));
    const after = core.sourceRectFor(view.session.state.crop, 1600, 1200, 0, true, false);
    deepEqual(after, before, "the same source pixels");
  });

  test("a rotation after a flip still carries the crop", async () => {
    const { view } = await editingPane();
    view.flipEdit("h");
    view.overlay.set({ x: 0, y: 0, w: 100, h: 600 });
    view.applyCrop();
    const before = core.sourceRectFor(view.session.state.crop, 1600, 1200, 0, true, false);
    view.rotateEdit(90);
    const after = core.sourceRectFor(view.session.state.crop, 1600, 1200, 90, true, false);
    deepEqual(after, before, "the conjugation holds through the UI too");
  });
});

group("resize", () => {
  test("the inputs show what the file will measure", async () => {
    const { view } = await editingPane();
    equal(view.widthEl.value, "1600");
    equal(view.heightEl.value, "1200");
    view.rotateEdit(90);
    equal(view.widthEl.value, "1200");
    equal(view.heightEl.value, "1600");
  });

  test("typing a width keeps the ratio while the link is on", async () => {
    const { view } = await editingPane();
    view.widthEl.value = "800";
    ok(view.resizeEdit("width"));
    deepEqual(view.session.state.resize, { width: 800, height: 600 });
    equal(view.heightEl.value, "600");
  });

  test("typing a height keeps the ratio the other way", async () => {
    const { view } = await editingPane();
    view.heightEl.value = "300";
    ok(view.resizeEdit("height"));
    deepEqual(view.session.state.resize, { width: 400, height: 300 });
  });

  test("unlinking lets the two disagree", async () => {
    const { view } = await editingPane();
    equal(view.sizeLinked, true);
    view.toggleSizeLink();
    equal(view.sizeLinked, false);
    view.widthEl.value = "800";
    ok(view.resizeEdit("width"));
    deepEqual(view.session.state.resize, { width: 800, height: 1200 });
  });

  test("the ratio followed is the crop's, so it survives a crop", async () => {
    const { view } = await editingPane();
    view.overlay.set({ x: 0, y: 0, w: 400, h: 100 });
    view.applyCrop();
    deepEqual(view.session.state.crop, { x: 0, y: 0, w: 800, h: 200 });
    view.widthEl.value = "400";
    ok(view.resizeEdit("width"));
    deepEqual(view.session.state.resize, { width: 400, height: 100 }, "4:1, as the crop is");
  });

  test("a scale is stored as a factor and survives a later crop", async () => {
    const { view } = await editingPane();
    ok(view.scaleEdit(0.5));
    deepEqual(view.session.state.resize, { scale: 0.5 });
    deepEqual(view.session.outputSize, { width: 800, height: 600 });

    view.overlay.set({ x: 0, y: 0, w: 400, h: 300 });
    view.applyCrop();
    deepEqual(view.session.state.resize, { scale: 0.5 }, "still half of whatever is cropped");
    deepEqual(view.session.outputSize, { width: 400, height: 300 });
  });

  test("a typed size is dropped by a crop it no longer describes", async () => {
    const { view } = await editingPane();
    view.widthEl.value = "800";
    view.resizeEdit("width");
    view.overlay.set({ x: 0, y: 0, w: 400, h: 300 });
    view.applyCrop();
    equal(view.session.state.resize, null, "800 x 600 was typed against a different picture");
  });

  test("100% is no resize at all", async () => {
    const { view } = await editingPane();
    view.scaleEdit(0.5);
    ok(view.scaleEdit(1));
    equal(view.session.state.resize, null);
  });

  test("the scale dropdown shows a factor and not a typed size", async () => {
    const { view } = await editingPane();
    view.scaleEdit(0.25);
    equal(view.scaleEl.value, "0.25");
    view.widthEl.value = "999";
    view.resizeEdit("width");
    equal(view.scaleEl.value, "1", "a typed size is not a percentage of anything");
  });

  test("nonsense in an input is refused and the readout put back", async () => {
    const { view } = await editingPane();
    view.widthEl.value = "0";
    equal(view.resizeEdit("width"), false);
    equal(view.session.state.resize, null);
    equal(view.widthEl.value, "1600", "the number on screen is the number in the file");

    view.widthEl.value = "";
    equal(view.resizeEdit("width"), false);
    equal(view.widthEl.value, "1600");
  });

  test("retyping the size it already is is not an edit", async () => {
    const { view } = await editingPane();
    view.widthEl.value = "1600";
    equal(view.resizeEdit("width"), false);
    equal(view.session.canUndo, false);
  });

  test("a quarter turn swaps a typed size, and leaves a scale alone", async () => {
    const { view } = await editingPane();
    view.widthEl.value = "800";
    view.resizeEdit("width");
    view.rotateEdit(90);
    deepEqual(view.session.state.resize, { width: 600, height: 800 });

    const second = await editingPane();
    second.view.scaleEdit(0.5);
    second.view.rotateEdit(90);
    deepEqual(second.view.session.state.resize, { scale: 0.5 });
  });
});

group("everything at once", () => {
  test("rotate, flip, crop and resize compose into one output", async () => {
    const { view } = await editingPane();
    view.rotateEdit(90);
    view.flipEdit("h");
    // The canvas is now 1200x1600 source pixels, laid out at half.
    view.editCanvasEl.clientWidth = 600;
    view.editCanvasEl.clientHeight = 800;
    view.overlay.set({ x: 0, y: 0, w: 300, h: 400 });
    ok(view.applyCrop());
    deepEqual(view.session.state.crop, { x: 0, y: 0, w: 600, h: 800 });
    view.scaleEdit(0.5);
    deepEqual(view.session.outputSize, { width: 300, height: 400 });

    const plan = view.session.plan();
    equal(plan.width, 300);
    equal(plan.height, 400);
    // The corners of the source still land on the canvas or outside it, never
    // in some third place: the composed matrix is a real transform.
    const corner = core.applyMatrix(plan.matrix, 0, 0);
    ok(Number.isFinite(corner.x) && Number.isFinite(corner.y), "a real point");
  });
});

report("transform");
