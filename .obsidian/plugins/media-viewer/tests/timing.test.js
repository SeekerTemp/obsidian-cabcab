// Tests for the debug timings. What is asserted is that each operation reports
// with an `ms=` line and that the setting actually gates them — the numbers
// themselves are a matter for the real pane.
//
//   node tests/timing.test.js
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

const MEDIA = ["data/assets/a.png", "data/assets/b.png", "data/assets/c.png"];

function fakeApp() {
  const files = new Map();
  const cache = new Map();
  const on = () => ({});
  for (const path of MEDIA) {
    files.set(path, { path, basename: core.stemOf(path), extension: core.extensionOf(path) });
  }
  return {
    files,
    cache,
    vault: {
      getConfig: () => true,
      getFiles: () => [...files.values()],
      getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === "md"),
      getAbstractFileByPath: (path) => files.get(path) || null,
      on,
      getResourcePath: (file) => "app://local/" + file.path,
      async read(file) {
        return file.body || "";
      },
      async modify(file, text) {
        file.body = text;
      },
      async create(path, text) {
        const file = { path, basename: core.stemOf(path), extension: "md", body: text };
        files.set(path, file);
        cache.set(path, { frontmatter: { implements: "MediaInstance", media: "[[" + path + "]]" } });
        return file;
      },
      async createFolder() {},
      async createBinary(path) {
        const file = { path, basename: core.stemOf(path), extension: core.extensionOf(path) };
        files.set(path, file);
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
    metadataCache: {
      on,
      getFileCache: (file) => cache.get(file.path) || null,
      getFirstLinkpathDest(link) {
        if (files.has(link)) return files.get(link);
        for (const file of files.values()) if (core.baseNameOf(file.path) === link) return file;
        return null;
      },
    },
  };
}

// Captures console.log for the duration of one action.
async function logged(body) {
  const lines = [];
  const real = console.log;
  console.log = (message) => lines.push(String(message));
  try {
    await body();
  } finally {
    console.log = real;
  }
  return lines;
}

async function pane(debugLogging) {
  dom.clearTimers();
  Notice.messages.length = 0;
  decodeTo = { width: 1600, height: 1200 };
  const app = fakeApp();
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => ({ debugLogging: debugLogging !== false });
  plugin.saveData = async () => {};
  await plugin.onload();
  const view = new MediaViewerView({}, plugin);
  view.contentEl = dom.root.createDiv({ cls: "view-content" });
  app.workspace.leaves = [{ view }];
  await view.onOpen();
  view.stageEl.clientWidth = 800;
  view.stageEl.clientHeight = 600;
  return { plugin, view, app };
}

const timings = (lines) =>
  lines
    .filter((line) => line.includes("ms="))
    .map((line) => line.replace(/^Media Viewer: /, "").split(" ")[0]);

group("the setting gates everything", () => {
  test("with debug logging off, nothing is logged", async () => {
    const { plugin } = await pane(false);
    const lines = await logged(async () => {
      plugin.pinFolder("data/assets");
      plugin.logTiming("anything", "somewhere", Date.now());
      plugin.debug("a message");
    });
    deepEqual(lines, []);
  });

  test("with it on, a timing carries the operation, the ms and the subject", async () => {
    const { plugin } = await pane(true);
    const lines = await logged(async () => {
      plugin.logTiming("encode", "data/assets/a.png", Date.now() - 42, "bytes=100");
    });
    equal(lines.length, 1);
    ok(lines[0].startsWith("Media Viewer: encode ms="), lines[0]);
    ok(lines[0].includes("data/assets/a.png"), lines[0]);
    ok(lines[0].includes("bytes=100"), lines[0]);
  });

  test("the elapsed number is a duration, not a clock reading", async () => {
    const { plugin } = await pane(true);
    const lines = await logged(async () => {
      plugin.logTiming("scan", "data/assets", Date.now() - 1234);
    });
    const ms = Number(lines[0].match(/ms=(\d+)/)[1]);
    ok(ms >= 1200 && ms < 3000, lines[0]);
  });
});

group("the operations that historically hurt", () => {
  test("a folder scan reports, with how many files it found", async () => {
    const { plugin } = await pane(true);
    const lines = await logged(async () => plugin.pinFolder("data/assets"));
    ok(timings(lines).includes("scan"), lines.join(" | "));
    ok(lines.some((line) => line.includes("files=3")), lines.join(" | "));
  });

  test("toggling recursion reports its own scan", async () => {
    const { plugin } = await pane(true);
    plugin.pinFolder("data/assets");
    const lines = await logged(async () => plugin.setRecursive(true));
    ok(timings(lines).includes("scan"), lines.join(" | "));
  });

  test("the first visible thumbnails report once the batch has loaded", async () => {
    const { plugin, view } = await pane(true);
    plugin.pinFolder("data/assets");
    const tiles = view.gridEl.children;
    const lines = await logged(async () => {
      view.observer.trigger([tiles[0], tiles[1]], true);
      // Each <img> fires load a tick later, as a real decode does.
      await new Promise((resolve) => setImmediate(resolve));
    });
    ok(timings(lines).includes("first-visible-thumbs"), lines.join(" | "));
  });

  test("it reports once, not once per scroll", async () => {
    const { plugin, view } = await pane(true);
    plugin.pinFolder("data/assets");
    const tiles = view.gridEl.children;
    const lines = await logged(async () => {
      view.observer.trigger([tiles[0]], true);
      await new Promise((resolve) => setImmediate(resolve));
      view.observer.trigger([tiles[1], tiles[2]], true);
      await new Promise((resolve) => setImmediate(resolve));
    });
    equal(timings(lines).filter((name) => name === "first-visible-thumbs").length, 1);
  });

  test("a decode reports when a session opens", async () => {
    const { plugin, view } = await pane(true);
    plugin.pinFolder("data/assets");
    plugin.select("data/assets/a.png");
    const lines = await logged(async () => view.startEdit());
    ok(timings(lines).includes("decode"), lines.join(" | "));
  });

  test("an encode and a save report on the way out", async () => {
    const { plugin, view } = await pane(true);
    plugin.pinFolder("data/assets");
    plugin.select("data/assets/a.png");
    await view.startEdit();
    view.rotateEdit(90);
    const lines = await logged(async () => view.saveEdit());
    const names = timings(lines);
    ok(names.includes("encode"), lines.join(" | "));
    ok(names.includes("save"), lines.join(" | "));
    ok(names.includes("lineage-write"), lines.join(" | "));
  });

  test("resolution reports when the panel draws a tracked file", async () => {
    const { plugin, view } = await pane(true);
    plugin.pinFolder("data/assets");
    plugin.select("data/assets/a.png");
    await plugin.markReviewed();
    const lines = await logged(async () => view.renderLineage());
    ok(timings(lines).includes("resolution"), lines.join(" | "));
  });

  test("building the lineage maps reports how many notes it found", async () => {
    const { plugin } = await pane(true);
    await plugin.markReviewed("data/assets/a.png");
    const lines = await logged(async () => {
      const started = Date.now();
      const found = plugin.lineage.build();
      plugin.logTiming("lineage-build", found + " notes", started);
    });
    ok(lines[0].includes("1 notes"), lines[0]);
  });
});

group("rename cascades name every link", () => {
  test("each rewritten link is logged, whatever the debug setting", async () => {
    // The widest blast radius in the plugin and the least visible failure
    // mode, so this one is not behind a setting.
    const { plugin, app } = await pane(false);
    app.vault.getConfig = () => false;
    await plugin.markReviewed("data/assets/a.png");
    await plugin.lineage.write("data/assets/b.png", {
      source: core.wikilinkFor("data/assets/a.png"),
      op: "crop",
    });
    const file = app.files.get("data/assets/a.png");
    app.files.delete("data/assets/a.png");
    file.path = "data/assets/hero.png";
    app.files.set(file.path, file);

    const lines = await logged(async () => plugin.handleLineageRename(file, "data/assets/a.png"));
    const rewrites = lines.filter((line) => line.includes("rewrote"));
    equal(rewrites.length, 2, lines.join(" | "));
    ok(rewrites.some((line) => line.includes("media:")), rewrites.join(" | "));
    ok(rewrites.some((line) => line.includes("source:")), rewrites.join(" | "));
    ok(rewrites.every((line) => line.includes("data/assets/hero.png")), rewrites.join(" | "));
  });

  test("the cascade itself is timed, behind the setting", async () => {
    const { plugin, app } = await pane(true);
    app.vault.getConfig = () => false;
    await plugin.markReviewed("data/assets/a.png");
    const file = app.files.get("data/assets/a.png");
    app.files.delete("data/assets/a.png");
    file.path = "data/assets/hero.png";
    app.files.set(file.path, file);
    const lines = await logged(async () => plugin.handleLineageRename(file, "data/assets/a.png"));
    ok(timings(lines).includes("rename-cascade"), lines.join(" | "));
    ok(lines.some((line) => line.includes("links=1")), lines.join(" | "));
  });

  test("a rename that writes nothing says why, behind the setting", async () => {
    const { plugin, app } = await pane(true);
    app.vault.getConfig = () => true;
    await plugin.markReviewed("data/assets/a.png");
    const file = app.files.get("data/assets/a.png");
    app.files.delete("data/assets/a.png");
    file.path = "data/assets/hero.png";
    app.files.set(file.path, file);
    const lines = await logged(async () => plugin.handleLineageRename(file, "data/assets/a.png"));
    ok(lines.some((line) => line.includes("link updating on")), lines.join(" | "));
  });
});

report("timing");
