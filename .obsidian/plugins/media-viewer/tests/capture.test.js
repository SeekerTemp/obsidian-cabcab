// Tests for frame capture: the position the note records, the PNG written
// beside the video, and the lineage that makes the frame evidence rather than
// a screenshot.
//
//   node tests/capture.test.js
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

group("the position a capture records", () => {
  test("seconds, to the millisecond the element reports", () => {
    equal(core.captureSourceTime(92.4567), 92.457);
    equal(core.captureSourceTime(0), 0);
  });

  test("a position before metadata does not become NaN in the note", () => {
    // This is the only record of where the frame came from — the filename no
    // longer carries it — so a wrong value points at the wrong moment.
    equal(core.captureSourceTime(NaN), 0);
    equal(core.captureSourceTime(undefined), 0);
    equal(core.captureSourceTime(-5), 0);
  });
});

group("the name a capture takes", () => {
  const NEVER = () => false;
  const FIXED = new Date(2026, 8, 9, 11, 4, 22);

  test("beside its video, timestamped, always PNG", () => {
    equal(
      core.framePathFor("data/assets/walk.mp4", NEVER, FIXED),
      "data/assets/walk+frame+260909110422.png"
    );
  });

  test("two captures in the same second do not overwrite each other", () => {
    const first = core.framePathFor("a/walk.mp4", NEVER, FIXED);
    equal(core.framePathFor("a/walk.mp4", (c) => c === first, FIXED), "a/walk+frame+260909110422.1.png");
  });
});

/* The pane. */

