// Tests for folder selection: which file moves the pane, what the header
// calls a folder, and the plugin's own folder / filter / persistence logic.
//
//   node tests/folder.test.js
const MediaViewerPlugin = require("./load-plugin.js");
const { core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

group("which file moves the pane", () => {
  test("a media file offers its own folder", () => {
    equal(core.folderForActiveFile("data/assets/cover.png"), "data/assets");
    equal(core.folderForActiveFile("data/assets/clip.mp4"), "data/assets");
  });

  test("a media file at the vault root offers the root", () => {
    equal(core.folderForActiveFile("cover.png"), "");
  });

  test("a markdown note does not move the pane", () => {
    equal(core.folderForActiveFile("data/notes/thoughts.md"), null);
  });

  test("a sidecar does not move the pane, even beside media", () => {
    equal(core.folderForActiveFile("data/assets/cover.instance.md"), null);
  });

  test("nothing open moves nothing", () => {
    equal(core.folderForActiveFile(null), null);
    equal(core.folderForActiveFile(undefined), null);
    equal(core.folderForActiveFile(""), null);
  });
});

group("folder labels", () => {
  test("shows the folder's own name, not its path", () => {
    equal(core.folderLabelFor("data/assets"), "assets");
  });

  test("the vault root gets a word, since it has no name", () => {
    equal(core.folderLabelFor(""), "Vault root");
    equal(core.folderLabelFor("/"), "Vault root");
  });

  test("no folder is no label", () => {
    equal(core.folderLabelFor(null), "");
    equal(core.folderLabelFor(undefined), "");
  });
});

/* The plugin itself, against stubbed Obsidian services. Only the folder,
 * filter and persistence logic is exercised — nothing here touches the DOM. */

function fakeApp(paths) {
  const files = paths.map((path) => ({ path }));
  const handlers = {};
  const on = (event, handler) => {
    (handlers[event] = handlers[event] || []).push(handler);
    return { event };
  };
  return {
    handlers,
    activeFile: null,
    vault: { getFiles: () => files, on },
    workspace: {
      on,
      getActiveFile() {
        return this.activeFile;
      },
      getLeavesOfType: () => [],
      onLayoutReady: (fn) => fn(),
    },
    metadataCache: { on },
  };
}

async function pluginOver(paths, saved) {
  const app = fakeApp(paths);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.saved = saved ? Object.assign({}, saved) : null;
  plugin.loadData = async () => plugin.saved;
  plugin.saveData = async (data) => {
    plugin.saved = JSON.parse(JSON.stringify(data));
  };
  await plugin.onload();
  return { plugin, app };
}

const FILES = [
  "data/assets/cover.png",
  "data/assets/clip.mp4",
  "data/assets/notes.md",
  "data/assets/sub/deep.png",
  "other/elsewhere.png",
];

group("defaults", () => {
  test("starts with no folder, following on, and all media shown", async () => {
    const { plugin } = await pluginOver(FILES);
    equal(plugin.index.folder, null);
    equal(plugin.settings.followActiveFile, true);
    equal(plugin.settings.filter, "both");
    equal(plugin.settings.recursive, false);
    deepEqual(plugin.visiblePaths(), []);
  });
});

group("following the active file", () => {
  test("opening a PNG shows its folder", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.followActiveFile({ path: "data/assets/cover.png" });
    equal(plugin.index.folder, "data/assets");
    deepEqual(plugin.visiblePaths(), ["data/assets/clip.mp4", "data/assets/cover.png"]);
  });

  test("opening a note leaves the folder where it was", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.followActiveFile({ path: "data/assets/cover.png" });
    plugin.followActiveFile({ path: "data/assets/notes.md" });
    equal(plugin.index.folder, "data/assets");
  });

  test("with following off, opening a PNG changes nothing", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.setFollowActiveFile(false);
    plugin.followActiveFile({ path: "data/assets/cover.png" });
    equal(plugin.index.folder, null);
  });

  test("turning following back on catches up with the active file", async () => {
    const { plugin, app } = await pluginOver(FILES);
    plugin.setFollowActiveFile(false);
    app.workspace.activeFile = { path: "other/elsewhere.png" };
    plugin.setFollowActiveFile(true);
    equal(plugin.index.folder, "other");
  });
});

