/* A performance harness for MV-PERF. Run with:
 *
 *   node tests/bench.js
 *
 * What this is and is not.
 *
 * It measures this plugin's own work at 20, 100, 500 and 2000 files: the
 * folder scan, the tile reconciliation a render does, the lineage build, and
 * chain resolution. Those are the parts that scale with folder size and the
 * parts a change here can make quadratic by accident, so they are worth a
 * number that can be compared against the last one.
 *
 * It is NOT the manual pass the design asks for. Every cost this harness
 * cannot see is a real cost: image decode, layout, paint, scroll smoothness,
 * IntersectionObserver's own bookkeeping, and a drive that is not this one.
 * A stub document appends to an array where a browser reflows. So a scan of
 * 500 files reading as sub-millisecond here means the arithmetic is cheap, not
 * that the pane feels fast — that judgement only the real pane can settle, and
 * the checklist in the design doc is where it belongs.
 */
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, LineageStore, MetadataResolver, core } = require("./load-plugin.js");

const SIZES = [20, 100, 500, 2000];
// Roughly a pane's worth of tiles at a normal window size. What the
// first-visible measurement is actually about.
const VISIBLE_TILES = 24;

document.createElement = ((base) => (tag) => {
  const element = base(tag);
  if (tag !== "img") return element;
  Object.defineProperty(element, "src", {
    set(value) {
      element.assignedSrc = value;
      // Fired synchronously: this harness measures the plugin's work, and a
      // decode it did not do is not that.
      element.naturalWidth = 1600;
      element.naturalHeight = 1200;
      element.fire("load");
    },
    get() {
      return element.assignedSrc || "";
    },
    configurable: true,
  });
  return element;
})((tag) => new StubElement(tag));

function mediaPaths(count) {
  const paths = [];
  const width = String(count).length;
  for (let n = 0; n < count; n += 1) {
    const stem = "shot" + String(n).padStart(width, "0");
    paths.push("data/assets/" + stem + (n % 7 === 0 ? ".mp4" : ".png"));
  }
  return paths;
}

function fakeApp(paths, notes) {
  const files = new Map();
  const cache = new Map();
  const on = () => ({});
  const root = { path: "data/assets", children: [] };
  for (const path of paths) {
    const file = { path, basename: core.stemOf(path), extension: core.extensionOf(path) };
    files.set(path, file);
    root.children.push(file);
  }
  files.set("data/assets", root);
  for (const [path, front] of Object.entries(notes || {})) {
    files.set(path, { path, basename: core.stemOf(path), extension: "md" });
    cache.set(path, { frontmatter: front });
  }
  return {
    files,
    vault: {
      getConfig: () => true,
      getFiles: () => [...files.values()].filter((file) => file.extension),
      getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === "md"),
      getAbstractFileByPath: (path) => files.get(path) || null,
      on,
      getResourcePath: (file) => "app://local/" + file.path,
      async read() {
        return "";
      },
      async modify() {},
      async create() {},
      async createFolder() {},
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

// Milliseconds, to a tenth. Repeated so that a sub-millisecond operation
// reports something other than zero.
function time(repeats, body) {
  const started = process.hrtime.bigint();
  for (let n = 0; n < repeats; n += 1) body();
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return Math.round((elapsed / repeats) * 100) / 100;
}

async function measure(count) {
  const paths = mediaPaths(count);
  const app = fakeApp(paths);
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

  const repeats = count > 500 ? 5 : 20;

  const scan = time(repeats, () => {
    plugin.index.setFolder("data/assets", false);
  });

  plugin.index.setFolder("data/assets", false);
  const visible = plugin.visiblePaths();

  // A cold render: every tile built and inserted.
  const firstRender = time(repeats, () => {
    view.tiles.clear();
    view.gridEl.empty();
    view.syncTiles(visible);
  });

  // A warm one: the same list again, which should touch nothing.
  const idleRender = time(repeats, () => view.syncTiles(visible));

  // One file arrives, as a save does. This is the path that must not be a
  // rebuild, and the number that says whether it is.
  const inserted = "data/assets/zzz+clone+260908110422.png";
  const insertOne = time(repeats, () => {
    plugin.index.handleCreate({ path: inserted });
    plugin.index.handleDelete({ path: inserted });
  });

  // The first screenful of thumbnails, from the observer reporting them to the
  // last one settling. No real decode, so this is the plugin's share only.
  view.tiles.clear();
  view.gridEl.empty();
  view.render();
  const batch = view.gridEl.children.slice(0, VISIBLE_TILES);
  const firstThumbs = time(1, () => view.observer.trigger(batch, true));

  // Lineage: one note per file, in a chain ten deep at the head of the list.
  const notes = {};
  for (let n = 0; n < count; n += 1) {
    const media = paths[n];
    const front = { implements: "MediaInstance", media: "[[" + media + "]]", status: "reviewed" };
    if (n > 0 && n < 10) front.source = "[[" + paths[n - 1] + "]]";
    notes["data/media/note" + n + ".md"] = front;
  }
  const lineageApp = fakeApp(paths, notes);
  const store = new LineageStore(lineageApp, {});
  const build = time(repeats, () => store.build());
  store.build();
  const resolver = new MetadataResolver(store);
  const resolveDeep = time(repeats * 10, () => resolver.resolveAll(paths[9]));

  return { count, scan, firstRender, idleRender, insertOne, firstThumbs, build, resolveDeep };
}

async function main() {
  const rows = [];
  for (const count of SIZES) rows.push(await measure(count));

  const columns = [
    ["Files", (row) => String(row.count)],
    ["Scan", (row) => row.scan],
    ["First render", (row) => row.firstRender],
    ["Idle render", (row) => row.idleRender],
    ["Insert one", (row) => row.insertOne],
    ["First 24 thumbs", (row) => row.firstThumbs],
    ["Lineage build", (row) => row.build],
    ["Resolve 10-deep", (row) => row.resolveDeep],
  ];

  console.log("");
  console.log("Media Viewer — plugin-side timings, milliseconds, " + process.version);
  console.log("Not the manual pass: no decode, no layout, no paint, no disk.");
  console.log("");
  console.log("| " + columns.map(([name]) => name).join(" | ") + " |");
  console.log("| " + columns.map(() => "---").join(" | ") + " |");
  for (const row of rows) {
    console.log("| " + columns.map(([, read]) => read(row)).join(" | ") + " |");
  }
  console.log("");
}

main();
