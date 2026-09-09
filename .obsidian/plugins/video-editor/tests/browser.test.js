/* The browser — what the pane shows when nothing is open.
 *
 * The first real session with this pane got as far as "no video open" and
 * stopped, because the only ways in were a right-click somewhere else or the
 * command palette. An empty state that tells you to go and use a different
 * pane is a dead end, so the empty state is now the list of videos and
 * double-clicking one starts editing it.
 */
const dom = require("./stub-dom.js").installDom();
const { VideoEditorView, PosterCache, core } = require("./load-plugin.js");
const { createFakeApp } = require("./fake-vault.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const HOUR = 3600;

const VAULT = [
  "assets/walkthrough-checkout.mp4",
  "assets/walkthrough-login.mkv",
  "assets/cover.png",
  "assets/notes.md",
  "recordings/2026/demo.mov",
  "recordings/2026/retro.mp4",
  "Archive/old-take.mp4",
  "top-level.mp4",
];

function makeView(options) {
  const settings = options || {};
  const vault = createFakeApp({ basePath: "/vault" });
  for (const path of settings.files === undefined ? VAULT : settings.files) vault.addFile(path);
  const stills = [];
  const plugin = {
    settings: Object.assign({}, core.DEFAULT_SETTINGS, { filmstrip: false }, settings.settings || {}),
    runner: {
      available: settings.available === undefined ? true : settings.available,
      version: settings.version || "N-126479-g08cd8df29d-20260908",
      async check() {
        return this.available;
      },
      async probe() {
        return { duration: HOUR, width: 1920, height: 1080, fps: 30 };
      },
      async still(path, time, height) {
        stills.push({ path, time, height });
        return Buffer.from([0xff, 0xd8, 0xff]);
      },
      killAll() {},
      bundledRoot: () => "/vault/.obsidian/plugins/video-editor",
    },
    exporter: { absolute: (path) => "/vault/" + path },
  };
  const view = new VideoEditorView({ app: vault.app, updateHeader() {} }, plugin);
  view.app = vault.app;
  return { view, vault, plugin, stills };
}

async function openView(options) {
  const made = makeView(options);
  await made.view.onOpen();
  return made;
}

const textOf = (element) => {
  if (!element) return "";
  return (element.text || "") + (element.children || []).map(textOf).join(" ");
};

const tileNames = (view) => view.tilesEl.children.map((tile) => tile.dataset.path);
const folderLabels = (view) =>
  view.foldersEl.children.map((row) => (row.children[0] ? row.children[0].text : ""));

/* ---- the listing, as pure functions ------------------------------------ */

group("folders", () => {
  test("only folders that actually hold a video", () => {
    // This is a list of places there is something to edit, not a directory
    // tree — a folder of PNGs is not an answer to "what can I cut".
    const folders = core.videoFoldersOf(VAULT).map((entry) => entry.folder);
    deepEqual(folders, ["Archive", "", "assets", "recordings/2026"].sort((a, b) =>
      String(a).toLowerCase() < String(b).toLowerCase() ? -1 : 1
    ));
  });

  test("counts what is in each", () => {
    const counts = {};
    for (const entry of core.videoFoldersOf(VAULT)) counts[entry.folder] = entry.count;
    equal(counts["assets"], 2);
    equal(counts["recordings/2026"], 2);
    equal(counts[""], 1, "the vault root counts as a folder");
  });

  test("sorted case-insensitively", () => {
    // Byte order puts every capitalised folder above every lowercase one,
    // which reads as broken to everyone except a byte comparator.
    const labels = core.videoFoldersOf(["Zebra/a.mp4", "apple/b.mp4"]).map((entry) => entry.folder);
    deepEqual(labels, ["apple", "Zebra"]);
  });

  test("the vault root gets a name a person can click", () => {
    equal(core.folderLabelFor(""), "(vault root)");
    equal(core.folderLabelFor("assets/"), "assets");
  });
});

group("entries", () => {
  test("videos only, whatever else is in the folder", () => {
    const paths = core.browserEntriesFor(VAULT, { folder: "assets" }).map((entry) => entry.path);
    deepEqual(paths, ["assets/walkthrough-checkout.mp4", "assets/walkthrough-login.mkv"]);
  });

  test("a null folder means all of them", () => {
    equal(core.browserEntriesFor(VAULT, { folder: null }).length, 6);
  });

  test("grouped by folder, then by name", () => {
    const entries = core.browserEntriesFor(VAULT, {});
    deepEqual(entries.map((entry) => entry.folder), [
      "",
      "Archive",
      "assets",
      "assets",
      "recordings/2026",
      "recordings/2026",
    ]);
    deepEqual(
      entries.filter((entry) => entry.folder === "recordings/2026").map((entry) => entry.name),
      ["demo.mov", "retro.mp4"]
    );
  });

  test("a search matches the name", () => {
    const paths = core.browserEntriesFor(VAULT, { query: "walkthrough" }).map((entry) => entry.path);
    equal(paths.length, 2);
  });

  test("and the path, so typing a folder name narrows to it", () => {
    const paths = core.browserEntriesFor(VAULT, { query: "recordings" }).map((entry) => entry.path);
    deepEqual(paths, ["recordings/2026/demo.mov", "recordings/2026/retro.mp4"]);
  });

  test("the search ignores case and surrounding space", () => {
    equal(core.browserEntriesFor(VAULT, { query: "  RETRO " }).length, 1);
  });

  test("an empty vault is an empty list, not a crash", () => {
    deepEqual(core.browserEntriesFor([], {}), []);
    deepEqual(core.browserEntriesFor(null, {}), []);
  });
});

group("the version badge", () => {
  test("a git describe is cut down to something that fits", () => {
    // Pasted whole, ffmpeg's own version string pushed everything else off the
    // header row — which is exactly what it did the first time this pane was
    // opened for real.
    equal(core.shortVersion("N-126479-g08cd8df29d-20260908"), "N-126479");
  });

  test("a release version is left as it is", () => {
    equal(core.shortVersion("7.1"), "7.1");
    equal(core.shortVersion("6.1.1"), "6.1.1");
  });

  test("anything else is truncated rather than trusted", () => {
    ok(core.shortVersion("averyveryverylongthing").length <= 15);
    equal(core.shortVersion(""), "");
  });
});

/* ---- the pane ----------------------------------------------------------- */

group("opening the pane", () => {
  test("shows the browser, not an editor with nothing in it", async () => {
    const { view } = await openView();
    equal(view.browsing, true);
    ok(view.browserEl.hasClass("is-hidden") === false, "the browser is showing");
    ok(view.bodyEl.hasClass("is-hidden"), "and the editor is not");
  });

  test("lists every video in the vault", async () => {
    const { view } = await openView();
    equal(view.tilesEl.children.length, 6);
  });

  test("offers every folder that holds one, plus all of them", async () => {
    const { view } = await openView();
    deepEqual(folderLabels(view), [
      "All videos",
      "(vault root)",
      "Archive",
      "assets",
      "recordings/2026",
    ]);
  });

  test("counts them where a person can see the count", async () => {
    const { view } = await openView();
    ok(textOf(view.browserCountEl).includes("6"));
  });

  test("an empty vault says what to do rather than showing nothing", async () => {
    const { view } = await openView({ files: ["notes.md", "cover.png"] });
    equal(view.tilesEl.children.length, 1, "one message, not a tile");
    ok(textOf(view.tilesEl).includes("no videos in this vault"));
  });

  test("there is no stray video box in the empty state", async () => {
    // The first screenshot of this pane had a black rectangle floating beside
    // the message, which was the <video> element with nothing in it.
    const { view } = await openView();
    ok(view.bodyEl.hasClass("is-hidden"), "the whole editor is out of the way");
  });
});

group("narrowing", () => {
  test("clicking a folder filters to it", async () => {
    const { view } = await openView();
    const assets = view.foldersEl.children[3];
    assets.fire("click", {});
    deepEqual(tileNames(view), ["assets/walkthrough-checkout.mp4", "assets/walkthrough-login.mkv"]);
    equal(view.folder, "assets");
  });

  test("the chosen folder is marked as chosen", async () => {
    const { view } = await openView();
    view.foldersEl.children[3].fire("click", {});
    ok(view.foldersEl.children[3].hasClass("is-selected"));
    ok(view.foldersEl.children[0].hasClass("is-selected") === false);
  });

  test("All videos gets you back", async () => {
    const { view } = await openView();
    view.foldersEl.children[3].fire("click", {});
    view.foldersEl.children[0].fire("click", {});
    equal(view.folder, null);
    equal(view.tilesEl.children.length, 6);
  });

  test("typing filters, and says how many of how many", async () => {
    const { view } = await openView();
    view.searchEl.value = "walk";
    view.searchEl.fire("input", {});
    equal(view.tilesEl.children.length, 2);
    ok(textOf(view.browserCountEl).includes("2 of 6"));
  });

  test("a search that matches nothing says so", async () => {
    const { view } = await openView();
    view.searchEl.value = "nothing here";
    view.searchEl.fire("input", {});
    ok(textOf(view.tilesEl).includes("Nothing matches"));
  });

  test("the folder shows on a tile only when the list spans several", async () => {
    const { view } = await openView();
    ok(textOf(view.tilesEl.children[0]).includes("(vault root)"), "shown when browsing everything");
    view.foldersEl.children[3].fire("click", {});
    equal(textOf(view.tilesEl.children[0]).includes("assets"), false, "redundant inside one folder");
  });
});

group("opening a video", () => {
  test("double-click is what starts editing", async () => {
    const { view } = await openView();
    const tile = view.tilesEl.children[0];
    await tile.fire("dblclick", {});
    // fire() is synchronous and openPath is not, so let the open settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(view.browsing, false);
    equal(view.file.path, "top-level.mp4");
    ok(view.bodyEl.hasClass("is-hidden") === false, "the editor is showing");
    ok(view.browserEl.hasClass("is-hidden"), "and the browser is not");
  });

  test("a single click only selects, so a mis-click does not open a file", async () => {
    const { view } = await openView();
    view.tilesEl.children[0].fire("click", {});
    equal(view.browsing, true, "still browsing");
    ok(view.tilesEl.children[0].hasClass("is-selected"));
  });

  test("selecting a second tile deselects the first", async () => {
    const { view } = await openView();
    view.tilesEl.children[0].fire("click", {});
    view.tilesEl.children[1].fire("click", {});
    equal(view.tilesEl.children[0].hasClass("is-selected"), false);
    ok(view.tilesEl.children[1].hasClass("is-selected"));
  });

  test("a file that has gone says so instead of opening nothing", async () => {
    Notice.messages.length = 0;
    const { view, vault } = await openView();
    vault.files.delete("top-level.mp4");
    await view.openPath("top-level.mp4");
    ok(Notice.messages.some((message) => message.includes("no longer in the vault")));
    equal(view.browsing, true);
  });

  test("Browse gets you back to the list", async () => {
    const { view, vault } = await openView();
    await view.openFile(vault.files.get("assets/walkthrough-checkout.mp4"));
    equal(view.browsing, false);
    view.browseButton.fire("click", {});
    equal(view.browsing, true);
    equal(view.tilesEl.children.length, 6, "and the list is still there");
  });

  test("the Browse button is hidden while the list is what you are looking at", async () => {
    // A button that returns you to where you already are is a puzzle.
    const { view, vault } = await openView();
    ok(view.browseButton.hasClass("is-hidden"));
    await view.openFile(vault.files.get("assets/walkthrough-checkout.mp4"));
    equal(view.browseButton.hasClass("is-hidden"), false);
  });
});

group("posters", () => {
  /* Its own cache and its own fake ffmpeg, rather than the view's.
   *
   * The browser starts filling posters the moment it draws tiles, so a test
   * that measured the view's cache would be measuring that background pass as
   * well as its own. */
  function makeCache() {
    const asked = [];
    const runner = {
      async still(path, time, height) {
        asked.push({ path, time, height });
        return Buffer.from([0xff, 0xd8, 0xff]);
      },
    };
    return { cache: new PosterCache(runner, { height: 72 }), asked };
  }

  const entries = core.browserEntriesFor(["a/one.mp4", "a/two.mp4"], {});
  const absolute = (path) => "/vault/" + path;

  test("one still per video, taken past a fade from black", async () => {
    const { cache, asked } = makeCache();
    await cache.fill(entries, absolute, () => {});
    equal(asked.length, 2);
    ok(asked[0].time > 0, "not frame zero, which on a screen recording is often black");
    equal(asked[0].path, "/vault/a/one.mp4", "ffmpeg gets a real path, not a vault one");
    cache.clear();
  });

  test("cached, so switching folders does not re-seek every file", async () => {
    const { cache, asked } = makeCache();
    await cache.fill(entries, absolute, () => {});
    await cache.fill(entries, absolute, () => {});
    equal(asked.length, 2, "the second pass asked ffmpeg for nothing");
    cache.clear();
  });

  test("a cached poster is still handed to the tile that wants it", async () => {
    const { cache } = makeCache();
    await cache.fill(entries, absolute, () => {});
    const seen = [];
    await cache.fill(entries, absolute, (path, url) => seen.push(url));
    equal(seen.length, 2, "cached does not mean invisible");
    cache.clear();
  });

  test("released on clear, rather than leaking one per video", async () => {
    const { cache } = makeCache();
    const before = dom.liveUrls.size;
    await cache.fill(entries, absolute, () => {});
    equal(dom.liveUrls.size, before + 2);
    cache.clear();
    equal(dom.liveUrls.size, before);
  });

  test("a newer request abandons the one it replaced", async () => {
    // Typing in the search box starts a pass per keystroke; without the token
    // they would interleave and draw each other's stills.
    const { cache, asked } = makeCache();
    const first = cache.fill(entries, absolute, () => {});
    const second = cache.fill(entries, absolute, () => {});
    await Promise.all([first, second]);
    ok(asked.length <= 4, "the abandoned pass did not run to completion twice over");
    cache.clear();
  });

  test("the view skips them entirely when there is no ffmpeg to ask", async () => {
    const { view, stills } = await openView({ available: false });
    equal(stills.length, 0, "and the tiles are still drawn");
    equal(view.tilesEl.children.length, 6);
  });
});

report("video-editor browser");
