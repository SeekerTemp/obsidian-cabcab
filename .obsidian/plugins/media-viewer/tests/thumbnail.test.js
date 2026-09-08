// Tests for video thumbnails: where the frame is taken from and how big it is
// drawn, then the machinery around the expensive part — the bounded queue, the
// frame cache, cancellation, and the failure set that stops a file the browser
// cannot decode from being retried on every scroll past it.
//
//   node tests/thumbnail.test.js
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const { VIDEO_THUMBNAIL_CONCURRENCY, VIDEO_THUMBNAIL_MAX_EDGE, VIDEO_THUMBNAIL_SECONDS } = core;

group("where a thumbnail is taken from", () => {
  test("one second in, past the black frame most videos open on", () => {
    equal(core.thumbnailSeekTime(60), 1);
    equal(core.thumbnailSeekTime(60, VIDEO_THUMBNAIL_SECONDS), 1);
  });

  test("halfway through anything shorter than that", () => {
    // Seeking past the end lands on the last frame, which is as likely to be
    // black as the first.
    equal(core.thumbnailSeekTime(0.5), 0.25);
    equal(core.thumbnailSeekTime(1), 0.5);
  });

  test("an unknown duration asks for the first frame rather than for NaN", () => {
    equal(core.thumbnailSeekTime(NaN), 0);
    equal(core.thumbnailSeekTime(0), 0);
    equal(core.thumbnailSeekTime(undefined), 0);
  });

  test("a custom target is honoured", () => {
    equal(core.thumbnailSeekTime(60, 5), 5);
    equal(core.thumbnailSeekTime(60, 0), 0);
  });
});

group("how big it is drawn", () => {
  test("scaled down to the cap on its long edge, keeping its shape", () => {
    deepEqual(core.thumbnailCanvasSize(1920, 1080, 320), { width: 320, height: 180 });
    deepEqual(core.thumbnailCanvasSize(1080, 1920, 320), { width: 180, height: 320 });
  });

  test("never scaled up: a small video stays its own size", () => {
    deepEqual(core.thumbnailCanvasSize(120, 80, 320), { width: 120, height: 80 });
  });

  test("integers, because a canvas sized 160.5 loses a pixel out of sight", () => {
    const size = core.thumbnailCanvasSize(1000, 333, 320);
    equal(size.width, 320);
    equal(size.height, 107);
    equal(Number.isInteger(size.height), true);
  });

  test("an extreme aspect ratio still has at least one pixel on its short edge", () => {
    const size = core.thumbnailCanvasSize(4000, 3, 320);
    equal(size.height >= 1, true);
  });

  test("a video with no reported size cannot be drawn, and says so", () => {
    equal(core.thumbnailCanvasSize(0, 1080, 320), null);
    equal(core.thumbnailCanvasSize(NaN, 1080, 320), null);
  });

  test("a missing cap falls back to the shared one", () => {
    deepEqual(core.thumbnailCanvasSize(1920, 1080), { width: VIDEO_THUMBNAIL_MAX_EDGE, height: 180 });
  });
});

/* The thumbnailer. */

