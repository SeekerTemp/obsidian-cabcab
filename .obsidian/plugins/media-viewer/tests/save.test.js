// Tests for saving an edit: the format the output follows, the file it is
// written to, and the fact that a save costs no rescan.
//
//   node tests/save.test.js
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, EditSession, core } = require("./load-plugin.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

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

group("the output format follows the source", () => {
  test("a JPEG crop stays a JPEG, not a 15 MB PNG", () => {
    equal(core.mimeForExtension("jpg"), "image/jpeg");
    equal(core.mimeForExtension("jpeg"), "image/jpeg");
    equal(core.outputExtensionFor("jpeg"), "jpg");
  });

  test("WebP stays WebP", () => {
    equal(core.mimeForExtension("webp"), "image/webp");
    equal(core.outputExtensionFor("webp"), "webp");
  });

  test("everything lossless comes out as PNG", () => {
    for (const extension of ["png", "bmp", "gif", "tiff", ""]) {
      equal(core.mimeForExtension(extension), "image/png", extension);
      equal(core.outputExtensionFor(extension), "png", extension);
    }
  });

  test("quality applies to the lossy formats and to nothing else", () => {
    equal(core.encodeQualityFor("image/png", 0.5), undefined);
    equal(core.encodeQualityFor("image/jpeg", 0.5), 0.5);
    equal(core.encodeQualityFor("image/webp", 0.5), 0.5);
  });

  test("a missing quality falls back to the default rather than to nothing", () => {
    equal(core.encodeQualityFor("image/jpeg"), core.DEFAULT_ENCODE_QUALITY);
    equal(core.encodeQualityFor("image/jpeg", "sharp"), core.DEFAULT_ENCODE_QUALITY);
  });

  test("quality is clamped into a range a browser will accept", () => {
    equal(core.encodeQualityFor("image/jpeg", 5), 1);
    equal(core.encodeQualityFor("image/jpeg", -1), 0.1);
    equal(core.clampQuality(0.8), 0.8);
    equal(core.clampQuality(NaN), core.DEFAULT_ENCODE_QUALITY);
  });
});

group("encoding a session", () => {
  function sessionOn(path, width, height) {
    return new EditSession({ path, image: new StubElement("img"), width, height });
  }

  test("the canvas is asked for the source's own format", async () => {
    const session = sessionOn("data/assets/photo.jpg", 800, 600);
    session.setCrop({ x: 0, y: 0, w: 400, h: 300 });
    const encoded = await session.encode({ quality: 0.8 });
    equal(encoded.mime, "image/jpeg");
    equal(encoded.quality, 0.8);
    equal(encoded.blob.canvas.width, 400, "and it is the edit that was encoded");
    equal(encoded.blob.canvas.encoded.type, "image/jpeg");
    equal(encoded.blob.canvas.encoded.quality, 0.8);
  });

  test("a PNG is encoded with no quality at all", async () => {
    const session = sessionOn("data/assets/logo.png", 100, 100);
    const encoded = await session.encode({ quality: 0.5 });
    equal(encoded.mime, "image/png");
    equal(encoded.quality, undefined);
    equal(encoded.blob.canvas.encoded.quality, undefined);
  });

  test("a browser that cannot encode the format fails rather than writing nothing", async () => {
    const session = sessionOn("data/assets/photo.webp", 100, 100);
    const canvas = new StubElement("canvas");
    canvas.failEncode = true;
    session.render = () => session.renderTo(canvas);
    let error = null;
    try {
      await session.encode({});
    } catch (thrown) {
      error = thrown;
    }
    ok(error, "it failed");
    ok(error.message.includes("image/webp"), error.message);
  });
});

/* The save path through the pane. */

const FILES = ["data/assets/a.png", "data/assets/b.jpg", "data/assets/c.png"];

function fakeApp(paths) {
  const files = paths.map((path) => ({ path }));
  const on = () => ({});
  const written = [];
  return {
    files,
    written,
    vault: {
      getFiles: () => files,
      on,
      getResourcePath: (file) => "app://local/" + file.path,
      getAbstractFileByPath: (path) => files.find((file) => file.path === path) || null,
      async createBinary(path, bytes) {
        if (this.failWrite) throw new Error("disk full");
        const file = { path, bytes };
        files.push(file);
        written.push(file);
        return file;
      },
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

async function editingPane(path) {
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
  plugin.select(path || "data/assets/a.png");
  await view.startEdit();
  view.editCanvasEl.clientWidth = 800;
  view.editCanvasEl.clientHeight = 600;
  return { plugin, view, app };
}

group("saving", () => {
  test("Save is offered only for an edit that would change something", async () => {
    const { view } = await editingPane();
    equal(view.saveEl.disabled, true, "an untouched image saves to a copy, which is not this button");
    view.rotateEdit(90);
    equal(view.saveEl.disabled, false);
  });

  test("a crop writes a new file beside the source and leaves the source alone", async () => {
    const { view, app } = await editingPane();
    view.overlay.set({ x: 0, y: 0, w: 400, h: 300 });
    view.applyCrop();
    const path = await view.saveEdit();
    ok(path, "something was written");
    equal(core.folderOf(path), "data/assets", "beside the source");
    ok(core.baseNameOf(path).startsWith("a+clone+"), path);
    equal(core.extensionOf(path), "png");
    equal(app.written.length, 1);
    ok(app.files.some((file) => file.path === "data/assets/a.png"), "the source is still there");
  });

  test("cropping a JPEG yields a JPEG", async () => {
    const { view, app } = await editingPane("data/assets/b.jpg");
    view.overlay.set({ x: 0, y: 0, w: 400, h: 300 });
    view.applyCrop();
    const path = await view.saveEdit();
    equal(core.extensionOf(path), "jpg");
    ok(core.baseNameOf(path).startsWith("b+clone+"), path);
  });

  test("the selection follows to the new file, with no rescan", async () => {
    const { plugin, view } = await editingPane();
    const scansBefore = plugin.index.scans === undefined ? 0 : plugin.index.scans;
    view.rotateEdit(90);
    const path = await view.saveEdit();
    equal(plugin.selectedPath, path, "selection is a path, so it can follow");
    ok(plugin.index.has(path), "and the index gained the file by insertion");
    equal(plugin.index.scans === undefined ? 0 : plugin.index.scans, scansBefore, "no rescan");
  });

  test("a fresh session opens on the saved file, with no history behind it", async () => {
    const { view } = await editingPane();
    view.rotateEdit(90);
    const path = await view.saveEdit();
    ok(view.session, "still editing");
    equal(view.session.path, path, "the new file");
    equal(view.session.canUndo, false, "undo never steps back past a file already written");
    equal(view.session.dirty, false);
  });

  test("the file written is the edit, at full resolution", async () => {
    const { view, app } = await editingPane();
    view.overlay.set({ x: 100, y: 50, w: 200, h: 100 });
    view.applyCrop();
    deepEqual(view.session.outputSize, { width: 400, height: 200 });
    await view.saveEdit();
    equal(app.written[0].bytes.byteLength, 400 * 200, "the stub's bytes are its pixel count");
  });

  test("saving twice does not collide", async () => {
    const { view, app } = await editingPane();
    view.rotateEdit(90);
    const first = await view.saveEdit();
    view.rotateEdit(90);
    const second = await view.saveEdit();
    ok(first !== second, first + " vs " + second);
    equal(app.written.length, 2);
  });

  test("one click does not write two files", async () => {
    const { view, app } = await editingPane();
    view.rotateEdit(90);
    const both = await Promise.all([view.saveEdit(), view.saveEdit()]);
    equal(app.written.length, 1);
    equal(both[0], both[1]);
  });

  test("a write that fails keeps the edit session open", async () => {
    const { view, app } = await editingPane();
    app.vault.failWrite = true;
    view.overlay.set({ x: 0, y: 0, w: 400, h: 300 });
    view.applyCrop();
    equal(await view.saveEdit(), null);
    ok(view.session, "the session survives");
    deepEqual(view.session.state.crop, { x: 0, y: 0, w: 800, h: 600 }, "and so does the crop");
    ok(Notice.messages[Notice.messages.length - 1].includes("still open"));
    equal(app.written.length, 0);
  });

  test("an encode that fails keeps the session open too", async () => {
    const { view, app } = await editingPane();
    view.rotateEdit(90);
    const broken = new StubElement("canvas");
    broken.failEncode = true;
    view.session.render = () => view.session.renderTo(broken);
    equal(await view.saveEdit(), null);
    ok(view.session);
    equal(view.session.state.rotate, 90);
    equal(app.written.length, 0);
    ok(Notice.messages[Notice.messages.length - 1].includes("still open"));
  });

  test("Ctrl+S saves", async () => {
    const { view, app } = await editingPane();
    view.rotateEdit(90);
    ok(view.handleKey({ key: "s", ctrlKey: true }));
    await view.saving;
    equal(app.written.length, 1);
  });

  test("Ctrl+S outside edit mode is left to Obsidian", async () => {
    const { view } = await editingPane();
    view.endEdit();
    equal(view.handleKey({ key: "s", ctrlKey: true }), false);
  });
});

report("save");
