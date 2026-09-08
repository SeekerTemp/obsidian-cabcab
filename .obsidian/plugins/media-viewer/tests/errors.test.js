// One row per line of the design's error-handling table, plus the rule
// underneath all of them: one bad file must never take down the grid.
//
//   node tests/errors.test.js
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core, guarded } = require("./load-plugin.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

let decodeTo = { width: 1600, height: 1200, fail: false };

document.createElement = ((base) => (tag) => {
  const element = base(tag);
  if (tag !== "img") return element;
  Object.defineProperty(element, "src", {
    set(value) {
      element.assignedSrc = value;
      element.naturalWidth = decodeTo.width;
      element.naturalHeight = decodeTo.height;
      setImmediate(() => element.fire(decodeTo.fail ? "error" : "load"));
    },
    get() {
      return element.assignedSrc || "";
    },
    configurable: true,
  });
  return element;
})((tag) => new StubElement(tag));

const MEDIA = [
  "data/assets/a.png",
  "data/assets/broken.png",
  "data/assets/c.png",
  "data/assets/clip.mkv",
];

function fakeApp(notes) {
  const files = new Map();
  const cache = new Map();
  const on = () => ({});
  for (const path of MEDIA) {
    files.set(path, { path, basename: core.stemOf(path), extension: core.extensionOf(path) });
  }
  for (const [path, front] of Object.entries(notes || {})) {
    files.set(path, { path, basename: core.stemOf(path), extension: "md", body: "" });
    cache.set(path, { frontmatter: front });
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

async function pane(notes) {
  dom.clearTimers();
  Notice.messages.length = 0;
  decodeTo = { width: 1600, height: 1200, fail: false };
  const app = fakeApp(notes);
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
  return { plugin, view, app };
}

// Runs a body with console.error captured, so a test can assert that a failure
// was reported rather than swallowed.
async function quietly(body) {
  const errors = [];
  const real = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.error = real;
  }
  return errors;
}

const tiles = (view) => view.gridEl.children;
const stageMessage = (view) => {
  const el = view.stageEl.querySelector(".mv-stage-message");
  return el ? el.textContent : null;
};

group("the guard itself", () => {
  test("it reports and returns the fallback rather than throwing", async () => {
    const errors = await quietly(async () => {
      const value = guarded("doing something", "a/thing.png", () => {
        throw new Error("nope");
      }, "fallback");
      equal(value, "fallback");
    });
    equal(errors.length, 1);
    ok(errors[0].includes("doing something failed for a/thing.png"), errors[0]);
  });

  test("a success passes straight through", () => {
    equal(guarded("x", "y", () => 7, 0), 7);
  });

  test("it names an unnamed subject rather than saying nothing", async () => {
    const errors = await quietly(async () =>
      guarded("doing something", null, () => {
        throw new Error("nope");
      })
    );
    ok(errors[0].includes("an unnamed item"), errors[0]);
  });
});

group("a corrupt image", () => {
  test("marks its thumbnail and the grid carries on", async () => {
    const { view } = await pane();
    view.observer.trigger([tiles(view)[0], tiles(view)[1]], true);
    const thumb = tiles(view)[1].querySelector(".mv-thumb");
    thumb.fire("error");
    ok(tiles(view)[1].hasClass("is-broken"));
    ok(tiles(view)[0].querySelector(".mv-thumb"), "the file beside it is unaffected");
  });

  test("says so in the viewer, and browsing continues", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/broken.png");
    view.stageEl.querySelector(".mv-image").fire("error");
    ok(view.stageEl.hasClass("is-broken"));
    ok(stageMessage(view).includes("could not be decoded"), stageMessage(view));
    plugin.selectSibling(1);
    equal(plugin.selectedPath, "data/assets/c.png", "and the next file still opens");
  });
});

group("an unsupported video", () => {
  test("names the container it could not play", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/clip.mkv");
    view.videoEl.fire("error");
    ok(stageMessage(view).includes("MKV"), stageMessage(view));
    ok(view.stageEl.hasClass("is-broken"));
  });
});

group("a file over the decode budget", () => {
  test("is refused with its dimensions, and nothing is loaded", async () => {
    const { plugin, view } = await pane();
    decodeTo = { width: 12000, height: 9000, fail: false };
    plugin.select("data/assets/a.png");
    equal(await view.startEdit(), false);
    equal(view.session, null);
    ok(Notice.messages[0].includes("108"), Notice.messages[0]);
  });
});

group("a save that fails", () => {
  test("keeps the edit session open", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/a.png");
    await view.startEdit();
    view.rotateEdit(90);
    app.vault.createBinary = async () => {
      throw new Error("disk full");
    };
    await quietly(async () => equal(await view.saveEdit(), null));
    ok(view.session, "the work is not thrown away because the disk was full");
    equal(view.session.state.rotate, 90);
    ok(Notice.messages.join(" ").includes("still open"));
  });
});

