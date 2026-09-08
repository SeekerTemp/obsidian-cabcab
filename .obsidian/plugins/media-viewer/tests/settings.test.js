// Tests for the settings tab: that every control is there, that each one
// writes what it says it does, and that the values survive a reload.
//
//   node tests/settings.test.js
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerSettingTab, core } = require("./load-plugin.js");
const { Setting, Modal, Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const MEDIA = ["data/assets/a.png", "data/assets/sub/b.png"];

function fakeApp() {
  const files = new Map();
  const on = () => ({});
  for (const path of MEDIA) {
    files.set(path, { path, basename: core.stemOf(path), extension: core.extensionOf(path) });
  }
  const root = { path: "data/assets", children: [] };
  const sub = { path: "data/assets/sub", children: [files.get("data/assets/sub/b.png")] };
  root.children.push(files.get("data/assets/a.png"), sub);
  files.set("data/assets", root);
  files.set("data/assets/sub", sub);
  return {
    files,
    vault: {
      getConfig: () => true,
      getFiles: () => [...files.values()].filter((file) => file.extension),
      getMarkdownFiles: () => [],
      getAbstractFileByPath: (path) => files.get(path) || null,
      on,
      getResourcePath: (file) => "app://local/" + file.path,
      async read() {
        return "";
      },
      async modify() {},
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
      getLeavesOfType: () => [],
      onLayoutReady: (fn) => fn(),
    },
    metadataCache: { on, getFileCache: () => null, getFirstLinkpathDest: () => null },
  };
}

async function tabOver(saved) {
  dom.clearTimers();
  Notice.messages.length = 0;
  Modal.opened.length = 0;
  Setting.created.length = 0;
  const app = fakeApp();
  const plugin = new MediaViewerPlugin(app, {});
  let written = null;
  plugin.loadData = async () => saved || null;
  plugin.saveData = async (data) => {
    written = data;
  };
  await plugin.onload();
  const tab = plugin.settingTab;
  tab.display();
  return { plugin, app, tab, saved: () => written };
}

const settingNamed = (name) => Setting.created.find((setting) => setting.name === name);
const controlOf = (name) => {
  const setting = settingNamed(name);
  return setting && setting.controls[0];
};

group("the tab is registered and draws", () => {
  test("the plugin installs a settings tab", async () => {
    const { plugin, tab } = await tabOver();
    ok(tab instanceof MediaViewerSettingTab);
    equal(tab.plugin, plugin);
  });

  test("it groups the controls under headings", async () => {
    await tabOver();
    const headings = Setting.created.filter((setting) => setting.heading).map((setting) => setting.name);
    deepEqual(headings, ["Browsing", "Saving", "Lineage", "Diagnostics"]);
  });

  test("every control the task asks for is there", async () => {
    await tabOver();
    for (const name of [
      "Include subfolders",
      "JPEG and WebP quality",
      "Write lineage notes",
      "Folder for new lineage notes",
      "Debug logging",
    ]) {
      ok(settingNamed(name), "missing: " + name);
    }
  });

  test("redrawing does not stack a second copy of everything", async () => {
    const { tab } = await tabOver();
    const before = Setting.created.length;
    Setting.created.length = 0;
    tab.display();
    equal(Setting.created.length, before, "the container is emptied first");
  });
});

group("each control writes what it says", () => {
  test("recursion rescans as well as saving", async () => {
    const { plugin, saved } = await tabOver();
    deepEqual(plugin.visiblePaths(), []);
    plugin.pinFolder("data/assets");
    deepEqual(plugin.visiblePaths(), ["data/assets/a.png"]);
    controlOf("Include subfolders").change(true);
    equal(plugin.settings.recursive, true);
    deepEqual(plugin.visiblePaths(), ["data/assets/a.png", "data/assets/sub/b.png"]);
    equal(saved().recursive, true);
  });

  test("following the active file toggles", async () => {
    const { plugin, saved } = await tabOver();
    controlOf("Follow the active file").change(false);
    equal(plugin.settings.followActiveFile, false);
    equal(saved().followActiveFile, false);
  });

  test("quality is stored, and clamped to what a browser will accept", async () => {
    const { plugin, saved } = await tabOver();
    const slider = controlOf("JPEG and WebP quality");
    equal(slider.min, 0.1);
    equal(slider.max, 1);
    close(slider.value, core.DEFAULT_ENCODE_QUALITY);
    slider.change(0.6);
    close(plugin.settings.encodeQuality, 0.6);
    close(saved().encodeQuality, 0.6);
    slider.change(5);
    equal(plugin.settings.encodeQuality, 1);
  });

  test("turning lineage off stops the plugin writing notes", async () => {
    const { plugin, saved } = await tabOver();
    controlOf("Write lineage notes").change(false);
    equal(plugin.settings.writeLineage, false);
    equal(saved().writeLineage, false);
  });

  test("the note folder reaches the store, not just the settings", async () => {
    const { plugin, saved } = await tabOver();
    controlOf("Folder for new lineage notes").change("MyVault/records/media/");
    equal(plugin.settings.noteFolder, "MyVault/records/media");
    equal(plugin.lineage.noteFolder, "MyVault/records/media", "or the next note goes to the old one");
    equal(saved().noteFolder, "MyVault/records/media");
  });

  test("an emptied note folder falls back rather than writing to the vault root", async () => {
    const { plugin } = await tabOver();
    controlOf("Folder for new lineage notes").change("   ");
    equal(plugin.settings.noteFolder, core.DEFAULT_NOTE_FOLDER);
  });

  test("a Windows path is normalised on the way in", async () => {
    const { plugin } = await tabOver();
    controlOf("Folder for new lineage notes").change("data\\media\\notes\\");
    equal(plugin.settings.noteFolder, "data/media/notes");
  });

  test("debug logging turns the timings on", async () => {
    const { plugin, saved } = await tabOver();
    equal(plugin.logTiming("scan", "x", Date.now()), false);
    controlOf("Debug logging").change(true);
    equal(saved().debugLogging, true);
    const real = console.log;
    const lines = [];
    console.log = (message) => lines.push(String(message));
    try {
      plugin.logTiming("scan", "x", Date.now());
    } finally {
      console.log = real;
    }
    equal(lines.length, 1);
  });

  test("the break report is reachable from the settings", async () => {
    const { plugin } = await tabOver();
    controlOf("Report lineage breaks").click();
    ok(Notice.messages[0].includes("no lineage breaks"), Notice.messages.join(" | "));
  });
});

group("settings persist across a reload", () => {
  test("what was saved comes back", async () => {
    const { plugin } = await tabOver({
      recursive: true,
      encodeQuality: 0.55,
      writeLineage: false,
      noteFolder: "MyVault/records",
      debugLogging: true,
      filter: "video",
    });
    equal(plugin.settings.recursive, true);
    close(plugin.settings.encodeQuality, 0.55);
    equal(plugin.settings.writeLineage, false);
    equal(plugin.settings.noteFolder, "MyVault/records");
    equal(plugin.settings.debugLogging, true);
    equal(plugin.lineage.noteFolder, "MyVault/records", "and the store starts on it");
  });

  test("the controls open showing the saved values", async () => {
    await tabOver({ recursive: true, encodeQuality: 0.55, writeLineage: false, debugLogging: true });
    equal(controlOf("Include subfolders").value, true);
    close(controlOf("JPEG and WebP quality").value, 0.55);
    equal(controlOf("Write lineage notes").value, false);
    equal(controlOf("Debug logging").value, true);
  });

  test("a setting nobody has ever touched takes its default", async () => {
    const { plugin } = await tabOver({ filter: "image" });
    close(plugin.settings.encodeQuality, core.DEFAULT_ENCODE_QUALITY);
    equal(plugin.settings.writeLineage, true);
    equal(plugin.settings.noteFolder, core.DEFAULT_NOTE_FOLDER);
    equal(plugin.settings.debugLogging, false);
  });
});

report("settings");
