// Tests for the thumbnail cache and for selection, both keyed by path.
//
//   node tests/grid.test.js
//
// The DOM half of the grid — the IntersectionObserver, the tile reconciliation
// and the <img> loading — is verified by hand in Obsidian; what is here is the
// logic those parts stand on.
const MediaViewerPlugin = require("./load-plugin.js");
const { core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

const { LruCache } = core;

group("the thumbnail cache holds a bounded number of entries", () => {
  test("keeps what fits, in oldest-first order", () => {
    const cache = new LruCache(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    deepEqual(cache.keysOldestFirst(), ["a", "b", "c"]);
    equal(cache.size, 3);
  });

  test("evicts the oldest once the cap is passed", () => {
    const evicted = [];
    const cache = new LruCache(2, (key, value) => evicted.push([key, value]));
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    deepEqual(cache.keysOldestFirst(), ["b", "c"]);
    deepEqual(evicted, [["a", 1]]);
  });

  test("a hit is a use, so a read saves an entry from the next eviction", () => {
    const evicted = [];
    const cache = new LruCache(2, (key) => evicted.push(key));
    cache.set("a", 1);
    cache.set("b", 2);
    equal(cache.get("a"), 1, "reading a moves it to the young end");
    cache.set("c", 3);
    deepEqual(evicted, ["b"], "b was the oldest once a had been read");
    deepEqual(cache.keysOldestFirst(), ["a", "c"]);
  });

  test("without that, this would be a queue wearing an LRU's name", () => {
    // The same sequence with no read in the middle drops "a" instead.
    const evicted = [];
    const cache = new LruCache(2, (key) => evicted.push(key));
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    deepEqual(evicted, ["a"]);
  });

  test("a missing key reads as undefined without disturbing the order", () => {
    const cache = new LruCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    equal(cache.get("missing"), undefined);
    deepEqual(cache.keysOldestFirst(), ["a", "b"]);
  });

  test("re-setting a key refreshes it and retires the value it replaced", () => {
    const evicted = [];
    const cache = new LruCache(2, (key, value) => evicted.push([key, value]));
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 9);
    deepEqual(evicted, [["a", 1]], "the old value is as dead as an evicted one");
    deepEqual(cache.keysOldestFirst(), ["b", "a"]);
    equal(cache.size, 2);
  });

  test("re-setting a key to the same value retires nothing", () => {
    const evicted = [];
    const cache = new LruCache(2, (key) => evicted.push(key));
    cache.set("a", 1);
    cache.set("a", 1);
    deepEqual(evicted, []);
    equal(cache.size, 1);
  });

  test("delete retires the entry, and reports whether it was there", () => {
    const evicted = [];
    const cache = new LruCache(2, (key, value) => evicted.push([key, value]));
    cache.set("a", 1);
    equal(cache.delete("a"), true);
    equal(cache.delete("a"), false);
    deepEqual(evicted, [["a", 1]], "retired exactly once");
    equal(cache.size, 0);
  });

  test("clear retires everything, which is how a blob URL gets revoked once", () => {
    const evicted = [];
    const cache = new LruCache(4, (key) => evicted.push(key));
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    deepEqual(evicted, ["a", "b"]);
    equal(cache.size, 0);
    cache.clear();
    deepEqual(evicted, ["a", "b"], "a second clear retires nothing");
  });

  test("one thumbnail that fails to retire does not stop the rest", () => {
    const evicted = [];
    const cache = new LruCache(4, (key) => {
      if (key === "b") throw new Error("revoke failed");
      evicted.push(key);
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args[0]);
    try {
      cache.clear();
    } finally {
      console.error = original;
    }
    deepEqual(evicted, ["a", "c"]);
    equal(cache.size, 0);
    equal(errors.length, 1);
  });

  test("a nonsense capacity still holds at least one entry rather than none", () => {
    for (const capacity of [0, -5, NaN, undefined, "nonsense"]) {
      const cache = new LruCache(capacity);
      cache.set("a", 1);
      cache.set("b", 2);
      equal(cache.size, 1, String(capacity));
      deepEqual(cache.keysOldestFirst(), ["b"]);
    }
  });

  test("the shipped cap is comfortably above what any pane can show at once", () => {
    ok(core.THUMBNAIL_CACHE_SIZE >= 120, "cap is " + core.THUMBNAIL_CACHE_SIZE);
  });
});

/* Selection, against the same stubbed app the folder tests use. */

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
      getLeavesOfType: () => [],
      onLayoutReady: (fn) => fn(),
    },
    metadataCache: { on },
  };
}

async function pluginOver(paths) {
  const app = fakeApp(paths);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  await plugin.onload();
  plugin.pinFolder("data/assets");
  return { plugin, app };
}

const FILES = ["data/assets/a.png", "data/assets/b.png", "data/assets/c.mp4"];