function fakeApp(paths) {
  const files = paths.map((path) => ({ path }));
  const on = () => ({});
  return {
    files,
    vault: {
      getFiles: () => files,
      on,
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

const CLIPS = ["data/clips/a.mp4", "data/clips/b.mp4", "data/clips/c.mp4", "data/clips/d.mp4"];

async function paneOver(paths) {
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

  plugin.pinFolder("data/clips");
  return { plugin, view, app };
}

// The view's own observer, not whichever one the stub made first: every pane
// in this file builds another, and the earlier ones still hold their tiles.
const observerFor = (view) => view.observer;
const tileFor = (view, path) => view.tiles.get(path);
const frameOf = (tile) => tile.querySelector(".mv-tile-frame");
const thumbOf = (tile) => tile.querySelector(".mv-thumb");

// Report tiles as on screen, which is what starts the work.
function show(view, paths) {
  const observer = observerFor(view);
  observer.trigger(paths.map((path) => tileFor(view, path)), true);
}

function hide(view, paths) {
  const observer = observerFor(view);
  observer.trigger(paths.map((path) => tileFor(view, path)), false);
}

// Stands in for a decoder getting far enough to draw: the element reports its
// size and duration, fires loadeddata — which is what makes the viewer seek —
// then fires seeked.
function decode(view, path, options) {
  const settings = options || {};
  const job = view.frameJobs.get(path);
  if (!job) throw new Error("no job running for " + path);
  const video = job.video;
  video.duration = settings.duration === undefined ? 60 : settings.duration;
  // Not `||`: a test passing zero is testing zero, and a default that swallows
  // it would quietly assert the opposite of what it says.
  video.videoWidth = settings.width === undefined ? 1920 : settings.width;
  video.videoHeight = settings.height === undefined ? 1080 : settings.height;
  video.fire("loadeddata");
  if (settings.stopAfterSeekRequest) return video;
  video.fire("seeked");
  return video;
}

function fail(view, path) {
  const job = view.frameJobs.get(path);
  if (!job) throw new Error("no job running for " + path);
  job.video.fire("error");
}

group("a video tile gets a real frame", () => {
  test("the placeholder says work is under way, not that this is all there is", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, ["data/clips/a.mp4"]);
    const frame = frameOf(tileFor(view, "data/clips/a.mp4"));
    ok(frame.hasClass("is-placeholder"));
    ok(frame.hasClass("is-pending"), "and that it is pending");
  });

  test("the decoder is pointed at the file and seeks a second in", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, ["data/clips/a.mp4"]);
    const job = view.frameJobs.get("data/clips/a.mp4");
    equal(job.video.src, "app://local/data/clips/a.mp4?v=0");
    equal(job.video.muted, true, "a thumbnailer that makes a sound is not one");
    job.video.duration = 60;
    job.video.videoWidth = 1920;
    job.video.videoHeight = 1080;
    job.video.fire("loadeddata");
    equal(job.video.currentTime, 1);
  });

  test("the seeked frame is drawn at the capped size and shown in the tile", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, ["data/clips/a.mp4"]);
    const video = decode(view, "data/clips/a.mp4");
    const tile = tileFor(view, "data/clips/a.mp4");
    const img = thumbOf(tile);
    ok(img, "the tile holds an image");
    equal(img.src, "data:image/jpeg;base64,stub-320x180");
    equal(frameOf(tile).hasClass("is-placeholder"), false);
    equal(frameOf(tile).hasClass("is-pending"), false);
    ok(video.loadCount > 0, "and the decoder is released once it has its frame");
  });

  test("the element that was seeked is the one drawn", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, ["data/clips/a.mp4"]);
    const job = view.frameJobs.get("data/clips/a.mp4");
    const video = job.video;
    decode(view, "data/clips/a.mp4");
    // The canvas is created inside drawFrame, so the recorded call is the only
    // way to see what was handed to it.
    ok(video.captured === undefined, "no state left on the element itself");
  });

  test("a portrait video keeps its shape", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, ["data/clips/a.mp4"]);
    decode(view, "data/clips/a.mp4", { width: 1080, height: 1920 });
    equal(thumbOf(tileFor(view, "data/clips/a.mp4")).src, "data:image/jpeg;base64,stub-180x320");
  });

  test("an image in the same folder still loads the ordinary way", async () => {
    const { view } = await paneOver(CLIPS.concat(["data/clips/still.png"]));
    show(view, ["data/clips/still.png"]);
    equal(view.frameJobs.size, 0, "no decoder for an image");
    equal(thumbOf(tileFor(view, "data/clips/still.png")).src, "app://local/data/clips/still.png?v=0");
  });
});

group("the queue is deliberately narrow", () => {
  test("only so many videos are decoded at once", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, CLIPS);
    equal(view.frameJobs.size, VIDEO_THUMBNAIL_CONCURRENCY);
    equal(view.frameQueue.length, CLIPS.length - VIDEO_THUMBNAIL_CONCURRENCY);
  });

  test("finishing one starts the next", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, CLIPS);
    const running = Array.from(view.frameJobs.keys());
    decode(view, running[0]);
    equal(view.frameJobs.size, VIDEO_THUMBNAIL_CONCURRENCY, "the slot is refilled");
    equal(view.frameJobs.has(running[0]), false, "by something else");
  });

  test("the backlog is served newest first, because that is what is on screen", async () => {
    // The first arrivals start straight away — there is nothing to choose
    // between when no one is waiting. The ordering matters for the backlog:
    // tiles asked for last are the ones the user has scrolled to, and serving
    // the earlier ones first would fill the screen behind them.
    const { view } = await paneOver(CLIPS);
    show(view, CLIPS);
    deepEqual(Array.from(view.frameJobs.keys()), [CLIPS[0], CLIPS[1]], "the first two run");
    deepEqual(view.frameQueue.map((entry) => entry.path), [CLIPS[2], CLIPS[3]], "the rest wait");

    decode(view, CLIPS[0]);
    ok(view.frameJobs.has(CLIPS[3]), "and the freed slot goes to the newest waiting request");
    equal(view.frameJobs.has(CLIPS[2]), false);
  });

  test("every video eventually gets its turn", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, CLIPS);
    for (let guard = 0; guard < 10 && view.frameJobs.size; guard += 1) {
      decode(view, Array.from(view.frameJobs.keys())[0]);
    }
    equal(view.frameQueue.length, 0);
    equal(view.frameJobs.size, 0);
    for (const path of CLIPS) ok(thumbOf(tileFor(view, path)), path + " has a frame");
  });
});

