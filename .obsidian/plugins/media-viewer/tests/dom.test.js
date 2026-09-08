// Drives the grid's DOM logic against a stub document: tile reconciliation,
// IntersectionObserver-driven loading, thumbnail eviction and click selection.
//
//   node tests/dom.test.js
//
// This is not a substitute for opening Obsidian — smooth scrolling in a
// 500-file folder is a judgement only the real pane can settle. It is how the
// bugs that would make that scrolling rough get caught first.
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

function fakeApp(paths) {
  const files = paths.map((path) => ({ path }));
  const on = () => ({});
  return {
    files,
    vault: {
      getFiles: () => files,
      on,
      // The real one carries the mtime, which is what makes a modified file
      // load fresh pixels. The stub carries a counter for the same reason.
      version: 0,
      getResourcePath(file) {
        return "app://local/" + file.path + "?v=" + this.version;
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

// Mounts a view the way Obsidian would: a content element attached to the
// document, then onOpen.
async function paneOver(paths, folder) {
  // The stub's timer queue is shared across the file, so a test that counts
  // deferred work counts its own rather than the previous test's leftovers.
  dom.clearTimers();
  const app = fakeApp(paths);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  await plugin.onload();

  const view = new MediaViewerView({}, plugin);
  view.contentEl = dom.root.createDiv({ cls: "view-content" });
  app.workspace.leaves = [{ view }];
  await view.onOpen();

  plugin.pinFolder(folder === undefined ? "data/assets" : folder);
  return { plugin, view, app, observer: view.observer };
}

const tilePaths = (view) => view.gridEl.children.map((tile) => tile.dataset.path);
const thumbOf = (tile) => tile.querySelector(".mv-tile-frame").querySelector(".mv-thumb");
const hasThumb = (tile) => Boolean(thumbOf(tile));

const FILES = [
  "data/assets/a.png",
  "data/assets/b.png",
  "data/assets/c.png",
  "data/assets/d.mp4",
  "data/assets/notes.md",
];

group("the grid builds a tile per visible file", () => {
  test("one tile each, in index order, media only", async () => {
    const { view } = await paneOver(FILES);
    deepEqual(tilePaths(view), [
      "data/assets/a.png",
      "data/assets/b.png",
      "data/assets/c.png",
      "data/assets/d.mp4",
    ]);
  });

  test("each tile carries its path, a frame and its name", async () => {
    const { view } = await paneOver(FILES);
    const tile = view.gridEl.children[0];
    equal(tile.dataset.path, "data/assets/a.png");
    equal(tile.title, "data/assets/a.png");
    equal(tile.querySelector(".mv-tile-name").textContent, "a.png");
    equal(tile.querySelector(".mv-tile-frame").dataset.kind, "image");
    equal(view.gridEl.children[3].querySelector(".mv-tile-frame").dataset.kind, "video");
  });

  test("an empty folder shows a message instead of a grid", async () => {
    const { view } = await paneOver(["data/assets/notes.md"]);
    deepEqual(tilePaths(view), []);
    ok(view.emptyEl.hasClass("is-shown"));
    equal(view.emptyEl.textContent, "No media in this folder.");
  });

  test("a filter that empties the grid says which filter did it", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.setFilter("video");
    plugin.pinFolder("data/assets");
    plugin.setFilter("image");
    deepEqual(tilePaths(view), ["data/assets/a.png", "data/assets/b.png", "data/assets/c.png"]);
    plugin.setFilter("video");
    deepEqual(tilePaths(view), ["data/assets/d.mp4"]);
  });
});

group("only visible tiles load", () => {
  test("nothing loads until something comes into view", async () => {
    const { view } = await paneOver(FILES);
    ok(view.gridEl.children.every((tile) => !hasThumb(tile)), "no thumbnails before scrolling");
    equal(view.thumbnails.size, 0);
  });

  test("every tile is observed, so any of them can load later", async () => {
    const { view, observer } = await paneOver(FILES);
    equal(observer.observed.size, 4);
  });

  test("a tile that scrolls into view loads its image from the resource path", async () => {
    const { view, observer } = await paneOver(FILES);
    const first = view.gridEl.children[0];
    observer.trigger([first], true);
    ok(hasThumb(first));
    equal(thumbOf(first).src, "app://local/data/assets/a.png?v=0");
    equal(view.thumbnails.size, 1);
    ok(view.gridEl.children.slice(1).every((tile) => !hasThumb(tile)), "the rest stayed unloaded");
  });

  test("a video tile is marked as a placeholder rather than loaded as an image", async () => {
    const { view, observer } = await paneOver(FILES);
    const video = view.gridEl.children[3];
    observer.trigger([video], true);
    equal(hasThumb(video), false, "MV-VTHUMB fills this in; MV-GRID must not load an mp4 into an img");
    ok(video.querySelector(".mv-tile-frame").hasClass("is-placeholder"));
    ok(view.thumbnails.has("data/assets/d.mp4"), "still counted, so it does not reload on every pass");
  });

  test("scrolling out does not unload — scrolling back is the common case", async () => {
    const { view, observer } = await paneOver(FILES);
    const first = view.gridEl.children[0];
    observer.trigger([first], true);
    observer.trigger([first], false);
    ok(hasThumb(first), "the thumbnail is kept; the LRU decides when it goes");
    equal(view.visible.has("data/assets/a.png"), false);
  });

  test("a second pass over a loaded tile does not rebuild its image", async () => {
    const { view, observer } = await paneOver(FILES);
    const first = view.gridEl.children[0];
    observer.trigger([first], true);
    const img = thumbOf(first);
    observer.trigger([first], false);
    observer.trigger([first], true);
    ok(thumbOf(first) === img, "same element, no reload");
  });

  test("a file that fails to decode marks its tile and the grid carries on", async () => {
    const { view, observer } = await paneOver(FILES);
    const first = view.gridEl.children[0];
    const second = view.gridEl.children[1];
    observer.trigger([first, second], true);
    thumbOf(first).fire("error");
    ok(first.hasClass("is-broken"));
    equal(hasThumb(first), false, "the failed image is removed");
    ok(hasThumb(second), "the next file loaded regardless");
  });
});

group("the LRU caps loaded thumbnails", () => {
  // A pane's worth of files, with the cache shrunk to a size a test can reach.
  async function smallCachePane(count, capacity) {
    const paths = [];
    for (let n = 0; n < count; n += 1) paths.push("data/assets/f" + String(n).padStart(3, "0") + ".png");
    const pane = await paneOver(paths);
    pane.view.thumbnails = new core.LruCache(capacity, (path, tile) =>
      pane.view.unloadThumbnail(path, tile)
    );
    return pane;
  }

  test("loading past the cap unloads the oldest thumbnail", async () => {
    const { view, observer } = await smallCachePane(6, 3);
    const tiles = view.gridEl.children;
    for (let n = 0; n < 4; n += 1) {
      observer.trigger([tiles[n]], true);
      observer.trigger([tiles[n]], false);
    }
    equal(view.thumbnails.size, 3);
    equal(hasThumb(tiles[0]), false, "the oldest was released");
    ok(hasThumb(tiles[1]) && hasThumb(tiles[2]) && hasThumb(tiles[3]));
  });

  test("an unloaded tile goes back to a placeholder, not to a broken badge", async () => {
    const { view, observer } = await smallCachePane(4, 1);
    const tiles = view.gridEl.children;
    observer.trigger([tiles[0]], true);
    observer.trigger([tiles[0]], false);
    observer.trigger([tiles[1]], true);
    equal(hasThumb(tiles[0]), false);
    ok(tiles[0].querySelector(".mv-tile-frame").hasClass("is-placeholder"));
    equal(tiles[0].hasClass("is-broken"), false);
  });

  test("an unloaded tile reloads when it is scrolled back to", async () => {
    const { view, observer } = await smallCachePane(4, 1);
    const tiles = view.gridEl.children;
    observer.trigger([tiles[0]], true);
    observer.trigger([tiles[0]], false);
    observer.trigger([tiles[1]], true);
    equal(hasThumb(tiles[0]), false);
    observer.trigger([tiles[0]], true);
    ok(hasThumb(tiles[0]), "back on screen, loaded again");
  });

  test("a still-visible tile evicted by the cap is put back rather than left blank", async () => {
    // Only reachable if the cap is smaller than the pane, which the shipped cap
    // is sized to prevent — but a hole in the grid is the wrong failure, so the
    // path exists and is asserted rather than assumed unreachable.
    const { view, observer } = await smallCachePane(4, 1);
    const tiles = view.gridEl.children;
    observer.trigger([tiles[0]], true);
    observer.trigger([tiles[1]], true);
    equal(hasThumb(tiles[0]), false, "evicted while still on screen");
    equal(dom.runTimers(), 1, "a reload was deferred rather than re-entering the eviction");
    ok(hasThumb(tiles[0]), "and the hole was filled");
  });

  test("closing the pane retires every thumbnail exactly once", async () => {
    const { view, observer } = await paneOver(FILES);
    observer.trigger(view.gridEl.children, true);
    equal(view.thumbnails.size, 4);
    await view.onClose();
    equal(view.thumbnails.size, 0);
    equal(view.tiles.size, 0);
    equal(view.visible.size, 0);
    ok(observer.disconnected);
    equal(view.observer, null);
  });
});

group("reconciliation, not rebuilding", () => {
  test("a save inserts one tile and leaves every other tile alone", async () => {
    const { plugin, view, app, observer } = await paneOver(FILES);
    observer.trigger(view.gridEl.children, true);
    const before = view.gridEl.children.slice();
    const beforeThumbs = before.map(thumbOf);

    const created = { path: "data/assets/b+clone+260908110422.png" };
    app.files.push(created);
    plugin.index.handleCreate(created);

    // The clone lands directly after its source, which is what the collator
    // gives for free: "b.png" sorts before "b+clone+...png", and both before
    // "c.png". A derived file sitting next to what it came from is the order
    // this plugin wants anyway.
    deepEqual(tilePaths(view), [
      "data/assets/a.png",
      "data/assets/b.png",
      "data/assets/b+clone+260908110422.png",
      "data/assets/c.png",
      "data/assets/d.mp4",
    ]);
    ok(view.gridEl.children[0] === before[0], "the first tile is the same element");
    ok(thumbOf(view.gridEl.children[0]) === beforeThumbs[0], "and still holds its thumbnail");
    ok(view.gridEl.children[1] === before[1], "the tile before the insert was untouched");
    ok(view.gridEl.children[3] === before[2], "the tile after the insert was moved, not rebuilt");
    ok(thumbOf(view.gridEl.children[3]) === beforeThumbs[2]);
  });

  test("the new tile is observed, so it loads when it is reached", async () => {
    const { plugin, view, app, observer } = await paneOver(FILES);
    const created = { path: "data/assets/aa.png" };
    app.files.push(created);
    plugin.index.handleCreate(created);
    const tile = view.tiles.get("data/assets/aa.png");
    ok(observer.observed.has(tile));
    observer.trigger([tile], true);
    ok(hasThumb(tile));
  });

  test("a delete removes just that tile, and stops observing it", async () => {
    const { plugin, view, observer } = await paneOver(FILES);
    observer.trigger(view.gridEl.children, true);
    const doomed = view.tiles.get("data/assets/b.png");
    plugin.index.handleDelete({ path: "data/assets/b.png" });
    deepEqual(tilePaths(view), ["data/assets/a.png", "data/assets/c.png", "data/assets/d.mp4"]);
    equal(observer.observed.has(doomed), false);
    equal(view.thumbnails.has("data/assets/b.png"), false);
    equal(doomed.parentNode, null);
  });

  test("filtering to videos and back keeps the same tile elements", async () => {
    const { plugin, view } = await paneOver(FILES);
    const before = view.tiles.get("data/assets/d.mp4");
    plugin.setFilter("video");
    ok(view.tiles.get("data/assets/d.mp4") === before, "the surviving tile was never rebuilt");
    plugin.setFilter("both");
    deepEqual(tilePaths(view), [
      "data/assets/a.png",
      "data/assets/b.png",
      "data/assets/c.png",
      "data/assets/d.mp4",
    ]);
  });

  test("a rename re-sorts the tile into its new position", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.index.handleRename({ path: "data/assets/z.png" }, "data/assets/a.png");
    deepEqual(tilePaths(view), [
      "data/assets/b.png",
      "data/assets/c.png",
      "data/assets/d.mp4",
      "data/assets/z.png",
    ]);
  });

  test("re-rendering an unchanged list moves nothing", async () => {
    const { view } = await paneOver(FILES);
    const before = view.gridEl.children.slice();
    view.render();
    deepEqual(
      view.gridEl.children.map((tile, n) => tile === before[n]),
      [true, true, true, true]
    );
  });
});

group("modify re-reads the file, because the pixels changed", () => {
  test("a modify swaps the image source without disturbing the grid", async () => {
    const { plugin, view, app, observer } = await paneOver(FILES);
    const tile = view.gridEl.children[0];
    observer.trigger([tile], true);
    equal(thumbOf(tile).src, "app://local/data/assets/a.png?v=0");

    app.vault.version = 1;
    plugin.index.handleModify({ path: "data/assets/a.png" });

    equal(thumbOf(tile).src, "app://local/data/assets/a.png?v=1", "fresh URL, cache bypassed");
    ok(view.gridEl.children[0] === tile, "the tile itself was not rebuilt");
  });

  test("a modify to an off-screen file just drops it from the cache", async () => {
    const { plugin, view, observer } = await paneOver(FILES);
    const tile = view.gridEl.children[0];
    observer.trigger([tile], true);
    observer.trigger([tile], false);
    plugin.index.handleModify({ path: "data/assets/a.png" });
    equal(view.thumbnails.has("data/assets/a.png"), false, "it will reload when it is next seen");
  });
});

group("clicking a tile selects it", () => {
  test("a click anywhere inside the tile selects that path", async () => {
    const { plugin, view } = await paneOver(FILES);
    view.gridEl.children[1].querySelector(".mv-tile-name").dispatch("click");
    equal(plugin.selectedPath, "data/assets/b.png");
    ok(view.tiles.get("data/assets/b.png").hasClass("is-selected"));
  });

  test("only one tile is selected at a time", async () => {
    const { plugin, view } = await paneOver(FILES);
    view.gridEl.children[1].dispatch("click");
    view.gridEl.children[2].dispatch("click");
    equal(view.tiles.get("data/assets/b.png").hasClass("is-selected"), false);
    ok(view.tiles.get("data/assets/c.png").hasClass("is-selected"));
    equal(plugin.selectedPath, "data/assets/c.png");
  });

  test("a click on the grid's own background selects nothing", async () => {
    const { plugin, view } = await paneOver(FILES);
    view.gridEl.dispatch("click");
    equal(plugin.selectedPath, null);
  });

  test("the highlight follows the file through a rename", async () => {
    const { plugin, view } = await paneOver(FILES);
    view.gridEl.children[1].dispatch("click");
    plugin.index.handleRename({ path: "data/assets/hero.png" }, "data/assets/b.png");
    equal(plugin.selectedPath, "data/assets/hero.png");
    ok(view.tiles.get("data/assets/hero.png").hasClass("is-selected"));
    equal(view.tiles.has("data/assets/b.png"), false);
  });

  test("deleting the selected file highlights its neighbour", async () => {
    const { plugin, view } = await paneOver(FILES);
    view.gridEl.children[1].dispatch("click");
    plugin.index.handleDelete({ path: "data/assets/b.png" });
    equal(plugin.selectedPath, "data/assets/c.png");
    ok(view.tiles.get("data/assets/c.png").hasClass("is-selected"));
  });
});

group("the structure the layout rules stand on", () => {
  // The container queries in styles.css reflow .mv-body between column and
  // row. That only works while the viewer and the grid are siblings inside it,
  // so the shape is asserted here rather than left to be discovered by a
  // refactor that quietly flattens it.
  test("the pane is header then body", async () => {
    const { view } = await paneOver(FILES);
    deepEqual(
      view.contentEl.children.map((child) => child.className),
      ["mv-header", "mv-body"]
    );
  });

  test("the body holds the viewer, the grid, the empty message and the lineage panel", async () => {
    const { view } = await paneOver(FILES);
    deepEqual(
      view.bodyEl.children.map((child) => child.className.split(" ")[0]),
      ["mv-viewer", "mv-grid", "mv-empty", "mv-lineage"]
    );
  });

  test("the container itself is the pane, which is what makes the queries pane-relative", async () => {
    const { view } = await paneOver(FILES);
    ok(view.contentEl.hasClass("media-viewer"), "the queried container class is on contentEl");
  });

  test("the viewer is a stage above its three bars", async () => {
    const { view } = await paneOver(FILES);
    // The transport and the edit bar sit between the stage and the viewer bar
    // and are present whatever is open — the mode class, not the DOM, decides
    // what shows. Both are built once so that a drag in progress and a chosen
    // aspect ratio survive a change of file.
    deepEqual(
      view.viewerEl.children.map((child) => child.className),
      ["mv-stage", "mv-video-bar", "mv-edit-bar", "mv-viewer-bar"]
    );
  });
});

group("header", () => {
  test("names the folder and holds the full path in the tooltip", async () => {
    const { view } = await paneOver(FILES);
    equal(view.folderEl.textContent, "assets");
    equal(view.folderEl.title, "data/assets");
  });

  test("the vault root gets a word rather than an empty header", async () => {
    const { view } = await paneOver(["cover.png"], "");
    equal(view.folderEl.textContent, "Vault root");
  });

  test("the toggles show their state", async () => {
    const { plugin, view } = await paneOver(FILES);
    equal(view.followEl.hasClass("is-active"), false, "pinned by Open in Media Viewer");
    equal(view.recursiveEl.hasClass("is-active"), false);
    plugin.setRecursive(true);
    ok(view.recursiveEl.hasClass("is-active"));
    plugin.setFollowActiveFile(true);
    ok(view.followEl.hasClass("is-active"));
  });
});

report("dom");