group("Open in Media Viewer", () => {
  test("pins the pane, so the next click does not undo the choice", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.pinFolder("other");
    equal(plugin.index.folder, "other");
    equal(plugin.settings.followActiveFile, false, "pinning turns following off");
    plugin.followActiveFile({ path: "data/assets/cover.png" });
    equal(plugin.index.folder, "other", "the pinned folder survives");
  });

  test("the vault root is a folder like any other", async () => {
    const { plugin } = await pluginOver(["cover.png", "data/assets/deep.png"]);
    plugin.pinFolder("");
    equal(plugin.index.folder, "");
    deepEqual(plugin.visiblePaths(), ["cover.png"]);
  });
});

group("the filter is a view concern, not a rescan", () => {
  test("narrows to images or videos without touching the index", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.pinFolder("data/assets");
    const scanned = plugin.index.paths;
    plugin.setFilter("image");
    deepEqual(plugin.visiblePaths(), ["data/assets/cover.png"]);
    plugin.setFilter("video");
    deepEqual(plugin.visiblePaths(), ["data/assets/clip.mp4"]);
    ok(plugin.index.paths === scanned, "the index array was never rebuilt");
  });

  test("an unrecognised filter falls back to showing everything", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.pinFolder("data/assets");
    plugin.setFilter("nonsense");
    equal(plugin.settings.filter, "both");
    deepEqual(plugin.visiblePaths(), ["data/assets/clip.mp4", "data/assets/cover.png"]);
  });
});

group("recursive scanning", () => {
  test("the toggle picks up subfolders and puts them back", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.pinFolder("data/assets");
    plugin.setRecursive(true);
    deepEqual(plugin.visiblePaths(), [
      "data/assets/clip.mp4",
      "data/assets/cover.png",
      "data/assets/sub/deep.png",
    ]);
    plugin.setRecursive(false);
    deepEqual(plugin.visiblePaths(), ["data/assets/clip.mp4", "data/assets/cover.png"]);
  });
});

group("persistence", () => {
  test("the folder, filter, recursion and pin are all written", async () => {
    const { plugin } = await pluginOver(FILES);
    plugin.pinFolder("data/assets");
    plugin.setFilter("video");
    plugin.setRecursive(true);
    await new Promise((resolve) => setImmediate(resolve));
    deepEqual(plugin.saved, {
      lastFolder: "data/assets",
      recursive: true,
      filter: "video",
      followActiveFile: false,
    });
  });

  test("a restart restores the last folder and its settings", async () => {
    const { plugin } = await pluginOver(FILES, {
      lastFolder: "data/assets",
      recursive: true,
      filter: "image",
      followActiveFile: false,
    });
    equal(plugin.index.folder, "data/assets");
    equal(plugin.index.recursive, true);
    deepEqual(plugin.visiblePaths(), ["data/assets/cover.png", "data/assets/sub/deep.png"]);
  });

  test("saved data missing a key falls back to the default rather than undefined", async () => {
    const { plugin } = await pluginOver(FILES, { lastFolder: "other" });
    equal(plugin.settings.filter, "both");
    equal(plugin.settings.recursive, false);
    equal(plugin.settings.followActiveFile, true);
    equal(plugin.index.folder, "other");
  });

  test("the vault root persists as itself, not as no folder", async () => {
    const { plugin } = await pluginOver(["cover.png"], {
      lastFolder: "",
      recursive: false,
      filter: "both",
      followActiveFile: false,
    });
    equal(plugin.index.folder, "");
    deepEqual(plugin.visiblePaths(), ["cover.png"]);
  });
});

group("event registration", () => {
  test("listens for the four vault events plus file-open and file-menu", async () => {
    const { app } = await pluginOver(FILES);
    deepEqual(Object.keys(app.handlers).sort(), [
      "create",
      "delete",
      "file-menu",
      "file-open",
      "modify",
      "rename",
    ]);
  });
});

report("folder");
