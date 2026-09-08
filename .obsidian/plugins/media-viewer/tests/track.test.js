// Tests for what writes a lineage note and what does not. The rule the design
// states: notes are created when you act on a file, never when you look at one.
//
//   node tests/track.test.js
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

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

const MEDIA = ["data/assets/cover.png", "data/assets/photo.jpg", "data/assets/clip.mp4"];

/* A vault that can be written to, with a metadata cache that keeps up. Notes
   created through vault.create are parsed back out of the text they were
   written with, which is the closest a stub gets to Obsidian re-reading the
   file it just saved. */
function fakeApp() {
  const files = new Map();
  const cache = new Map();
  const on = () => ({});
  for (const path of MEDIA) {
    files.set(path, { path, basename: core.stemOf(path), extension: core.extensionOf(path) });
  }
  const app = {
    files,
    cache,
    vault: {
      getFiles: () => [...files.values()],
      getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === "md"),
      getAbstractFileByPath: (path) => files.get(path) || null,
      on,
      getResourcePath: (file) => "app://local/" + file.path,
      async read(file) {
        return file.body === undefined ? "" : file.body;
      },
      async modify(file, text) {
        file.body = text;
        cache.set(file.path, { frontmatter: parseFrontmatter(text) });
        return file;
      },
      async create(path, text) {
        const file = {
          path,
          basename: core.stemOf(path),
          extension: core.extensionOf(path),
          body: text,
        };
        files.set(path, file);
        cache.set(path, { frontmatter: parseFrontmatter(text) });
        return file;
      },
      async createFolder(path) {
        files.set(path, { path, basename: core.stemOf(path), extension: "" });
      },
      async createBinary(path, bytes) {
        const file = {
          path,
          basename: core.stemOf(path),
          extension: core.extensionOf(path),
          bytes,
        };
        files.set(path, file);
        return file;
      },
    },
    workspace: {
      on,
      activeFile: null,
      getActiveFile() {
        return this.activeFile;
      },
      getLeavesOfType() {
        return this.leaves || [];
      },
      onLayoutReady: (fn) => fn(),
    },
    metadataCache: {
      on,
      getFileCache: (file) => cache.get(file.path) || null,
      getFirstLinkpathDest(link) {
        if (files.has(link)) return files.get(link);
        for (const file of files.values()) if (core.baseNameOf(file.path) === link) return file;
        for (const file of files.values()) if (file.basename === link) return file;
        return null;
      },
    },
  };
  return app;
}

/* Enough YAML for what renderInstanceNote writes, which is a fixed and small
   grammar: scalars, one-line flow maps and one-line flow lists. */
function parseFrontmatter(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const front = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    front[key] = parseValue(raw);
  }
  return front;
}

function parseValue(raw) {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/\\"/g, '"');
  if (raw.startsWith("{")) {
    const map = {};
    const body = raw.slice(1, -1).trim();
    if (!body) return map;
    for (const pair of body.split(",")) {
      const at = pair.indexOf(":");
      map[pair.slice(0, at).trim()] = parseValue(pair.slice(at + 1).trim());
    }
    return map;
  }
  if (raw.startsWith("[")) {
    const body = raw.slice(1, -1).trim();
    return body ? body.split(",").map((item) => parseValue(item.trim())) : [];
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

async function pane(settings) {
  dom.clearTimers();
  Notice.messages.length = 0;
  decodeTo = { width: 1600, height: 1200 };
  const app = fakeApp();
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => settings || null;
  plugin.saveData = async () => {};
  await plugin.onload();
  const view = new MediaViewerView({}, plugin);
  view.contentEl = dom.root.createDiv({ cls: "view-content" });
  app.workspace.leaves = [{ view }];
  await view.onOpen();
  view.stageEl.clientWidth = 800;
  view.stageEl.clientHeight = 600;
  plugin.pinFolder("data/assets");
  return { plugin, view, app };
}

const notesIn = (app) => [...app.files.keys()].filter((path) => path.endsWith(".md")).sort();
const frontOf = (app, path) => (app.cache.get(path) || {}).frontmatter || {};

group("viewing writes nothing", () => {
  test("opening a folder writes no notes", async () => {
    const { app } = await pane();
    deepEqual(notesIn(app), []);
  });

  test("selecting, viewing and stepping write no notes", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/cover.png");
    plugin.selectSibling(1);
    view.handleKey({ key: "w" });
    view.handleKey({ key: "d" });
    deepEqual(notesIn(app), []);
  });

  test("opening an edit session writes no notes either", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.rotateEdit(90);
    deepEqual(notesIn(app), [], "the act that counts is the save, not the intention");
  });
});

