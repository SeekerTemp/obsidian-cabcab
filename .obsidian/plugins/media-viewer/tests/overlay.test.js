// Tests for the crop overlay: the arithmetic every handle does, then the
// element that drives it and the pane that turns a selection into a crop.
//
//   node tests/overlay.test.js
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, CropOverlay, core } = require("./load-plugin.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const BOUNDS = { width: 400, height: 300 };

group("handle arithmetic", () => {
  const rect = { x: 100, y: 100, w: 200, h: 100 };

  test("a corner handle pivots on the opposite corner", () => {
    const se = core.handleAnchor(rect, "se");
    equal(se.x, 100, "the left edge");
    equal(se.y, 100, "the top edge");
    const nw = core.handleAnchor(rect, "nw");
    equal(nw.x, 300, "the right edge");
    equal(nw.y, 200, "the bottom edge");
  });

  test("an edge handle pivots on the opposite edge and centres the other axis", () => {
    const east = core.handleAnchor(rect, "e");
    equal(east.x, 100, "the left edge is fixed");
    equal(east.y, 150, "and the vertical axis is untouched, so it reads as its middle");
    ok(east.centredY, "which is what makes an aspect lock grow it both ways");
    equal(east.centredX, false);
  });

  test("dragging the east handle moves only the right edge", () => {
    deepEqual(core.resizeSelection(rect, "e", 50, 999, BOUNDS), { x: 100, y: 100, w: 250, h: 100 });
  });

  test("dragging the south handle moves only the bottom edge", () => {
    deepEqual(core.resizeSelection(rect, "s", 999, -40, BOUNDS), { x: 100, y: 100, w: 200, h: 60 });
  });

  test("dragging a corner moves both its edges", () => {
    deepEqual(core.resizeSelection(rect, "nw", -50, -50, BOUNDS), { x: 50, y: 50, w: 250, h: 150 });
  });

  test("dragging an edge past its opposite flips rather than going negative", () => {
    deepEqual(core.resizeSelection(rect, "w", 260, 0, BOUNDS), { x: 300, y: 100, w: 60, h: 100 });
  });

  test("a resize is clamped to the image", () => {
    deepEqual(core.resizeSelection(rect, "se", 500, 500, BOUNDS), { x: 100, y: 100, w: 300, h: 200 });
    deepEqual(core.resizeSelection(rect, "nw", -500, -500, BOUNDS), { x: 0, y: 0, w: 300, h: 200 });
  });

  test("moving slides and is stopped by the edge, not squashed by it", () => {
    deepEqual(core.resizeSelection(rect, "move", 40, 40, BOUNDS), { x: 140, y: 140, w: 200, h: 100 });
    const pinned = core.resizeSelection(rect, "move", 500, 500, BOUNDS);
    deepEqual(pinned, { x: 200, y: 200, w: 200, h: 100 }, "the size survives the corner");
  });

  test("moving a selection larger than the image pins it at the origin", () => {
    deepEqual(core.resizeSelection({ x: 0, y: 0, w: 500, h: 400 }, "move", 50, 50, BOUNDS), {
      x: 0,
      y: 0,
      w: 500,
      h: 400,
    });
  });

  test("an unknown handle changes nothing", () => {
    deepEqual(core.resizeSelection(rect, "middle", 50, 50, BOUNDS), rect);
  });

  test("all eight handles exist and each moves what its name says", () => {
    equal(core.CROP_HANDLES.length, 8);
    for (const handle of core.CROP_HANDLES) {
      const moved = core.resizeSelection(rect, handle, 10, 10, BOUNDS);
      const touchesX = handle.includes("e") || handle.includes("w");
      const touchesY = handle.includes("n") || handle.includes("s");
      equal(moved.w !== rect.w, touchesX, handle + " width");
      equal(moved.h !== rect.h, touchesY, handle + " height");
    }
  });
});

group("the aspect lock", () => {
  const rect = { x: 100, y: 100, w: 100, h: 100 };

  test("a corner drag grows to cover the pointer and keeps the ratio", () => {
    const square = core.resizeSelection(rect, "se", 60, 20, BOUNDS, 1);
    equal(square.w, square.h, "still square");
    ok(square.w >= 160, "and it reaches the pointer: " + square.w);
  });

  test("16:9 stays 16:9", () => {
    const wide = core.resizeSelection(rect, "se", 100, 0, BOUNDS, 16 / 9);
    close(wide.w / wide.h, 16 / 9, 1e-9);
  });

  test("an edge handle grows its perpendicular axis from the middle", () => {
    const tall = core.resizeSelection(rect, "s", 0, 100, BOUNDS, 1);
    equal(tall.h, 200);
    equal(tall.w, 200);
    equal(tall.x, 50, "centred on the same middle: 150 - 100");
    equal(tall.y, 100, "and the top edge is the anchor");
  });

  test("hitting the edge shrinks toward the anchor rather than clipping", () => {
    // Anchored at (100,100), 1:1, dragged well past the bottom of a 300-high
    // image: the height is capped at 200 and the width follows it down.
    const fitted = core.resizeSelection(rect, "se", 900, 900, BOUNDS, 1);
    equal(fitted.h, 200);
    equal(fitted.w, 200, "the lock still holds at the boundary");
    ok(fitted.x + fitted.w <= BOUNDS.width);
    ok(fitted.y + fitted.h <= BOUNDS.height);
  });

  test("a nonsense ratio is treated as no lock", () => {
    deepEqual(
      core.resizeSelection(rect, "se", 50, 20, BOUNDS, 0),
      core.resizeSelection(rect, "se", 50, 20, BOUNDS)
    );
    deepEqual(
      core.resizeSelection(rect, "se", 50, 20, BOUNDS, NaN),
      core.resizeSelection(rect, "se", 50, 20, BOUNDS)
    );
  });

  test("the offered ratios are a list, not a parser", () => {
    equal(core.CROP_ASPECTS[0][0], "Free");
    equal(core.CROP_ASPECTS[0][1], null);
    const square = core.CROP_ASPECTS.find((entry) => entry[0] === "1:1");
    equal(square[1], 1);
  });
});

group("a selection worth keeping", () => {
  test("a click-sized selection is a mis-click", () => {
    ok(core.isNegligibleSelection({ x: 0, y: 0, w: 2, h: 200 }));
    ok(core.isNegligibleSelection({ x: 0, y: 0, w: 0, h: 0 }));
    equal(core.isNegligibleSelection({ x: 0, y: 0, w: 40, h: 30 }), false);
  });

  test("a crop drawn on a crop is offset by the one underneath it", () => {
    deepEqual(core.cropWithinCrop({ x: 100, y: 50, w: 400, h: 300 }, { x: 10, y: 20, w: 50, h: 60 }), {
      x: 110,
      y: 70,
      w: 50,
      h: 60,
    });
  });
});

/* The overlay element. */

function overlayOn(bounds) {
  const host = new StubElement("div");
  host.clientWidth = bounds.width;
  host.clientHeight = bounds.height;
  const changes = [];
  const overlay = new CropOverlay(host, {
    bounds: () => bounds,
    label: (rect) => rect.w + "x" + rect.h,
    onChange: (selection) => changes.push(selection),
  });
  overlay.el.clientWidth = bounds.width;
  overlay.el.clientHeight = bounds.height;
  return { host, overlay, changes };
}

// One pointer gesture, start to finish.
function drag(overlay, from, to, target) {
  const el = overlay.el;
  el.dispatch("pointerdown", {
    clientX: from.x,
    clientY: from.y,
    pointerId: 1,
    button: 0,
    target: target || el,
  });
  el.dispatch("pointermove", { clientX: to.x, clientY: to.y, pointerId: 1, target: target || el });
  el.dispatch("pointerup", { clientX: to.x, clientY: to.y, pointerId: 1, target: target || el });
  return overlay.selection;
}

group("the overlay element", () => {
  test("it starts with nothing selected and its rectangle hidden", () => {
    const { overlay } = overlayOn(BOUNDS);
    equal(overlay.selection, null);
    equal(overlay.rectEl.style.display, "none");
    equal(overlay.el.hasClass("has-selection"), false);
  });

  test("it has eight handles", () => {
    const { overlay } = overlayOn(BOUNDS);
    equal(overlay.handleEls.size, 8);
    deepEqual(
      overlay.rectEl.children.filter((el) => el.dataset.handle).map((el) => el.dataset.handle),
      core.CROP_HANDLES
    );
  });

  test("dragging on the picture draws a selection", () => {
    const { overlay } = overlayOn(BOUNDS);
    drag(overlay, { x: 50, y: 40 }, { x: 250, y: 190 });
    deepEqual(overlay.selection, { x: 50, y: 40, w: 200, h: 150 });
    ok(overlay.el.hasClass("has-selection"));
    equal(overlay.rectEl.style.left, "50px");
    equal(overlay.rectEl.style.width, "200px");
    equal(overlay.readoutEl.textContent, "200x150");
  });

  test("dragging up and to the left works the same", () => {
    const { overlay } = overlayOn(BOUNDS);
    drag(overlay, { x: 250, y: 190 }, { x: 50, y: 40 });
    deepEqual(overlay.selection, { x: 50, y: 40, w: 200, h: 150 });
  });

  test("a click clears the selection rather than leaving a speck", () => {
    const { overlay } = overlayOn(BOUNDS);
    drag(overlay, { x: 50, y: 40 }, { x: 250, y: 190 });
    drag(overlay, { x: 10, y: 10 }, { x: 11, y: 11 });
    equal(overlay.selection, null);
    equal(overlay.rectEl.style.display, "none");
  });

  test("a selection can be adjusted by its handles, not just redrawn", () => {
    // The whole point of the task: the old app's rectangle could only be
    // thrown away and drawn again.
    const { overlay } = overlayOn(BOUNDS);
    drag(overlay, { x: 50, y: 50 }, { x: 250, y: 150 });
    const handle = overlay.handleEls.get("e");
    drag(overlay, { x: 250, y: 100 }, { x: 300, y: 100 }, handle);
    deepEqual(overlay.selection, { x: 50, y: 50, w: 250, h: 100 });
  });

  test("dragging inside the rectangle moves it", () => {
    const { overlay } = overlayOn(BOUNDS);
    drag(overlay, { x: 50, y: 50 }, { x: 150, y: 150 });
    drag(overlay, { x: 100, y: 100 }, { x: 130, y: 120 }, overlay.rectEl);
    deepEqual(overlay.selection, { x: 80, y: 70, w: 100, h: 100 });
  });

  test("a drag is measured from where it started, not frame to frame", () => {
    const { overlay } = overlayOn(BOUNDS);
    const el = overlay.el;
    el.dispatch("pointerdown", { clientX: 50, clientY: 50, pointerId: 1, button: 0, target: el });
    el.dispatch("pointermove", { clientX: 200, clientY: 200, pointerId: 1, target: el });
    el.dispatch("pointermove", { clientX: 100, clientY: 100, pointerId: 1, target: el });
    el.dispatch("pointerup", { clientX: 100, clientY: 100, pointerId: 1, target: el });
    deepEqual(overlay.selection, { x: 50, y: 50, w: 50, h: 50 }, "coming back means coming back");
  });

  test("a drag beyond the picture is clamped to it", () => {
    const { overlay } = overlayOn(BOUNDS);
    drag(overlay, { x: 200, y: 200 }, { x: 900, y: 900 });
    deepEqual(overlay.selection, { x: 200, y: 200, w: 200, h: 100 });
  });

  test("choosing a ratio reshapes what is already selected", () => {
    const { overlay } = overlayOn(BOUNDS);
    drag(overlay, { x: 20, y: 20 }, { x: 220, y: 120 });
    overlay.setAspect(1);
    equal(overlay.selection.w, overlay.selection.h);
  });

  test("a locked drag keeps the ratio", () => {
    const { overlay } = overlayOn(BOUNDS);
    overlay.setAspect(1);
    drag(overlay, { x: 20, y: 20 }, { x: 220, y: 60 });
    equal(overlay.selection.w, overlay.selection.h);
  });

  test("select all is the whole picture, and clear is none of it", () => {
    const { overlay } = overlayOn(BOUNDS);
    overlay.selectAll();
    deepEqual(overlay.selection, { x: 0, y: 0, w: 400, h: 300 });
    ok(overlay.clear());
    equal(overlay.selection, null);
    equal(overlay.clear(), false, "clearing nothing is not a change");
  });

  test("every change is reported once", () => {
    const { overlay, changes } = overlayOn(BOUNDS);
    drag(overlay, { x: 50, y: 50 }, { x: 150, y: 150 });
    equal(changes.length, 2, "one for the move, one for the release");
    deepEqual(changes[changes.length - 1], { x: 50, y: 50, w: 100, h: 100 });
  });

  test("a second pointer is ignored while one is dragging", () => {
    const { overlay } = overlayOn(BOUNDS);
    const el = overlay.el;
    el.dispatch("pointerdown", { clientX: 50, clientY: 50, pointerId: 1, button: 0, target: el });
    el.dispatch("pointermove", { clientX: 150, clientY: 150, pointerId: 2, target: el });
    deepEqual(overlay.selection, { x: 50, y: 50, w: 0, h: 0 });
    el.dispatch("pointermove", { clientX: 150, clientY: 150, pointerId: 1, target: el });
    deepEqual(overlay.selection, { x: 50, y: 50, w: 100, h: 100 });
  });

  test("a right-click starts nothing", () => {
    const { overlay } = overlayOn(BOUNDS);
    overlay.el.dispatch("pointerdown", { clientX: 50, clientY: 50, pointerId: 1, button: 2, target: overlay.el });
    equal(overlay.drag, null);
    equal(overlay.selection, null);
  });
});

/* The pane turning a selection into a crop. */

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

// A pane with an open session, laid out so that the canvas is exactly half the
// size of the image it is showing — a display scale of 0.5, which is where the
// interesting conversions live.
async function editingPane(canvasWidth) {
  dom.clearTimers();
  Notice.messages.length = 0;
  decodeTo = { width: 1600, height: 1200 };
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
  const width = canvasWidth === undefined ? 800 : canvasWidth;
  view.editCanvasEl.clientWidth = width;
  view.editCanvasEl.clientHeight = Math.round((width * 1200) / 1600);
  return { plugin, view };
}

group("a selection becoming a crop", () => {
  test("the readout is in source pixels, not screen pixels", async () => {
    const { view } = await editingPane(800);
    // The canvas is laid out at half the image's size, so 200 CSS pixels of
    // selection is 400 source pixels.
    view.overlay.set({ x: 0, y: 0, w: 200, h: 100 });
    equal(view.selectionLabel({ x: 0, y: 0, w: 200, h: 100 }), "400 x 200");
    deepEqual(view.selectionCrop(), { x: 0, y: 0, w: 400, h: 200 });
  });

  test("Crop is offered only once there is a selection", async () => {
    const { view } = await editingPane(800);
    equal(view.cropEl.disabled, true);
    view.overlay.set({ x: 10, y: 10, w: 100, h: 100 });
    equal(view.cropEl.disabled, false);
    view.overlay.clear();
    equal(view.cropEl.disabled, true);
  });

  test("cropping applies the selection at full resolution", async () => {
    const { view } = await editingPane(800);
    view.overlay.set({ x: 100, y: 50, w: 200, h: 100 });
    ok(view.applyCrop());
    deepEqual(view.session.state.crop, { x: 200, y: 100, w: 400, h: 200 });
    deepEqual(view.session.outputSize, { width: 400, height: 200 });
    equal(view.overlay.selection, null, "and the selection is spent");
  });

  test("a crop of a crop is offset by the one underneath it", async () => {
    const { view } = await editingPane(800);
    view.overlay.set({ x: 100, y: 50, w: 200, h: 100 });
    view.applyCrop();
    // The canvas now shows 400x200 source pixels; lay it out at 400 CSS wide,
    // so the scale is 1:1 and the arithmetic is easy to read.
    view.editCanvasEl.clientWidth = 400;
    view.editCanvasEl.clientHeight = 200;
    view.overlay.set({ x: 10, y: 20, w: 100, h: 50 });
    deepEqual(view.selectionCrop(), { x: 210, y: 120, w: 100, h: 50 });
    ok(view.applyCrop());
    deepEqual(view.session.state.crop, { x: 210, y: 120, w: 100, h: 50 });
  });

  test("cropping with no selection says so rather than doing nothing", async () => {
    const { view } = await editingPane(800);
    equal(view.applyCrop(), false);
    ok(Notice.messages[Notice.messages.length - 1].includes("drag a selection"));
  });

  test("Enter crops and Escape steps back one level at a time", async () => {
    const { view } = await editingPane(800);
    view.overlay.set({ x: 100, y: 50, w: 200, h: 100 });
    ok(view.handleKey({ key: "Enter" }));
    ok(view.session.state.crop, "Enter cropped");

    view.editCanvasEl.clientWidth = 400;
    view.overlay.set({ x: 10, y: 10, w: 100, h: 50 });
    ok(view.handleKey({ key: "Escape" }));
    equal(view.overlay.selection, null, "the selection first");
    ok(view.handleKey({ key: "Escape" }));
    equal(view.session, null, "the session second");
  });

  test("Ctrl+Z undoes the crop and clears the selection", async () => {
    const { view } = await editingPane(800);
    view.overlay.set({ x: 100, y: 50, w: 200, h: 100 });
    view.applyCrop();
    ok(view.handleKey({ key: "z", ctrlKey: true }));
    equal(view.session.state.crop, null);
    ok(view.handleKey({ key: "z", ctrlKey: true, shiftKey: true }));
    deepEqual(view.session.state.crop, { x: 200, y: 100, w: 400, h: 200 });
  });

  test("undo and redo are offered only when there is something to do", async () => {
    const { view } = await editingPane(800);
    equal(view.undoEl.disabled, true);
    equal(view.redoEl.disabled, true);
    equal(view.resetEl.disabled, true);
    view.overlay.set({ x: 100, y: 50, w: 200, h: 100 });
    view.applyCrop();
    equal(view.undoEl.disabled, false);
    equal(view.resetEl.disabled, false);
    view.undoEdit();
    equal(view.redoEl.disabled, false);
  });

  test("Reset comes back in one undoable step", async () => {
    const { view } = await editingPane(800);
    view.overlay.set({ x: 100, y: 50, w: 200, h: 100 });
    view.applyCrop();
    view.session.rotateBy(90);
    ok(view.resetEdit());
    equal(view.session.dirty, false);
    ok(view.undoEdit());
    equal(view.session.state.rotate, 90);
  });

  test("A and D still step siblings while a session is open", async () => {
    const { plugin, view } = await editingPane(800);
    ok(view.handleKey({ key: "d" }));
    equal(plugin.selectedPath, "data/assets/b.png");
    equal(view.session, null, "and moving on ended the edit");
  });

  test("the aspect ratio survives a change of file", async () => {
    const { plugin, view } = await editingPane(800);
    view.setAspect("1");
    equal(view.overlay.aspect, 1);
    plugin.select("data/assets/b.png");
    await view.startEdit();
    equal(view.overlay.aspect, 1, "the ratio belongs to the user, not the picture");
  });
});

report("overlay");