group("selection is keyed by path, never by index", () => {
  test("selecting a file in the folder takes", async () => {
    const { plugin } = await pluginOver(FILES);
    equal(plugin.select("data/assets/b.png"), true);
    equal(plugin.selectedPath, "data/assets/b.png");
  });

  test("selecting the same file again is a no-op, so no needless re-render", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.select("data/assets/b.png");
    equal(plugin.select("data/assets/b.png"), false);
  });

  test("a file outside the folder cannot be selected", async () => {
    const { plugin } = await pluginOver(FILES);
    equal(plugin.select("other/x.png"), false);
    equal(plugin.selectedPath, null);
  });

  test("changing folder clears the selection", async () => {
    const { plugin } = await pluginOver(FILES.concat(["other/x.png"]));
    plugin.select("data/assets/b.png");
    plugin.pinFolder("other");
    equal(plugin.selectedPath, null);
  });
});

group("selection survives what happens around it", () => {
  test("a save inserting a new file leaves the selection alone", async () => {
    const { plugin, app } = await pluginOver(FILES);
    plugin.select("data/assets/b.png");
    const created = { path: "data/assets/b+clone+260908110422.png" };
    app.files.push(created);
    plugin.index.handleCreate(created);
    equal(plugin.selectedPath, "data/assets/b.png", "no reload, no lost selection");
    ok(plugin.index.has(created.path));
  });

  test("a modify leaves the selection alone", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.select("data/assets/b.png");
    plugin.index.handleModify({ path: "data/assets/b.png" });
    equal(plugin.selectedPath, "data/assets/b.png");
  });

  test("deleting the selected file moves selection to the next one", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.select("data/assets/b.png");
    plugin.index.handleDelete({ path: "data/assets/b.png" });
    equal(plugin.selectedPath, "data/assets/c.mp4");
  });

  test("deleting the last file moves selection back to the previous one", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.select("data/assets/c.mp4");
    plugin.index.handleDelete({ path: "data/assets/c.mp4" });
    equal(plugin.selectedPath, "data/assets/b.png");
  });

  test("deleting the only file leaves nothing selected", async () => {
    const { plugin } = await pluginOver(["data/assets/a.png"]);
    plugin.select("data/assets/a.png");
    plugin.index.handleDelete({ path: "data/assets/a.png" });
    equal(plugin.selectedPath, null);
  });

  test("deleting some other file leaves the selection alone", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.select("data/assets/b.png");
    plugin.index.handleDelete({ path: "data/assets/a.png" });
    equal(plugin.selectedPath, "data/assets/b.png");
  });

  test("renaming the selected file follows it — selection is the file, not the name", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.select("data/assets/b.png");
    plugin.index.handleRename({ path: "data/assets/hero.png" }, "data/assets/b.png");
    equal(plugin.selectedPath, "data/assets/hero.png");
  });

  test("moving the selected file out of the folder clears the selection", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.select("data/assets/b.png");
    plugin.index.handleRename({ path: "other/b.png" }, "data/assets/b.png");
    equal(plugin.selectedPath, null);
  });

  test("a recursion toggle that drops the selected file clears the selection", async () => {
    const { plugin } = await pluginOver(FILES.concat(["data/assets/sub/deep.png"]));
    plugin.setRecursive(true);
    plugin.select("data/assets/sub/deep.png");
    plugin.setRecursive(false);
    equal(plugin.selectedPath, null);
  });

  test("a recursion toggle that keeps the selected file keeps the selection", async () => {
    const { plugin } = await pluginOver(FILES.concat(["data/assets/sub/deep.png"]));
    plugin.select("data/assets/b.png");
    plugin.setRecursive(true);
    equal(plugin.selectedPath, "data/assets/b.png");
  });
});

group("the filter narrows the grid without disturbing the index", () => {
  test("images, videos and both", async () => {
    const { plugin } = await pluginOver(FILES);
    deepEqual(plugin.visiblePaths(), ["data/assets/a.png", "data/assets/b.png", "data/assets/c.mp4"]);
    plugin.setFilter("image");
    deepEqual(plugin.visiblePaths(), ["data/assets/a.png", "data/assets/b.png"]);
    plugin.setFilter("video");
    deepEqual(plugin.visiblePaths(), ["data/assets/c.mp4"]);
  });

  test("a filter that hides the selected file leaves the selection set", async () => {
    // The file is still in the folder and still in the index — it is simply
    // not on screen. Clearing here would lose the selection to a glance at
    // the videos and back.
    const { plugin } = await pluginOver(FILES);
    plugin.select("data/assets/c.mp4");
    plugin.setFilter("image");
    equal(plugin.selectedPath, "data/assets/c.mp4");
    plugin.setFilter("both");
    equal(plugin.selectedPath, "data/assets/c.mp4");
  });
});

report("grid");
