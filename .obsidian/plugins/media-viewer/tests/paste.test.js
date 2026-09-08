// Tests for pasting an image into the pane's folder: naming it, reading it off
// a clipboard event, writing it, and leaving every other kind of paste alone.
//
//   node tests/paste.test.js
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

const FIXED_DATE = new Date(2026, 8, 8, 11, 4, 22);
const NEVER = () => false;
const takenIn = (paths) => (candidate) => paths.includes(candidate);

group("naming what the clipboard gives", () => {
  test("an image type becomes the extension it should be written as", () => {
    equal(core.extensionForMime("image/png"), "png");
    equal(core.extensionForMime("image/jpeg"), "jpg");
    equal(core.extensionForMime("image/webp"), "webp");
    equal(core.extensionForMime("image/gif"), "gif");
  });

  test("a GIF stays a GIF, unlike the encode map which sends it to PNG", () => {
    // MIME_BY_EXTENSION answers "what should this be encoded as"; this answers
    // "what did I just receive". Renaming received bytes would be a lie.
    equal(core.extensionForMime("image/gif"), "gif");
    equal(core.mimeForExtension("gif"), "image/png");
  });

  test("parameters and case do not stop it being recognised", () => {
    equal(core.extensionForMime("IMAGE/PNG"), "png");
    equal(core.extensionForMime("image/png; charset=binary"), "png");
    equal(core.extensionForMime("  image/jpeg  "), "jpg");
  });

  test("anything that is not an image is refused rather than guessed at", () => {
    equal(core.extensionForMime("text/plain"), null);
    equal(core.extensionForMime("application/pdf"), null);
    equal(core.extensionForMime(""), null);
    equal(core.extensionForMime(null), null);
    equal(core.extensionForMime(undefined), null);
  });
});

group("where a pasted image is written", () => {
  test("into the folder given, named for when it arrived", () => {
    equal(core.pastePathFor("data/assets", "png", NEVER, FIXED_DATE), "data/assets/pasted+260908110422.png");
  });

  test("the vault root is a folder like any other", () => {
    equal(core.pastePathFor("", "png", NEVER, FIXED_DATE), "pasted+260908110422.png");
  });

  test("two pastes in the same second do not overwrite each other", () => {
    const first = core.pastePathFor("a", "png", NEVER, FIXED_DATE);
    equal(core.pastePathFor("a", "png", takenIn([first]), FIXED_DATE), "a/pasted+260908110422.1.png");
  });

  test("the extension follows the image, and a missing one falls back to png", () => {
    equal(core.pastePathFor("a", "jpg", NEVER, FIXED_DATE), "a/pasted+260908110422.jpg");
    equal(core.pastePathFor("a", ".webp", NEVER, FIXED_DATE), "a/pasted+260908110422.webp");
    equal(core.pastePathFor("a", "", NEVER, FIXED_DATE), "a/pasted+260908110422.png");
    equal(core.pastePathFor("a", null, NEVER, FIXED_DATE), "a/pasted+260908110422.png");
  });
});

/* The pane. */

// A clipboard blob. Node has Blob, but the stub keeps the shape explicit and
// lets a test make arrayBuffer() fail.
function blobOf(type, size) {
  const bytes = new Uint8Array(size === undefined ? 4 : size);
  return {
    type,
    size: bytes.length,
    async arrayBuffer() {
      return bytes.buffer;
    },
  };
}

// A ClipboardEvent's data, in the `items` shape Electron uses for a copy from
// another application.
function clipboardWithItems(entries) {
  return {
    items: entries.map(([type, blob]) => ({
      kind: blob ? "file" : "string",
      type,
      getAsFile: () => blob,
    })),
  };
}