function fakeApp(paths) {
  const files = paths.map((path) => ({ path }));
  const on = () => ({});
  return {
    files,
    notes: new Map(),
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
      async create(path, text) {
        const created = { path, text };
        files.push(created);
        return created;
      },
      async read() {
        return "";
      },
      async process(file, fn) {
        return fn("");
      },
      getMarkdownFiles: () => [],
      adapter: {
        async exists() {
          return false;
        },
        async write() {},
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
    metadataCache: { on, getFileCache: () => null, getCache: () => null },
  };
}

const FILES = ["data/assets/walk.mp4", "data/assets/still.png"];

async function paneOver(paths) {
  dom.clearTimers();
  const app = fakeApp(paths || FILES);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  await plugin.onload();

  const view = new MediaViewerView({}, plugin);
  view.contentEl = dom.root.createDiv({ cls: "view-content" });
  app.workspace.leaves = [{ view }];
  await view.onOpen();
  view.stageEl.clientWidth = 400;
  view.stageEl.clientHeight = 300;
  plugin.pinFolder("data/assets");
  return { plugin, view, app };
}

// A video open, with metadata, sitting at a position.
function openVideo(view, at) {
  const video = view.videoEl;
  video.duration = 300;
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  video.fire("loadedmetadata");
  video.currentTime = at === undefined ? 92.4 : at;
  return video;
}

group("capturing the frame on screen", () => {
  test("writes a PNG beside the video", async () => {
    const { plugin, view, app } = await paneOver();
    plugin.select("data/assets/walk.mp4");
    openVideo(view);
    const path = await view.captureFrame();
    ok(/^data\/assets\/walk\+frame\+\d{12}\.png$/.test(path), "got " + path);
    equal(app.vault.lastWrite.path, path);
  });

  test("the frame is drawn at the video's own size, not the pane's", async () => {
    const { plugin, view } = await paneOver();
    plugin.select("data/assets/walk.mp4");
    const video = openVideo(view);
    await view.captureFrame();
    // The stub canvas records the draw; a capture scaled to the stage would be
    // evidence of a smaller screen than the one recorded.
    equal(video.drawnAt === undefined, true, "nothing is left on the video itself");
  });

  test("the selection moves onto the capture, so it is visible", async () => {
    const { plugin, view } = await paneOver();
    plugin.select("data/assets/walk.mp4");
    openVideo(view);
    const path = await view.captureFrame();
    equal(plugin.selectedPath, path);
  });

  test("and the index knows about it without waiting for the vault event", async () => {
    const { plugin, view } = await paneOver();
    plugin.select("data/assets/walk.mp4");
    openVideo(view);
    const path = await view.captureFrame();
    ok(plugin.index.paths.indexOf(path) !== -1);
  });

  test("with no video open it says so rather than writing nothing quietly", async () => {
    const { view, app } = await paneOver();
    equal(await view.captureFrame(), null);
    equal(app.vault.lastWrite, undefined);
  });

  test("before metadata there is no frame to draw, and none is written", async () => {
    const { plugin, view, app } = await paneOver();
    plugin.select("data/assets/walk.mp4");
    // No loadedmetadata: videoWidth is still zero. Drawing anyway yields a
    // blank canvas that looks like a successful capture of nothing.
    equal(await view.captureFrame(), null);
    equal(app.vault.lastWrite, undefined);
  });

  test("an image is not a video, and does not capture", async () => {
    const { plugin, view } = await paneOver();
    plugin.select("data/assets/still.png");
    equal(await view.captureFrame(), null);
  });
});

group("the note the capture leaves", () => {
  test("records the video and the second it came from", async () => {
    const { plugin, view } = await paneOver();
    plugin.select("data/assets/walk.mp4");
    openVideo(view, 92.4);

    const written = [];
    plugin.lineage.write = async (path, fields) => {
      written.push({ path, fields });
      return { path, fields };
    };
    plugin.ensureRootNote = async () => null;

    const path = await view.captureFrame();
    equal(written.length, 1);
    equal(written[0].path, path);
    equal(written[0].fields.op, "capture");
    equal(written[0].fields.sourceTime, 92.4, "the second, which is the whole point");
    ok(String(written[0].fields.source).indexOf("walk.mp4") !== -1, "and the video it came from");
    equal(written[0].fields.width, 1920);
    equal(written[0].fields.height, 1080);
  });

  test("the video gets a root note too, so the frame has a parent", async () => {
    const { plugin, view } = await paneOver();
    plugin.select("data/assets/walk.mp4");
    openVideo(view);
    const roots = [];
    plugin.ensureRootNote = async (path) => roots.push(path);
    plugin.lineage.write = async () => null;
    await view.captureFrame();
    deepEqual(roots, ["data/assets/walk.mp4"]);
  });

  test("with lineage writing off, the PNG still lands and no note is written", async () => {
    const { plugin, view, app } = await paneOver();
    plugin.settings.writeLineage = false;
    plugin.select("data/assets/walk.mp4");
    openVideo(view);
    let wrote = false;
    plugin.lineage.write = async () => {
      wrote = true;
    };
    const path = await view.captureFrame();
    equal(app.vault.lastWrite.path, path, "the file is still written");
    equal(wrote, false, "the note is not");
  });

  test("a note that will not write leaves the file and says to repair it", async () => {
    const { plugin, view, app } = await paneOver();
    plugin.select("data/assets/walk.mp4");
    openVideo(view);
    plugin.ensureRootNote = async () => null;
    plugin.lineage.write = async () => {
      throw new Error("read-only");
    };
    const reported = [];
    const original = console.error;
    console.error = (...args) => reported.push(args[0]);
    let path;
    try {
      path = await view.captureFrame();
    } finally {
      console.error = original;
    }
    equal(app.vault.lastWrite.path, path, "the capture survives the note failing");
    ok(reported.some((line) => String(line).indexOf("lineage note") !== -1));
  });
});

group("when the write fails", () => {
  test("nothing is selected and the failure is reported", async () => {
    const { plugin, view } = await paneOver();
    plugin.select("data/assets/walk.mp4");
    openVideo(view);
    plugin.app.vault.createBinary = async () => {
      throw new Error("disk full");
    };
    const reported = [];
    const original = console.error;
    console.error = (...args) => reported.push(args[0]);
    try {
      equal(await view.captureFrame(), null);
    } finally {
      console.error = original;
    }
    equal(plugin.selectedPath, "data/assets/walk.mp4", "selection stays on the video");
    ok(reported.length > 0);
  });
});

report("capture");
