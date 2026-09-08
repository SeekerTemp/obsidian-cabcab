// Tests for edit mode in the pane: opening a session on the displayed image,
// what happens when the decode budget refuses one, and the fact that a session
// belongs to the file it was started on. Run with:
//
//   node tests/editmode.test.js
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const FILES = ["data/assets/a.png", "data/assets/b.png", "data/assets/c.mp4"];
const STAGE = { width: 400, height: 300 };

// What every <img> in the pane decodes to, including the one edit mode makes.
// A test sets it before acting; `fail` is the corrupt-file case.
let decodeTo = { width: 1600, height: 1200, fail: false };
let decodes = 0;

const realCreateElement = (tag) => new StubElement(tag);
document.createElement = (tag) => {
  const element = realCreateElement(tag);
  if (tag !== "img") return element;
  Object.defineProperty(element, "src", {
    set(value) {
      element.assignedSrc = value;
      decodes += 1;
      element.naturalWidth = decodeTo.width;
      element.naturalHeight = decodeTo.height;
      // A tick later, as a real decode is.
      setImmediate(() => element.fire(decodeTo.fail ? "error" : "load"));
    },
    get() {
      return element.assignedSrc || "";
    },
    configurable: true,
  });
  return element;
};

function fakeApp(paths) {
  const files = paths.map((path) => ({ path }));
  const on = () => ({});
  return {
    files,
    vault: {
      getFiles: () => files,
      on,
      getResourcePath: (file) => "app://local/" + file.path,
    },
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

async function paneOver(paths) {
  dom.clearTimers();
  Notice.messages.length = 0;
  decodeTo = { width: 1600, height: 1200, fail: false };
  decodes = 0;
  const app = fakeApp(paths);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  await plugin.onload();
  const view = new MediaViewerView({}, plugin);
  view.contentEl = dom.root.createDiv({ cls: "view-content" });
  app.workspace.leaves = [{ view }];
  await view.onOpen();
  view.stageEl.clientWidth = STAGE.width;
  view.stageEl.clientHeight = STAGE.height;
  plugin.pinFolder("data/assets");
  return { plugin, view, app };
}

const canvasOf = (view) => view.stageEl.querySelector(".mv-edit-canvas");
const statusOf = (view) => {
  const el = view.stageEl.querySelector(".mv-edit-status");
  return el ? el.textContent : null;
};

group("opening a session", () => {
  test("Edit is offered for an image and refused for a video", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    equal(view.editEl.disabled, false);
    plugin.select("data/assets/c.mp4");
    equal(view.editEl.disabled, true);
  });

  test("Edit is not offered with nothing selected", async () => {
    const { view } = await paneOver(FILES);
    equal(view.editEl.disabled, true);
  });

  test("editing replaces the image with a canvas of the same picture", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    ok(await view.startEdit(), "the session opened");
    ok(canvasOf(view), "a canvas is on the stage");
    equal(view.stageEl.querySelector(".mv-image"), null, "and the <img> has gone");
    ok(view.viewerEl.hasClass("is-editing"));
    equal(view.editEl.textContent, "Done");
    equal(view.session.sourceWidth, 1600);
    equal(view.session.sourceHeight, 1200);
  });

  test("the readout says what the output will measure", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    await view.startEdit();
    equal(statusOf(view), "1600 x 1200");
    view.session.rotateBy(90);
    equal(statusOf(view), "1200 x 1600 · 90°");
  });

  test("Done ends the session and puts the image back", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    await view.startEdit();
    ok(view.endEdit());
    equal(view.session, null);
    equal(canvasOf(view), null);
    ok(view.stageEl.querySelector(".mv-image"), "the <img> is back");
    equal(view.editEl.textContent, "Edit");
  });

  test("a second Edit while the first is decoding joins it", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    const before = decodes;
    const first = view.startEdit();
    const second = view.startEdit();
    ok(await first, "the first opened a session");
    ok(await second, "and so did the second");
    equal(decodes - before, 1, "one decode, not two");
    ok(view.session);
  });

  test("stepping to another file ends the session", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    await view.startEdit();
    view.session.rotateBy(90);
    plugin.select("data/assets/b.png");
    equal(view.session, null, "an unsaved edit belongs to the file it was started on");
    equal(canvasOf(view), null);
  });

  test("a decode that finishes after the user has moved on is dropped", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    const opening = view.startEdit();
    plugin.select("data/assets/b.png");
    equal(await opening, false, "the pixels are correct and no longer the ones on screen");
    equal(view.session, null);
  });
});

group("the budget refusing", () => {
  test("an image over the ceiling is refused, and the pane keeps browsing", async () => {
    const { plugin, view } = await paneOver(FILES);
    decodeTo = { width: 12000, height: 9000, fail: false };
    plugin.select("data/assets/a.png");
    equal(await view.startEdit(), false);
    equal(view.session, null, "no session, and no decode held on to");
    ok(Notice.messages.length, "the user was told");
    const message = Notice.messages[Notice.messages.length - 1];
    ok(message.includes("108"), message);
    ok(message.includes("40 MP"), message);
    ok(message.includes("a.png"), message);
    // The point of refusing rather than freezing: everything else still works.
    equal(view.editEl.disabled, false, "and Edit can be tried on the next file");
  });

  test("an image the browser cannot decode reports without claiming a budget", async () => {
    const { plugin, view } = await paneOver(FILES);
    decodeTo = { width: 0, height: 0, fail: true };
    plugin.select("data/assets/a.png");
    equal(await view.startEdit(), false);
    const message = Notice.messages[Notice.messages.length - 1];
    ok(message.includes("could not be decoded"), message);
    ok(!message.includes("MP"), message);
  });
});

group("a session under a proxy", () => {
  test("a large image edits through a downscaled preview", async () => {
    const { plugin, view } = await paneOver(FILES);
    decodeTo = { width: 8192, height: 4096, fail: false };
    plugin.select("data/assets/a.png");
    ok(await view.startEdit());
    equal(view.session.sourceWidth, 8192, "the maths still runs at full size");
    equal(view.session.preview.width, 4096);
    equal(canvasOf(view).width, 4096, "and the canvas holds the proxy");
    ok(statusOf(view).includes("8192 x 4096"), statusOf(view));
    ok(statusOf(view).includes("preview at 50%"), statusOf(view));
  });

  test("the display scale is read off the laid-out canvas", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    await view.startEdit();
    // The canvas is 1600 device pixels wide and laid out at 400 CSS pixels.
    canvasOf(view).clientWidth = 400;
    close(view.editDisplayScale, 0.25);
    view.session.setCrop({ x: 0, y: 0, w: 800, h: 600 });
    canvasOf(view).clientWidth = 400;
    close(view.editDisplayScale, 0.5, 1e-9, "measured against what the canvas shows");
  });
});

report("editmode");
