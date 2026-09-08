// Tests for rename handling. The rule the design states: untracked files cost
// nothing, links are rewritten only when Obsidian is not already doing it, and
// children are never renamed.
//
//   node tests/rename.test.js
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

const MEDIA = ["data/assets/cover.png", "data/assets/cover+clone+1.png", "data/assets/loose.png"];

const CHAIN = {
  "data/media/cover.md": {
    media: "[[data/assets/cover.png]]",
    status: "reviewed",
    labels: ["hero"],
    width: 4000,
    height: 3000,
  },
  "data/media/cover+clone+1.md": {
    media: "[[data/assets/cover+clone+1.png]]",
    source: "[[data/assets/cover.png]]",
    op: "crop",
    crop: { x: 120, y: 40, w: 800, h: 600 },
    transform: { rotate: 90, flipH: false, flipV: false },
    width: 800,
    height: 600,
    status: "edited",
  },
};

function fakeApp(notes, config) {
  const files = new Map();
  const cache = new Map();
  const writes = [];
  const on = () => ({});
  for (const path of MEDIA) {
    files.set(path, { path, basename: core.stemOf(path), extension: core.extensionOf(path) });
  }
  for (const [path, front] of Object.entries(notes || {})) {
    files.set(path, { path, basename: core.stemOf(path), extension: "md", body: "" });
    cache.set(path, { frontmatter: Object.assign({ implements: "MediaInstance" }, front) });
  }
  return {
    files,
    cache,
    writes,
    vault: {
      config: Object.assign({ alwaysUpdateLinks: true }, config || {}),
      getConfig(key) {
        return this.config[key];
      },
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
        writes.push({ path: file.path, text });
        return file;
      },
      async create(path, text) {
        const file = { path, basename: core.stemOf(path), extension: "md", body: text };
        files.set(path, file);
        writes.push({ path, text });
        return file;
      },
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
        for (const file of files.values()) if (file.basename === link) return file;
        return null;
      },
    },
  };
}

async function pluginOver(notes, config) {
  dom.clearTimers();
  Notice.messages.length = 0;
  const app = fakeApp(notes === undefined ? CHAIN : notes, config);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  await plugin.onload();
  plugin.pinFolder("data/assets");
  return { plugin, app };
}

// What Obsidian does to the vault on a rename, minus the link rewriting.
function renameFile(app, oldPath, newPath) {
  const file = app.files.get(oldPath);
  app.files.delete(oldPath);
  file.path = newPath;
  file.basename = core.stemOf(newPath);
  app.files.set(newPath, file);
  return file;
}

group("untracked files cost nothing", () => {
  test("renaming a file with no note does no work at all", async () => {
    const { plugin, app } = await pluginOver();
    const file = renameFile(app, "data/assets/loose.png", "data/assets/renamed.png");
    equal(await plugin.handleLineageRename(file, "data/assets/loose.png"), false);
    equal(app.writes.length, 0);
  });

  test("the handling is a map lookup, not a scan", async () => {
    // Proved by taking the scan away: the vault cannot be listed, and an
    // untracked rename still returns.
    const { plugin, app } = await pluginOver();
    app.vault.getMarkdownFiles = () => {
      throw new Error("this rename must not scan the vault");
    };
    const file = renameFile(app, "data/assets/loose.png", "data/assets/renamed.png");
    equal(await plugin.handleLineageRename(file, "data/assets/loose.png"), false);
  });
});

group("with Obsidian's link updating on", () => {
  test("the plugin writes nothing", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: true });
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    equal(await plugin.handleLineageRename(file, "data/assets/cover.png"), false);
    equal(app.writes.length, 0, "the platform has already done it");
  });

  test("but the maps follow the file, so children still resolve", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: true });
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    await plugin.handleLineageRename(file, "data/assets/cover.png");
    equal(plugin.lineage.byMedia.get("data/assets/hero.png"), "data/media/cover.md");
    deepEqual(plugin.lineage.childrenOf("data/assets/hero.png"), ["data/assets/cover+clone+1.png"]);
  });
});