function fakeApp(paths) {
  const files = paths.map((path) => ({ path }));
  const on = () => ({});
  return {
    files,
    created: [],
    vault: {
      getFiles: () => files,
      on,
      getResourcePath: (file) => "app://local/" + file.path,
      getAbstractFileByPath(path) {
        return files.find((file) => file.path === path) || null;
      },
      async createBinary(path, bytes) {
        const created = { path, bytes };
        files.push(created);
        this.lastWrite = created;
        return created;
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

async function paneOver(paths, folder) {
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
  if (folder !== null) plugin.pinFolder(folder === undefined ? "data/assets" : folder);
  return { plugin, view, app };
}

// The paste handler is deliberately synchronous — it has to call
// preventDefault before it can await anything — so a test drives the write it
// started rather than awaiting the handler.
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

group("pasting into the pane", () => {
  test("an image on the clipboard is written into the folder the pane shows", async () => {
    const { view, app } = await paneOver(["data/assets/cover.png"]);
    let prevented = false;
    view.contentEl.fire("paste", {
      clipboardData: clipboardWithItems([["image/png", blobOf("image/png")]]),
      preventDefault: () => (prevented = true),
    });
    await settle();
    equal(prevented, true, "the pane claims the paste");
    ok(app.vault.lastWrite, "something was written");
    ok(
      /^data\/assets\/pasted\+\d{12}\.png$/.test(app.vault.lastWrite.path),
      "into the pane's folder, got " + app.vault.lastWrite.path
    );
  });

  test("and the selection moves to it, so the paste is visible", async () => {
    const { plugin, app } = await paneOver(["data/assets/cover.png"]);
    await plugin.writePastedImages([{ blob: blobOf("image/png"), mime: "image/png" }]);
    equal(plugin.selectedPath, app.vault.lastWrite.path);
  });

  test("a JPEG is written as a JPEG", async () => {
    const { plugin, app } = await paneOver(["data/assets/cover.png"]);
    await plugin.writePastedImages([{ blob: blobOf("image/jpeg"), mime: "image/jpeg" }]);
    ok(app.vault.lastWrite.path.endsWith(".jpg"), "got " + app.vault.lastWrite.path);
  });

  test("two images on one clipboard become two files", async () => {
    const { plugin, app } = await paneOver(["data/assets/cover.png"]);
    const written = await plugin.writePastedImages([
      { blob: blobOf("image/png", 4), mime: "image/png" },
      { blob: blobOf("image/png", 8), mime: "image/png" },
    ]);
    equal(written.length, 2);
    equal(new Set(written).size, 2, "with different names");
    equal(app.vault.lastWrite.path, written[1]);
  });

  test("the same image in both clipboard collections is written once", async () => {
    // Electron fills `items` and `files` differently depending on where the
    // copy came from, and sometimes fills both with the same image.
    const { view } = await paneOver(["data/assets/cover.png"]);
    const blob = blobOf("image/png");
    const found = view.imagesFrom({
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => blob }],
        files: [blob],
      },
    });
    equal(found.length, 1);
  });

  test("a copy that only fills `files` is still found", async () => {
    const { view } = await paneOver(["data/assets/cover.png"]);
    const found = view.imagesFrom({ clipboardData: { files: [blobOf("image/png")] } });
    equal(found.length, 1);
    equal(found[0].mime, "image/png");
  });
});

group("what the pane does not claim", () => {
  test("pasted text is left entirely alone", async () => {
    const { view, app } = await paneOver(["data/assets/cover.png"]);
    let prevented = false;
    const handled = view.handlePaste({
      clipboardData: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] },
      preventDefault: () => (prevented = true),
    });
    equal(handled, false);
    equal(prevented, false, "so pasting text into the pane still does whatever it did");
    equal(app.vault.lastWrite, undefined);
  });

  test("a file that is not an image is not claimed either", async () => {
    const { view } = await paneOver(["data/assets/cover.png"]);
    const handled = view.handlePaste({
      clipboardData: clipboardWithItems([["application/pdf", blobOf("application/pdf")]]),
      preventDefault: () => {},
    });
    equal(handled, false);
  });

  test("an empty clipboard event does nothing", async () => {
    const { view } = await paneOver(["data/assets/cover.png"]);
    equal(view.handlePaste({}), false);
    equal(view.handlePaste({ clipboardData: {} }), false);
  });

  test("with no folder open it refuses rather than guessing one", async () => {
    const { view, app } = await paneOver(["data/assets/cover.png"], null);
    const handled = view.handlePaste({
      clipboardData: clipboardWithItems([["image/png", blobOf("image/png")]]),
      preventDefault: () => {},
    });
    equal(handled, false);
    await settle();
    equal(app.vault.lastWrite, undefined);
  });
});

