// Tests for the lineage panel: parent, children, and which values are this
// file's own. That third one is the reason the panel exists — resolved values
// are never written to disk, so without somewhere that says where one came
// from, inheritance is a mechanism nobody can check.
//
//   node tests/panel.test.js
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

const MEDIA = [
  "data/assets/root.png",
  "data/assets/child.png",
  "data/assets/grandchild.png",
  "data/assets/loose.png",
  "other/far.png",
];

function fakeApp(notes) {
  const files = new Map();
  const cache = new Map();
  const on = () => ({});
  for (const path of MEDIA) {
    files.set(path, { path, basename: core.stemOf(path), extension: core.extensionOf(path) });
  }
  for (const [path, front] of Object.entries(notes || {})) {
    files.set(path, { path, basename: core.stemOf(path), extension: "md" });
    cache.set(path, { frontmatter: Object.assign({ implements: "MediaInstance" }, front) });
  }
  return {
    files,
    cache,
    vault: {
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

const CHAIN = {
  "data/media/root.md": {
    media: "[[data/assets/root.png]]",
    status: "reviewed",
    labels: ["hero"],
    photographer: "Ada",
    width: 4000,
    height: 3000,
  },
  "data/media/child.md": {
    media: "[[data/assets/child.png]]",
    source: "[[data/assets/root.png]]",
    op: "crop",
    crop: { x: 120, y: 40, w: 800, h: 600 },
    transform: { rotate: 90, flipH: false, flipV: false },
    width: 800,
    height: 600,
    status: "edited",
  },
  "data/media/grandchild.md": {
    media: "[[data/assets/grandchild.png]]",
    source: "[[data/assets/child.png]]",
    op: "transform",
    width: 400,
    height: 300,
  },
};

async function pane(notes) {
  dom.clearTimers();
  Notice.messages.length = 0;
  const app = fakeApp(notes === undefined ? CHAIN : notes);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  await plugin.onload();
  const view = new MediaViewerView({}, plugin);
  view.contentEl = dom.root.createDiv({ cls: "view-content" });
  app.workspace.leaves = [{ view }];
  await view.onOpen();
  plugin.pinFolder("data/assets");
  return { plugin, view, app };
}

const bodyText = (view) => view.lineageBodyEl.textContent;
const allText = (element) =>
  [element.textContent || ""]
    .concat(element.children.map((child) => allText(child)))
    .filter(Boolean)
    .join(" ");
const panelText = (view) => allText(view.lineageBodyEl);
const rowsIn = (view, cls) => view.lineageBodyEl.querySelectorAll("." + cls);

function fieldRow(view, name) {
  for (const row of rowsIn(view, "mv-lineage-field")) {
    const key = row.querySelector(".mv-lineage-key");
    if (key && key.textContent === name) {
      return {
        value: row.querySelector(".mv-lineage-value").textContent,
        from: row.querySelector(".mv-lineage-from").textContent,
        inherited: row.hasClass("is-inherited"),
      };
    }
  }
  return null;
}

group("the panel exists and follows the selection", () => {
  test("with nothing selected it asks for a selection", async () => {
    const { view } = await pane();
    ok(panelText(view).includes("Select a file"), panelText(view));
  });

  test("an untracked file says so, and offers the one action that helps", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/loose.png");
    ok(panelText(view).includes("No lineage note"), panelText(view));
    const button = view.lineageBodyEl.querySelector(".mv-lineage-action");
    ok(button, "Mark as reviewed is offered");
    equal(button.textContent, "Mark as reviewed");
  });

  test("that button writes the note, and the panel stops saying it is missing", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/loose.png");
    view.lineageBodyEl.querySelector(".mv-lineage-action").dispatch("click", {});
    await new Promise((resolve) => setImmediate(resolve));
    ok(plugin.lineage.isTracked("data/assets/loose.png"));
    view.renderLineage();
    ok(!panelText(view).includes("No lineage note"), panelText(view));
  });

  test("it can be folded away and brought back", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/child.png");
    equal(view.lineageEl.hasClass("is-collapsed"), false);
    view.toggleLineage();
    ok(view.lineageEl.hasClass("is-collapsed"));
    equal(view.lineageToggleEl.getAttribute("aria-expanded"), "false");
    view.toggleLineage();
    equal(view.lineageEl.hasClass("is-collapsed"), false);
  });
});