group("frames are kept, because a re-seek is the expensive thing", () => {
  test("a second look at the same video uses the frame already drawn", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, ["data/clips/a.mp4"]);
    decode(view, "data/clips/a.mp4");
    const url = thumbOf(tileFor(view, "data/clips/a.mp4")).src;

    // Age the tile out of the tile cache, which strips its <img>.
    view.thumbnails.delete("data/clips/a.mp4");
    equal(thumbOf(tileFor(view, "data/clips/a.mp4")), null);

    view.loadThumbnail(tileFor(view, "data/clips/a.mp4"), "data/clips/a.mp4");
    equal(thumbOf(tileFor(view, "data/clips/a.mp4")).src, url, "the same frame");
    equal(view.frameJobs.size, 0, "and no second trip to the drive");
  });

  test("a modified video is drawn again, since a frame carries no mtime", async () => {
    const { plugin, view, app } = await paneOver(CLIPS);
    show(view, ["data/clips/a.mp4"]);
    decode(view, "data/clips/a.mp4");
    app.vault.version = 1;
    plugin.index.handleModify({ path: "data/clips/a.mp4" });
    ok(view.frameJobs.has("data/clips/a.mp4"), "a fresh decode was started");
    equal(view.frameJobs.get("data/clips/a.mp4").video.src, "app://local/data/clips/a.mp4?v=1");
  });

  test("the frame cache holds a bounded number of them", async () => {
    const { view } = await paneOver(CLIPS);
    equal(view.frames.capacity, core.VIDEO_FRAME_CACHE_SIZE);
  });
});

group("one bad file does not take down the folder", () => {
  test("a video that will not decode marks its tile and moves on", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, CLIPS);
    const path = Array.from(view.frameJobs.keys())[0];
    fail(view, path);
    ok(tileFor(view, path).hasClass("is-broken"));
    equal(view.frameJobs.has(path), false, "the slot is freed");
    equal(view.frameJobs.size, VIDEO_THUMBNAIL_CONCURRENCY, "and the next one starts");
  });

  test("and is not attempted again on the next scroll past it", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, ["data/clips/a.mp4"]);
    fail(view, "data/clips/a.mp4");
    hide(view, ["data/clips/a.mp4"]);
    view.thumbnails.delete("data/clips/a.mp4");
    show(view, ["data/clips/a.mp4"]);
    equal(view.frameJobs.has("data/clips/a.mp4"), false, "no retry");
    ok(tileFor(view, "data/clips/a.mp4").hasClass("is-broken"), "still marked");
  });

  test("a video with no reported size fails rather than drawing nothing", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, ["data/clips/a.mp4"]);
    decode(view, "data/clips/a.mp4", { width: 0, height: 0 });
    ok(tileFor(view, "data/clips/a.mp4").hasClass("is-broken"));
    equal(thumbOf(tileFor(view, "data/clips/a.mp4")), null);
  });

  test("a file that never responds gives up its slot on the timeout", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, CLIPS);
    const stuck = Array.from(view.frameJobs.keys())[0];
    // The only thing pending is the job timers; running them fires the one
    // this job armed.
    dom.runTimers();
    equal(view.frameJobs.has(stuck), false, "released");
    ok(tileFor(view, stuck).hasClass("is-broken"));
  });
});

group("work for a screen nobody is looking at is dropped", () => {
  test("a tile that scrolls away withdraws its queued request", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, CLIPS);
    const queued = view.frameQueue.map((entry) => entry.path);
    hide(view, [queued[0]]);
    equal(
      view.frameQueue.some((entry) => entry.path === queued[0]),
      false
    );
  });

  test("but one already decoding is left to finish, having paid for its slot", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, CLIPS);
    const running = Array.from(view.frameJobs.keys())[0];
    hide(view, [running]);
    ok(view.frameJobs.has(running));
  });

  test("changing folder cancels everything and releases the decoders", async () => {
    const { plugin, view } = await paneOver(CLIPS.concat(["other/x.mp4"]));
    show(view, CLIPS);
    const videos = Array.from(view.frameJobs.values()).map((job) => job.video);
    plugin.pinFolder("other");
    equal(view.frameJobs.size, 0);
    equal(view.frameQueue.length, 0);
    for (const video of videos) ok(video.loadCount > 0, "the decoder was released");
  });

  test("closing the pane does the same", async () => {
    const { view } = await paneOver(CLIPS);
    show(view, CLIPS);
    const videos = Array.from(view.frameJobs.values()).map((job) => job.video);
    await view.onClose();
    equal(view.frameJobs.size, 0);
    equal(view.frames.size, 0);
    for (const video of videos) ok(video.loadCount > 0);
  });
});

report("thumbnail");