group("when writing fails", () => {
  test("the failure is reported and the pane carries on", async () => {
    const { plugin, app } = await paneOver(["data/assets/cover.png"]);
    const reported = [];
    const original = console.error;
    console.error = (...args) => reported.push(args[0]);
    try {
      app.vault.createBinary = async () => {
        throw new Error("disk full");
      };
      const written = await plugin.writePastedImages([{ blob: blobOf("image/png"), mime: "image/png" }]);
      deepEqual(written, []);
    } finally {
      console.error = original;
    }
    equal(reported.length, 1);
    ok(String(reported[0]).startsWith("Media Viewer: could not write a pasted image"));
  });

  test("one bad image does not stop the next", async () => {
    const { plugin, app } = await paneOver(["data/assets/cover.png"]);
    const bad = {
      mime: "image/png",
      blob: {
        type: "image/png",
        size: 1,
        async arrayBuffer() {
          throw new Error("unreadable");
        },
      },
    };
    const original = console.error;
    console.error = () => {};
    try {
      const written = await plugin.writePastedImages([bad, { blob: blobOf("image/png"), mime: "image/png" }]);
      equal(written.length, 1, "the good one still landed");
      equal(app.vault.lastWrite.path, written[0]);
    } finally {
      console.error = original;
    }
  });
});

group("the command palette route", () => {
  test("says so when the build cannot read the clipboard directly", async () => {
    const { plugin } = await paneOver(["data/assets/cover.png"]);
    const saved = global.navigator;
    delete global.navigator;
    try {
      deepEqual(await plugin.pasteFromClipboard(), []);
    } finally {
      if (saved === undefined) delete global.navigator;
      else global.navigator = saved;
    }
  });

  test("reads an image off the async clipboard and writes it", async () => {
    const { plugin, app } = await paneOver(["data/assets/cover.png"]);
    const saved = global.navigator;
    global.navigator = {
      clipboard: {
        async read() {
          return [
            {
              types: ["text/html", "image/png"],
              async getType(type) {
                equal(type, "image/png", "it asks for the image, not the html");
                return blobOf("image/png");
              },
            },
          ];
        },
      },
    };
    try {
      const written = await plugin.pasteFromClipboard();
      equal(written.length, 1);
      equal(app.vault.lastWrite.path, written[0]);
    } finally {
      if (saved === undefined) delete global.navigator;
      else global.navigator = saved;
    }
  });

  test("a clipboard with no image says so rather than writing nothing quietly", async () => {
    const { plugin, app } = await paneOver(["data/assets/cover.png"]);
    const saved = global.navigator;
    global.navigator = {
      clipboard: {
        async read() {
          return [{ types: ["text/plain"], async getType() {
            throw new Error("not asked for");
          } }];
        },
      },
    };
    try {
      deepEqual(await plugin.pasteFromClipboard(), []);
      equal(app.vault.lastWrite, undefined);
    } finally {
      if (saved === undefined) delete global.navigator;
      else global.navigator = saved;
    }
  });

  test("with no folder open it refuses", async () => {
    const { plugin } = await paneOver(["data/assets/cover.png"], null);
    deepEqual(await plugin.pasteFromClipboard(), []);
  });
});

report("paste");