group("with Obsidian's link updating off", () => {
  test("media: is rewritten on the file's own note", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: false });
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    const rewritten = await plugin.handleLineageRename(file, "data/assets/cover.png");
    ok(rewritten.includes("data/media/cover.md"), rewritten.join(", "));
    const text = app.files.get("data/media/cover.md").body;
    ok(text.includes('media: "[[data/assets/hero.png]]"'), text);
  });

  test("source: is rewritten on every child", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: false });
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    await plugin.handleLineageRename(file, "data/assets/cover.png");
    const text = app.files.get("data/media/cover+clone+1.md").body;
    ok(text.includes('source: "[[data/assets/hero.png]]"'), text);
  });

  test("a rewrite keeps everything it was not asked to change", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: false });
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    await plugin.handleLineageRename(file, "data/assets/cover.png");
    const text = app.files.get("data/media/cover+clone+1.md").body;
    ok(text.includes("crop: { x: 120, y: 40, w: 800, h: 600 }"), text);
    ok(text.includes("transform: { rotate: 90, flipH: false, flipV: false }"), text);
    ok(text.includes("status: edited"), text);
    ok(text.includes("op: crop"), text);
  });

  test("the file's own note keeps its labels and status", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: false });
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    await plugin.handleLineageRename(file, "data/assets/cover.png");
    const text = app.files.get("data/media/cover.md").body;
    ok(text.includes("labels: [hero]"), text);
    ok(text.includes("status: reviewed"), text);
    ok(text.includes("width: 4000"), text);
  });

  test("prose below the marker survives the cascade", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: false });
    app.files.get("data/media/cover.md").body =
      "---\nimplements: MediaInstance\n---\n\n" + core.NOTES_MARKER + "\n\nShot from the roof.\n";
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    await plugin.handleLineageRename(file, "data/assets/cover.png");
    ok(app.files.get("data/media/cover.md").body.includes("Shot from the roof."));
  });

  test("children are never renamed", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: false });
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    await plugin.handleLineageRename(file, "data/assets/cover.png");
    ok(app.files.has("data/assets/cover+clone+1.png"), "the crop keeps its name; only links change");
    equal(app.files.has("data/assets/hero+clone+1.png"), false);
  });

  test("a rename that touches nothing tracked still writes nothing", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: false });
    const file = renameFile(app, "data/assets/loose.png", "data/assets/other.png");
    equal(await plugin.handleLineageRename(file, "data/assets/loose.png"), false);
    equal(app.writes.length, 0);
  });

  test("a note that will not write is reported, and the rest still go", async () => {
    const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks: false });
    const realModify = app.vault.modify.bind(app.vault);
    app.vault.modify = async (file, text) => {
      if (file.path === "data/media/cover.md") throw new Error("read-only");
      return realModify(file, text);
    };
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    const rewritten = await plugin.handleLineageRename(file, "data/assets/cover.png");
    deepEqual(rewritten, ["data/media/cover+clone+1.md"], "the child still went through");
    ok(Notice.messages.join(" ").includes("Repair lineage"), Notice.messages.join(" | "));
  });

  test("a missing config reads as off, because that is the platform default", async () => {
    const { plugin, app } = await pluginOver(CHAIN, {});
    delete app.vault.config.alwaysUpdateLinks;
    equal(plugin.linkUpdatingEnabled(), false);
    const file = renameFile(app, "data/assets/cover.png", "data/assets/hero.png");
    const rewritten = await plugin.handleLineageRename(file, "data/assets/cover.png");
    ok(rewritten.length, "so the work is done rather than silently skipped");
  });

  test("a build with no getConfig reads as off too", async () => {
    const { plugin, app } = await pluginOver(CHAIN, {});
    delete app.vault.getConfig;
    equal(plugin.linkUpdatingEnabled(), false);
  });
});

group("renaming the note itself", () => {
  test("a note moved by hand keeps working, whatever the setting", async () => {
    for (const alwaysUpdateLinks of [true, false]) {
      const { plugin, app } = await pluginOver(CHAIN, { alwaysUpdateLinks });
      const file = renameFile(app, "data/media/cover.md", "MyVault/archive/somewhere else.md");
      await plugin.handleLineageRename(file, "data/media/cover.md");
      equal(
        plugin.lineage.byMedia.get("data/assets/cover.png"),
        "MyVault/archive/somewhere else.md",
        "setting " + alwaysUpdateLinks
      );
      equal(app.writes.length, 0, "and nothing was written to say so");
    }
  });
});

report("rename");