group("a save writes two notes", () => {
  test("one crop produces a child note and a root note", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.editCanvasEl.clientWidth = 800;
    view.editCanvasEl.clientHeight = 600;
    view.overlay.set({ x: 100, y: 50, w: 200, h: 100 });
    view.applyCrop();
    const path = await view.saveEdit();

    const notes = notesIn(app);
    equal(notes.length, 2, notes.join(", "));
    ok(plugin.lineage.isTracked("data/assets/cover.png"), "the source is tracked");
    ok(plugin.lineage.isTracked(path), "and so is the crop");
  });

  test("the child records what it was cut from and how", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.editCanvasEl.clientWidth = 800;
    view.editCanvasEl.clientHeight = 600;
    view.overlay.set({ x: 100, y: 50, w: 200, h: 100 });
    view.applyCrop();
    view.rotateEdit(90);
    const path = await view.saveEdit();

    const record = plugin.lineage.recordFor(path);
    ok(record, "the crop has a record");
    equal(record.sourcePath, "data/assets/cover.png");
    const front = frontOf(app, record.notePath);
    equal(front.op, "crop");
    equal(front.status, "edited");
    deepEqual(front.transform, { rotate: 90, flipH: false, flipV: false });
    ok(front.crop, "and the rectangle it was cut from");
    equal(front.width, 200);
    equal(front.height, 400);
  });

  test("the root note declares no source and no crop", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.rotateEdit(90);
    await view.saveEdit();

    const record = plugin.lineage.recordFor("data/assets/cover.png");
    const front = frontOf(app, record.notePath);
    equal(front.source, undefined, "a root has no parent");
    equal(front.crop, undefined, "and was not cut from anything");
    equal(front.status, "reviewed", "you opened it and acted on it");
    equal(front.width, 1600);
    equal(front.height, 1200);
  });

  test("an op with no crop is recorded as a transform", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.flipEdit("h");
    const path = await view.saveEdit();
    equal(frontOf(app, plugin.lineage.recordFor(path).notePath).op, "transform");
  });

  test("a second crop of the same source does not rewrite its root note", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.rotateEdit(90);
    await view.saveEdit();
    const rootNote = plugin.lineage.recordFor("data/assets/cover.png").notePath;
    // Someone sets the status by hand between the two saves.
    const file = app.files.get(rootNote);
    await app.vault.modify(file, file.body.replace("status: reviewed", "status: archived"));
    plugin.lineage.handleMetadataChange(file, "", app.cache.get(rootNote));

    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.rotateEdit(180);
    await view.saveEdit();
    equal(frontOf(app, rootNote).status, "archived", "a file already dealt with is left alone");
  });

  test("a crop of a crop chains rather than pointing back at the root", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.rotateEdit(90);
    const first = await view.saveEdit();
    // The save opened a fresh session on the new file.
    view.rotateEdit(90);
    const second = await view.saveEdit();
    equal(plugin.lineage.parentOf(second), first);
    equal(plugin.lineage.parentOf(first), "data/assets/cover.png");
    deepEqual(plugin.lineage.childrenOf(first), [second]);
  });

  test("cropping a JPEG records a JPEG child", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/photo.jpg");
    await view.startEdit();
    view.rotateEdit(90);
    const path = await view.saveEdit();
    equal(core.extensionOf(path), "jpg");
    ok(plugin.lineage.isTracked(path));
  });

  test("with lineage writing off, the file is still saved and nothing is tracked", async () => {
    const { plugin, view, app } = await pane({ writeLineage: false });
    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.rotateEdit(90);
    const path = await view.saveEdit();
    ok(path, "the edit was saved");
    deepEqual(notesIn(app), []);
  });

  test("a note that cannot be written leaves the file, and says so", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/cover.png");
    await view.startEdit();
    view.rotateEdit(90);
    app.vault.create = async () => {
      throw new Error("read-only");
    };
    const path = await view.saveEdit();
    ok(path, "the binary survives — it is the user's work");
    ok(app.files.has(path));
    const message = Notice.messages.join(" | ");
    ok(message.includes("Repair lineage"), message);
  });
});

group("mark as reviewed", () => {
  test("it writes a bare root note on demand", async () => {
    const { plugin, app } = await pane();
    plugin.select("data/assets/cover.png");
    const file = await plugin.markReviewed();
    ok(file, "a note was written");
    const front = frontOf(app, file.path);
    equal(front.implements, "MediaInstance");
    equal(front.status, "reviewed");
    equal(front.source, undefined);
    equal(front.op, undefined, "nothing is claimed about how it was made");
    ok(plugin.lineage.isTracked("data/assets/cover.png"));
  });

  test("it exists so a file that needs no editing can leave the unreviewed list", async () => {
    const { plugin } = await pane();
    equal(plugin.lineage.isTracked("data/assets/clip.mp4"), false);
    await plugin.markReviewed("data/assets/clip.mp4");
    ok(plugin.lineage.isTracked("data/assets/clip.mp4"), "a video counts too");
  });

  test("a file that already has a note is left alone", async () => {
    const { plugin } = await pane();
    plugin.select("data/assets/cover.png");
    const first = await plugin.markReviewed();
    Notice.messages.length = 0;
    const second = await plugin.markReviewed();
    equal(first.path, second.path);
    ok(Notice.messages[0].includes("already has a lineage note"), Notice.messages[0]);
  });

  test("it falls back to the active file when the pane has no selection", async () => {
    const { plugin, app } = await pane();
    app.workspace.activeFile = { path: "data/assets/photo.jpg" };
    const file = await plugin.markReviewed();
    ok(file);
    ok(plugin.lineage.isTracked("data/assets/photo.jpg"));
  });

  test("with nothing to act on it says so rather than writing something", async () => {
    const { plugin, app } = await pane();
    equal(await plugin.markReviewed(), null);
    deepEqual(notesIn(app), []);
    ok(Notice.messages[0].includes("select a media file"), Notice.messages[0]);
  });

  test("a markdown note is not a media file", async () => {
    const { plugin } = await pane();
    equal(await plugin.markReviewed("data/notes/thoughts.md"), null);
    ok(Notice.messages[0].includes("not a media file"), Notice.messages[0]);
  });

  test("the command is registered under its own name", async () => {
    const { plugin } = await pane();
    const command = (plugin.commands || []).find((entry) => entry.id === "mark-reviewed");
    ok(command, "the command exists");
    equal(command.name, "Mark as reviewed");
  });
});

report("track");