group("the chain is visible and navigable", () => {
  test("a root says it is one", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/root.png");
    ok(panelText(view).includes("this is a root"), panelText(view));
  });

  test("a child names its parent", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/child.png");
    const links = rowsIn(view, "mv-lineage-link").map((el) => el.textContent);
    ok(links.includes("root.png"), links.join(", "));
  });

  test("a grandchild shows the whole chain, nearest first", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/grandchild.png");
    const from = view.lineageBodyEl.children[0];
    deepEqual(
      from.querySelectorAll(".mv-lineage-link").map((el) => el.textContent),
      ["child.png", "root.png"]
    );
  });

  test("children are listed and counted", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/root.png");
    ok(panelText(view).includes("1 derived file"), panelText(view));
    plugin.select("data/assets/child.png");
    const sections = view.lineageBodyEl.children.map((el) => el.children[0].textContent);
    ok(sections.includes("1 derived file"), sections.join(" | "));
  });

  test("a file nothing came from says so", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/grandchild.png");
    ok(panelText(view).includes("Nothing has been made from this yet"), panelText(view));
  });

  test("clicking a link jumps to that file", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/grandchild.png");
    const link = view.lineageBodyEl.querySelectorAll(".mv-lineage-link")[1];
    equal(link.textContent, "root.png");
    link.dispatch("click", {});
    equal(plugin.selectedPath, "data/assets/root.png");
  });

  test("a link into another folder takes the grid with it", async () => {
    const { plugin, view } = await pane({
      "data/media/child.md": {
        media: "[[data/assets/child.png]]",
        source: "[[other/far.png]]",
        op: "crop",
      },
    });
    plugin.select("data/assets/child.png");
    view.lineageBodyEl.querySelector(".mv-lineage-link").dispatch("click", {});
    equal(plugin.index.folder, "other");
    equal(plugin.selectedPath, "other/far.png");
  });
});

group("which values are this file's own", () => {
  test("a declared value is marked own", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/child.png");
    const status = fieldRow(view, "status");
    equal(status.value, "edited");
    equal(status.from, "own");
    equal(status.inherited, false);
  });

  test("an inherited value names the file it came from", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/child.png");
    const labels = fieldRow(view, "labels");
    equal(labels.value, "hero");
    equal(labels.from, "root.png");
    ok(labels.inherited);
  });

  test("a grandchild inherits through its parent", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/grandchild.png");
    equal(fieldRow(view, "status").from, "child.png", "the nearer one wins");
    equal(fieldRow(view, "photographer").from, "root.png");
  });

  test("intrinsic values are the file's own and nobody else's", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/grandchild.png");
    equal(fieldRow(view, "width").value, "400", "not the root's 4000");
    equal(fieldRow(view, "width").from, "own");
    equal(fieldRow(view, "crop"), null, "and the parent's crop is not borrowed");
  });

  test("a crop reads as a rectangle rather than as JSON", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/child.png");
    equal(fieldRow(view, "crop").value, "120,40 800x600");
    equal(fieldRow(view, "transform").value, "90°");
  });

  test("the known fields come first, in the order the note writes them", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/child.png");
    const names = rowsIn(view, "mv-lineage-key").map((el) => el.textContent);
    equal(names[0], "media");
    ok(names.indexOf("crop") < names.indexOf("status"), names.join(", "));
  });

  test("a field nothing here knows about still shows, and still says where it came from", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/child.png");
    const row = fieldRow(view, "photographer");
    equal(row.value, "Ada");
    equal(row.from, "root.png");
  });
});

group("breaks are shown, not just logged", () => {
  test("a source naming a missing file is called out by name", async () => {
    const { plugin, view } = await pane({
      "data/media/child.md": {
        media: "[[data/assets/child.png]]",
        source: "[[deleted.png]]",
      },
    });
    plugin.select("data/assets/child.png");
    const problem = view.lineageBodyEl.querySelector(".mv-lineage-problem");
    ok(problem, "the break is on screen");
    ok(problem.textContent.includes("deleted.png"), problem.textContent);
  });

  test("a cycle is shown too", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const { plugin, view } = await pane({
        "data/media/a.md": { media: "[[data/assets/root.png]]", source: "[[data/assets/child.png]]" },
        "data/media/b.md": { media: "[[data/assets/child.png]]", source: "[[data/assets/root.png]]" },
      });
      plugin.select("data/assets/root.png");
      const problem = view.lineageBodyEl.querySelector(".mv-lineage-problem");
      ok(problem, "the loop is on screen");
      ok(problem.textContent.includes("loops back"), problem.textContent);
    } finally {
      console.warn = warn;
    }
  });

  test("a healthy chain shows no banner", async () => {
    const { plugin, view } = await pane();
    plugin.select("data/assets/grandchild.png");
    equal(view.lineageBodyEl.querySelector(".mv-lineage-problem"), null);
  });
});

report("panel");