group("a binary saved whose note was not", () => {
  test("leaves the file, and the pane offers the repair", async () => {
    const { plugin, view, app } = await pane();
    plugin.select("data/assets/a.png");
    await view.startEdit();
    view.rotateEdit(90);
    app.vault.create = async () => {
      throw new Error("read-only");
    };
    let path;
    await quietly(async () => {
      path = await view.saveEdit();
    });
    ok(app.files.has(path), "the file survives");
    equal(plugin.lineage.isTracked(path), false, "and the pane knows it is untracked");
    const actions = view.lineageBodyEl.querySelectorAll(".mv-lineage-action").map((el) => el.textContent);
    ok(actions.includes("Repair lineage"), actions.join(", "));
  });
});

group("a broken chain", () => {
  test("a missing source stops resolution and is shown", async () => {
    const { plugin, view } = await pane({
      "data/media/a.md": {
        implements: "MediaInstance",
        media: "[[data/assets/a.png]]",
        source: "[[gone.png]]",
      },
    });
    plugin.select("data/assets/a.png");
    const problem = view.lineageBodyEl.querySelector(".mv-lineage-problem");
    ok(problem, "the break is on screen");
    ok(problem.textContent.includes("gone.png"), problem.textContent);
  });

  test("a cycle aborts, and is both logged and shown", async () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      const { plugin, view } = await pane({
        "data/media/a.md": {
          implements: "MediaInstance",
          media: "[[data/assets/a.png]]",
          source: "[[data/assets/c.png]]",
        },
        "data/media/c.md": {
          implements: "MediaInstance",
          media: "[[data/assets/c.png]]",
          source: "[[data/assets/a.png]]",
        },
      });
      plugin.select("data/assets/a.png");
      ok(view.lineageBodyEl.querySelector(".mv-lineage-problem"), "shown");
      ok(warnings.some((line) => line.includes("loops back")), warnings.join(" | "));
    } finally {
      console.warn = warn;
    }
  });
});

group("a file deleted underneath the viewer", () => {
  test("selection moves to a neighbour", async () => {
    const { plugin, app } = await pane();
    plugin.select("data/assets/broken.png");
    plugin.index.handleDelete(app.files.get("data/assets/broken.png"));
    equal(plugin.selectedPath, "data/assets/c.png");
  });

  test("deleting the last file falls back to the one before it", async () => {
    const { plugin, app } = await pane();
    plugin.select("data/assets/clip.mkv");
    plugin.index.handleDelete(app.files.get("data/assets/clip.mkv"));
    equal(plugin.selectedPath, "data/assets/c.png");
  });
});

group("one bad item never takes down the loop", () => {
  test("a tile that will not build leaves the rest of the grid standing", async () => {
    const { view } = await pane();
    const realCreate = view.createTile.bind(view);
    view.createTile = (path) => {
      if (path === "data/assets/broken.png") throw new Error("no");
      return realCreate(path);
    };
    view.tiles.clear();
    view.gridEl.empty();
    const errors = await quietly(async () => view.render());
    const paths = tiles(view).map((tile) => tile.dataset.path);
    deepEqual(paths, ["data/assets/a.png", "data/assets/c.png", "data/assets/clip.mkv"]);
    ok(errors.some((line) => line.includes("broken.png")), errors.join(" | "));
  });

  test("a note that will not read leaves the rest of the map built", async () => {
    const { plugin, app } = await pane({
      "data/media/a.md": { implements: "MediaInstance", media: "[[data/assets/a.png]]" },
      "data/media/bad.md": { implements: "MediaInstance", media: "[[data/assets/c.png]]" },
    });
    const realGet = app.metadataCache.getFileCache;
    app.metadataCache.getFileCache = (file) => {
      if (file.path === "data/media/bad.md") throw new Error("cache is confused");
      return realGet(file);
    };
    const errors = await quietly(async () => plugin.lineage.build());
    ok(plugin.lineage.isTracked("data/assets/a.png"), "the good note still landed");
    ok(errors.some((line) => line.includes("bad.md")), errors.join(" | "));
  });

  test("a folder that will not list leaves an empty index rather than a dead pane", async () => {
    const { plugin, app } = await pane();
    app.vault.getFiles = () => {
      throw new Error("gone");
    };
    plugin.index.folderObject = () => {
      throw new Error("gone");
    };
    const errors = await quietly(async () => plugin.index.scan());
    deepEqual(plugin.index.paths, []);
    ok(errors.length, "and it said so");
  });

  test("a panel that throws does not stop the pane refreshing", async () => {
    const { plugin, view } = await pane();
    view.renderLineageUnguarded = () => {
      throw new Error("nope");
    };
    const errors = await quietly(async () => plugin.select("data/assets/a.png"));
    equal(plugin.selectedPath, "data/assets/a.png");
    ok(errors.length, errors.join(" | "));
  });
});

report("errors");
