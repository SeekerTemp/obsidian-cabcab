// Tests for Repair lineage and the vault-wide break report. The line between
// them is the design's rule: repair writes, the report only reads, and a
// dangling source: is reported and never silently fixed.
//
//   node tests/repair.test.js
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { core } = require("./load-plugin.js");
const { Notice, Modal } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

const MEDIA = [
  "data/assets/root.png",
  "data/assets/child.png",
  "data/assets/orphan.png",
  "data/assets/loose.png",
];

function fakeApp(notes) {
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
    opened: [],
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
        writes.push(file.path);
      },
      async create(path, text) {
        const file = { path, basename: core.stemOf(path), extension: "md", body: text };
        files.set(path, file);
        cache.set(path, { frontmatter: parseFront(text) });
        writes.push(path);
        return file;
      },
      async createFolder() {},
    },
    workspace: {
      on,
      activeFile: null,
      getActiveFile() {
        return this.activeFile;
      },
      getLeaf() {
        const owner = this;
        return {
          openFile(file) {
            owner.openedFile = file;
          },
        };
      },
      getLeavesOfType() {
        return [];
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

function parseFront(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const front = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const raw = line.slice(at + 1).trim();
    front[line.slice(0, at).trim()] =
      raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return front;
}

const HEALTHY = {
  "data/media/root.md": { media: "[[data/assets/root.png]]", status: "reviewed" },
  "data/media/child.md": {
    media: "[[data/assets/child.png]]",
    source: "[[data/assets/root.png]]",
    op: "crop",
  },
};

async function pluginOver(notes) {
  dom.clearTimers();
  Notice.messages.length = 0;
  Modal.opened.length = 0;
  const app = fakeApp(notes === undefined ? HEALTHY : notes);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  await plugin.onload();
  plugin.pinFolder("data/assets");
  return { plugin, app };
}

const lastNotice = () => Notice.messages[Notice.messages.length - 1] || "";

group("repairing one file", () => {
  test("a missing note is written back", async () => {
    // The verify from the handoff: delete a note, repair, and it is restored.
    const { plugin, app } = await pluginOver(HEALTHY);
    app.files.delete("data/media/root.md");
    app.cache.delete("data/media/root.md");
    plugin.lineage.build();
    equal(plugin.lineage.isTracked("data/assets/root.png"), false);

    const file = await plugin.repairLineage("data/assets/root.png");
    ok(file, "a note was written");
    ok(plugin.lineage.isTracked("data/assets/root.png"));
  });

  test("it says the provenance could not be recovered, rather than guessing", async () => {
    // The only other place that information could come from is the filename,
    // which is exactly the mechanism this design retired.
    const { plugin } = await pluginOver(HEALTHY);
    await plugin.repairLineage("data/assets/orphan.png");
    ok(lastNotice().includes("could not be recovered"), lastNotice());
    equal(plugin.lineage.recordFor("data/assets/orphan.png").sourceLink, null);
  });

  test("a whole chain is left alone and said to be whole", async () => {
    const { plugin, app } = await pluginOver(HEALTHY);
    const before = app.writes.length;
    await plugin.repairLineage("data/assets/child.png");
    equal(app.writes.length, before, "nothing was written");
    ok(lastNotice().includes("chain is whole"), lastNotice());
  });

  test("a dangling source is reported and never silently fixed", async () => {
    const { plugin, app } = await pluginOver({
      "data/media/child.md": {
        media: "[[data/assets/child.png]]",
        source: "[[gone.png]]",
      },
    });
    const before = app.writes.length;
    equal(await plugin.repairLineage("data/assets/child.png"), null);
    equal(app.writes.length, before, "the file it names may be arriving from a sync");
    ok(lastNotice().includes("gone.png"), lastNotice());
    ok(lastNotice().includes("Nothing was changed"), lastNotice());
    equal(plugin.lineage.recordFor("data/assets/child.png").sourceLink, "gone.png", "still there");
  });

  test("it falls back to the selection, then to the active file", async () => {
    const { plugin, app } = await pluginOver(HEALTHY);
    plugin.select("data/assets/loose.png");
    await plugin.repairLineage();
    ok(plugin.lineage.isTracked("data/assets/loose.png"));

    plugin.selectedPath = null;
    app.workspace.activeFile = { path: "data/assets/orphan.png" };
    await plugin.repairLineage();
    ok(plugin.lineage.isTracked("data/assets/orphan.png"));
  });

  test("with nothing to act on it says so", async () => {
    const { plugin, app } = await pluginOver(HEALTHY);
    const before = app.writes.length;
    equal(await plugin.repairLineage(), null);
    equal(app.writes.length, before);
    ok(lastNotice().includes("select a media file"), lastNotice());
  });

  test("a markdown file is not something to repair", async () => {
    const { plugin } = await pluginOver(HEALTHY);
    equal(await plugin.repairLineage("data/media/root.md"), null);
    ok(lastNotice().includes("not a media file"), lastNotice());
  });

  test("a note that will not write reports rather than claiming success", async () => {
    const { plugin, app } = await pluginOver(HEALTHY);
    app.vault.create = async () => {
      throw new Error("read-only");
    };
    equal(await plugin.repairLineage("data/assets/loose.png"), null);
    ok(lastNotice().includes("could not write"), lastNotice());
  });
});

group("the break report", () => {
  test("a healthy vault reports nothing", async () => {
    const { plugin } = await pluginOver(HEALTHY);
    deepEqual(plugin.lineageBreakReport(), []);
    plugin.showLineageBreaks();
    ok(lastNotice().includes("no lineage breaks"), lastNotice());
    equal(Modal.opened.length, 0, "and opens no window to say so");
  });

  test("a source naming nothing is a break, named", async () => {
    const { plugin } = await pluginOver({
      "data/media/child.md": { media: "[[data/assets/child.png]]", source: "[[gone.png]]" },
    });
    const breaks = plugin.lineageBreakReport();
    equal(breaks.length, 1);
    equal(breaks[0].kind, "source");
    equal(breaks[0].notePath, "data/media/child.md");
    ok(breaks[0].message.includes("gone.png"), breaks[0].message);
  });

  test("a note whose own media has gone is a break too", async () => {
    const { plugin } = await pluginOver({
      "data/media/ghost.md": { media: "[[vanished.png]]" },
    });
    const breaks = plugin.lineageBreakReport();
    equal(breaks.length, 1);
    equal(breaks[0].kind, "media");
    ok(breaks[0].message.includes("vanished.png"), breaks[0].message);
  });

  test("a cycle is reported once, not once per file in it", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const { plugin } = await pluginOver({
        "data/media/a.md": { media: "[[data/assets/root.png]]", source: "[[data/assets/child.png]]" },
        "data/media/b.md": { media: "[[data/assets/child.png]]", source: "[[data/assets/root.png]]" },
      });
      const breaks = plugin.lineageBreakReport();
      equal(breaks.length, 1, "a cycle is a property of the walk, not of a note");
      equal(breaks[0].kind, core.CHAIN_CYCLE);
      ok(breaks[0].message.includes("loops back"), breaks[0].message);
    } finally {
      console.warn = warn;
    }
  });

  test("the report reads the same twice", async () => {
    const { plugin } = await pluginOver({
      "data/media/one.md": { media: "[[data/assets/root.png]]", source: "[[gone.png]]" },
      "data/media/two.md": { media: "[[data/assets/child.png]]", source: "[[also-gone.png]]" },
    });
    deepEqual(
      plugin.lineageBreakReport().map((entry) => entry.notePath),
      plugin.lineageBreakReport().map((entry) => entry.notePath)
    );
  });

  test("the report never writes", async () => {
    const { plugin, app } = await pluginOver({
      "data/media/child.md": { media: "[[data/assets/child.png]]", source: "[[gone.png]]" },
    });
    const before = app.writes.length;
    plugin.showLineageBreaks();
    equal(app.writes.length, before);
  });

  test("breaks are shown in a window and logged to the console", async () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (message) => warnings.push(message);
    let breaks;
    try {
      const { plugin } = await pluginOver({
        "data/media/child.md": { media: "[[data/assets/child.png]]", source: "[[gone.png]]" },
      });
      breaks = plugin.showLineageBreaks();
    } finally {
      console.warn = warn;
    }
    equal(breaks.length, 1);
    equal(Modal.opened.length, 1);
    const modal = Modal.opened[0];
    const heading = modal.contentEl.children[0];
    equal(heading.tagName, "H3");
    equal(heading.textContent, "1 lineage break");
    ok(warnings.some((line) => line.includes("gone.png")), warnings.join(" | "));
  });

  test("the window says it has changed nothing", async () => {
    const { plugin } = await pluginOver({
      "data/media/child.md": { media: "[[data/assets/child.png]]", source: "[[gone.png]]" },
    });
    plugin.showLineageBreaks();
    const intro = Modal.opened[0].contentEl.querySelector(".mv-breaks-intro");
    ok(intro.textContent.includes("Nothing here has been changed"), intro.textContent);
  });

  test("a row opens the note it names", async () => {
    const { plugin, app } = await pluginOver({
      "data/media/child.md": { media: "[[data/assets/child.png]]", source: "[[gone.png]]" },
    });
    plugin.showLineageBreaks();
    const link = Modal.opened[0].contentEl.querySelector(".mv-breaks-link");
    equal(link.textContent, "child.md");
    link.dispatch("click", {});
    equal(app.workspace.openedFile.path, "data/media/child.md");
  });

  test("the commands are registered", async () => {
    const { plugin } = await pluginOver(HEALTHY);
    const ids = (plugin.commands || []).map((command) => command.id);
    ok(ids.includes("repair-lineage"), ids.join(", "));
    ok(ids.includes("lineage-breaks"), ids.join(", "));
  });
});


/* What has never been acted on — MV-OVERVIEW, reduced to the one question a
   Base cannot answer, because these files have no note to query. */

group("media nothing has been done to", () => {
  test("everything with no note, sorted", () => {
    const tracked = new Set(["a/one.png"]);
    deepEqual(core.untrackedMedia(["a/two.png", "a/one.png", "a/ten.png"], tracked), [
      "a/ten.png",
      "a/two.png",
    ]);
  });

  test("notes and other files are not media and are not listed", () => {
    deepEqual(core.untrackedMedia(["a/note.md", "a/thing.txt", "a/pic.png"], new Set()), ["a/pic.png"]);
  });

  test("a fully tracked vault reports nothing", () => {
    deepEqual(core.untrackedMedia(["a/one.png"], new Set(["a/one.png"])), []);
  });

  test("it copes with being handed nothing", () => {
    deepEqual(core.untrackedMedia(null, null), []);
    deepEqual(core.untrackedMedia(["a/one.png"], null), ["a/one.png"]);
  });
});

report("repair");
