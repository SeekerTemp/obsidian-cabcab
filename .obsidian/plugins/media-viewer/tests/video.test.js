// Tests for the video viewer: the playback maths in `core` — clamping,
// seeking, frame stepping, the scrub conversions and the timecode — then the
// transport that holds the state, its keyboard, and the release path that
// stops a video the user has navigated away from.
//
//   node tests/video.test.js
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const { SCRUB_RESOLUTION, SPEED_STEPS, VIDEO_FRAME_SECONDS, VIDEO_SEEK_SECONDS } = core;

group("playback position stays inside the media", () => {
  test("a position in range passes through", () => {
    equal(core.clampTime(4, 10), 4);
  });

  test("past either end lands on the end", () => {
    equal(core.clampTime(12, 10), 10);
    equal(core.clampTime(-3, 10), 0);
  });

  test("an unknown duration pins the head at zero rather than seeking to NaN", () => {
    // duration is NaN until metadata arrives, and currentTime = NaN throws.
    equal(core.clampTime(4, NaN), 0);
    equal(core.clampTime(4, 0), 0);
    equal(core.clampTime(4, undefined), 0);
  });

  test("a nonsense position reads as the start", () => {
    equal(core.clampTime(NaN, 10), 0);
    equal(core.clampTime(undefined, 10), 0);
  });
});

group("seeking", () => {
  test("moves by the offset in either direction", () => {
    equal(core.seekTime(20, 5, 60), 25);
    equal(core.seekTime(20, -5, 60), 15);
  });

  test("stops at the ends instead of running past them", () => {
    equal(core.seekTime(58, 5, 60), 60, "the end of the file");
    equal(core.seekTime(2, -5, 60), 0, "the start");
  });

  test("a seek before metadata arrives goes nowhere", () => {
    equal(core.seekTime(0, 5, NaN), 0);
  });

  test("a nonsense offset leaves the head where it was", () => {
    equal(core.seekTime(20, NaN, 60), 20);
    equal(core.seekTime(20, undefined, 60), 20);
  });
});

group("frame stepping", () => {
  test("a step is one frame at the assumed rate", () => {
    close(core.frameStepTime(1, 1, 60, 1 / 30), 1 + 1 / 30, 1e-9);
    close(core.frameStepTime(1, -1, 60, 1 / 30), 1 - 1 / 30, 1e-9);
  });

  test("several frames at once, which is the same maths", () => {
    close(core.frameStepTime(1, 10, 60, 1 / 30), 1 + 10 / 30, 1e-9);
  });

  test("stepping back from the first frame stays on it", () => {
    equal(core.frameStepTime(0, -1, 60, 1 / 30), 0);
  });

  test("stepping forward from the last frame stays on it", () => {
    equal(core.frameStepTime(60, 1, 60, 1 / 30), 60);
  });

  test("an absent or absurd frame size falls back to the default", () => {
    close(core.frameStepTime(1, 1, 60), 1 + VIDEO_FRAME_SECONDS, 1e-9);
    close(core.frameStepTime(1, 1, 60, 0), 1 + VIDEO_FRAME_SECONDS, 1e-9);
    close(core.frameStepTime(1, 1, 60, NaN), 1 + VIDEO_FRAME_SECONDS, 1e-9);
  });
});

group("the scrub bar's two conversions", () => {
  test("the head's position maps onto the bar", () => {
    equal(core.scrubPositionFor(0, 60, 1000), 0);
    equal(core.scrubPositionFor(30, 60, 1000), 500);
    equal(core.scrubPositionFor(60, 60, 1000), 1000);
  });

  test("and a place on the bar maps back into the media", () => {
    equal(core.timeFromScrub(0, 60, 1000), 0);
    equal(core.timeFromScrub(500, 60, 1000), 30);
    equal(core.timeFromScrub(1000, 60, 1000), 60);
  });

  test("a round trip returns the same step, so the thumb does not creep", () => {
    // The bar is redrawn from the element's position on every timeupdate. A
    // conversion that lost a step each way would walk the thumb off the head.
    for (const position of [0, 1, 37, 499, 500, 501, 999, 1000]) {
      const time = core.timeFromScrub(position, 143.7, 1000);
      equal(core.scrubPositionFor(time, 143.7, 1000), position, "step " + position);
    }
  });

  test("a range input hands over a string, which converts like a number", () => {
    equal(core.timeFromScrub("500", 60, 1000), 30);
  });

  test("a position off either end of the bar is pulled back onto it", () => {
    equal(core.timeFromScrub(-40, 60, 1000), 0);
    equal(core.timeFromScrub(4000, 60, 1000), 60);
  });

  test("with no duration the bar sits at zero and seeks nowhere", () => {
    equal(core.scrubPositionFor(10, NaN, 1000), 0);
    equal(core.timeFromScrub(500, NaN, 1000), 0);
    equal(core.timeFromScrub(500, 0, 1000), 0);
  });

  test("a missing resolution falls back to the shared one", () => {
    equal(core.scrubPositionFor(30, 60), SCRUB_RESOLUTION / 2);
    equal(core.timeFromScrub(SCRUB_RESOLUTION / 2, 60), 30);
  });
});

group("the timecode readout", () => {
  test("minutes and seconds, zero-padded on the seconds only", () => {
    equal(core.formatTimecode(0), "0:00");
    equal(core.formatTimecode(7), "0:07");
    equal(core.formatTimecode(67), "1:07");
    equal(core.formatTimecode(600), "10:00");
  });

  test("hours appear only once there are hours", () => {
    equal(core.formatTimecode(3599), "59:59");
    equal(core.formatTimecode(3600), "1:00:00");
    equal(core.formatTimecode(3725), "1:02:05");
  });

  test("seconds floor, so the readout never runs ahead of the head", () => {
    equal(core.formatTimecode(9.99), "0:09");
  });

  test("an unknown duration reads as dashes, not as zero", () => {
    equal(core.formatTimecode(NaN), "--:--");
    equal(core.formatTimecode(Infinity), "--:--", "a live stream has no end to show");
    equal(core.formatTimecode(-1), "--:--");
    equal(core.formatTimecode(undefined), "--:--");
  });
});

/* The transport. */

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

const FILES = ["data/assets/a.png", "data/assets/clip.mp4", "data/assets/other.webm"];

async function paneOver(paths) {
  dom.clearTimers();
  dom.clearFrames();
  const app = fakeApp(paths);
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

// Stands in for metadata arriving: the element reports its size and duration,
// then fires the event the viewer listens for.
function metadata(view, duration, width, height) {
  const video = view.videoEl;
  video.duration = duration;
  video.videoWidth = width || 1920;
  video.videoHeight = height || 1080;
  video.fire("loadedmetadata");
  return video;
}

// A video opened and ready to play, which is the starting point for most of
// what follows.
async function playing(paths) {
  const pane = await paneOver(paths || FILES);
  pane.plugin.select("data/assets/clip.mp4");
  metadata(pane.view, 60);
  return pane;
}

const message = (view) => {
  const el = view.stageEl.querySelector(".mv-stage-message");
  return el ? el.textContent : null;
};

group("what the stage shows for a video", () => {
  test("a video loads into a video element from the resource path", async () => {
    const { view } = await playing();
    const video = view.stageEl.querySelector(".mv-video");
    ok(video, "the stage holds a video element");
    equal(video.src, "app://local/data/assets/clip.mp4?v=0");
    equal(video.tagName, "VIDEO");
  });

  test("the viewer is in video mode, which is what shows the transport", async () => {
    const { view } = await playing();
    ok(view.viewerEl.hasClass("is-video"));
  });

  test("an image leaves video mode again", async () => {
    const { plugin, view } = await playing();
    plugin.select("data/assets/a.png");
    equal(view.videoEl, null);
    equal(view.viewerEl.hasClass("is-video"), false);
  });

  test("native controls are off, because the transport is the controls", async () => {
    const { view } = await playing();
    equal(view.videoEl.controls, false);
  });

  test("the size is recorded for the frame capture that comes later", async () => {
    const { view } = await playing();
    equal(view.videoWidth, 1920);
    equal(view.videoHeight, 1080);
  });

  test("a video that will not play names its container, and the pane survives it", async () => {
    const { plugin, view } = await playing();
    view.videoEl.fire("error");
    equal(message(view), "This video could not be played. The MP4 codec may be unsupported.");
    ok(view.stageEl.hasClass("is-broken"));
    equal(view.videoEl, null, "and the element is released rather than left decoding");
    plugin.select("data/assets/other.webm");
    ok(view.videoEl, "the next file still opens");
    equal(view.stageEl.hasClass("is-broken"), false);
  });
});

group("the transport before metadata arrives", () => {
  test("the readout says it does not know yet, rather than claiming zero", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/clip.mp4");
    equal(view.timeEl.textContent, "0:00 / --:--");
  });

  test("nothing that needs a duration can be operated", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/clip.mp4");
    equal(view.scrubEl.disabled, true);
    equal(view.stepBackEl.disabled, true);
    equal(view.stepForwardEl.disabled, true);
    equal(view.playEl.disabled, false, "but play still is: it is what loads the rest");
  });

  test("a seek before then goes nowhere rather than to NaN", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/clip.mp4");
    view.seekBy(5);
    equal(view.videoEl.currentTime, 0);
    view.seekToScrub(500);
    equal(view.videoEl.currentTime, 0);
  });

  test("with no video open the transport is inert and says so", async () => {
    const { view } = await paneOver(FILES);
    equal(view.timeEl.textContent, "--:-- / --:--");
    equal(view.playEl.disabled, true);
    equal(view.scrubEl.disabled, true);
    equal(view.togglePlayback(), false);
    equal(view.stepFrame(1), false);
    equal(view.seekBy(5), false);
  });
});

group("play and pause", () => {
  test("the button plays, and says what it will do next", async () => {
    const { view } = await playing();
    equal(view.playEl.textContent, "Play");
    view.playEl.fire("click");
    equal(view.videoEl.paused, false);
    equal(view.playEl.textContent, "Pause");
  });

  test("and pauses again", async () => {
    const { view } = await playing();
    view.togglePlayback();
    view.togglePlayback();
    equal(view.videoEl.paused, true);
    equal(view.playEl.textContent, "Play");
  });

  test("Space is play/pause", async () => {
    const { view } = await playing();
    equal(view.handleKey({ key: " " }), true);
    equal(view.videoEl.paused, false);
    view.handleKey({ key: " " });
    equal(view.videoEl.paused, true);
  });

  test("Space over an image is left alone, so the pane still scrolls", async () => {
    const { plugin, view } = await playing();
    plugin.select("data/assets/a.png");
    equal(view.handleKey({ key: " " }), false);
  });

  test("a play the browser refuses does not become an unhandled rejection", async () => {
    const { view } = await playing();
    view.videoEl.play = () => Promise.reject(new Error("no decoder"));
    // The refusal is expected here, so its report is captured rather than
    // printed into the middle of the suite's output.
    const reported = [];
    const original = console.error;
    console.error = (...args) => reported.push(args[0]);
    try {
      view.togglePlayback();
      // Two turns: one for the rejection, one for the catch handler.
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.error = original;
    }
    equal(reported.length, 1, "handled, and reported once");
    equal(reported[0], "Media Viewer: playback failed");
    equal(view.videoEl.paused, true, "and the transport still says Play");
    equal(view.playEl.textContent, "Play");
  });
});

group("seeking from the keyboard", () => {
  test("W and S move five seconds either way", async () => {
    const { view } = await playing();
    view.videoEl.currentTime = 20;
    view.handleKey({ key: "w" });
    equal(view.videoEl.currentTime, 20 + VIDEO_SEEK_SECONDS);
    view.handleKey({ key: "s" });
    equal(view.videoEl.currentTime, 20);
  });

  test("which is the zoom pair doing the same job in the other mode", async () => {
    const { plugin, view } = await playing();
    plugin.select("data/assets/a.png");
    const before = view.zoom;
    view.handleKey({ key: "w" });
    ok(view.zoom !== before, "W still zooms an image");
  });

  test("seeking stops at both ends", async () => {
    const { view } = await playing();
    view.videoEl.currentTime = 58;
    view.handleKey({ key: "w" });
    equal(view.videoEl.currentTime, 60);
    view.videoEl.currentTime = 2;
    view.handleKey({ key: "s" });
    equal(view.videoEl.currentTime, 0);
  });

  test("A and D still step siblings while a video is open", async () => {
    const { plugin, view } = await playing();
    view.handleKey({ key: "d" });
    equal(plugin.selectedPath, "data/assets/other.webm");
    view.handleKey({ key: "a" });
    equal(plugin.selectedPath, "data/assets/clip.mp4");
  });

  test("a modified press is left for Obsidian", async () => {
    const { view } = await playing();
    equal(view.handleKey({ key: " ", ctrlKey: true }), false);
    equal(view.videoEl.paused, true);
  });

  test("a handled key is taken from the page", async () => {
    const { view } = await playing();
    let prevented = false;
    view.handleKey({ key: " ", preventDefault: () => (prevented = true) });
    equal(prevented, true);
  });
});

group("frame stepping", () => {
  test("comma and full stop step one frame either way", async () => {
    const { view } = await playing();
    view.videoEl.currentTime = 10;
    view.handleKey({ key: "." });
    close(view.videoEl.currentTime, 10 + VIDEO_FRAME_SECONDS, 1e-9);
    view.handleKey({ key: "," });
    close(view.videoEl.currentTime, 10, 1e-9);
  });

  test("the buttons do the same thing", async () => {
    const { view } = await playing();
    view.videoEl.currentTime = 10;
    view.stepForwardEl.fire("click");
    close(view.videoEl.currentTime, 10 + VIDEO_FRAME_SECONDS, 1e-9);
    view.stepBackEl.fire("click");
    close(view.videoEl.currentTime, 10, 1e-9);
  });

  test("stepping pauses first, because a step during playback is overtaken", async () => {
    const { view } = await playing();
    view.togglePlayback();
    equal(view.videoEl.paused, false);
    view.stepFrame(1);
    equal(view.videoEl.paused, true);
  });
});

group("the scrub bar", () => {
  test("follows the head as the video plays", async () => {
    const { view } = await playing();
    view.videoEl.currentTime = 30;
    view.videoEl.fire("timeupdate");
    equal(view.scrubEl.value, String(SCRUB_RESOLUTION / 2));
    equal(view.timeEl.textContent, "0:30 / 1:00");
  });

  test("dragging it seeks the video", async () => {
    const { view } = await playing();
    view.scrubEl.value = "250";
    view.scrubEl.fire("input");
    equal(view.videoEl.currentTime, 15);
  });

  test("a drag in progress is not written back underneath the pointer", async () => {
    const { view } = await playing();
    view.scrubEl.value = "800";
    view.scrubEl.fire("input");
    ok(view.scrubbing, "the drag is recorded");
    // The element's own timeupdate arrives mid-drag, reporting a position the
    // browser has not finished seeking to. The thumb must not jump back.
    view.videoEl.currentTime = 10;
    view.videoEl.fire("timeupdate");
    equal(view.scrubEl.value, "800");
  });

  test("and the bar takes over again once the drag ends", async () => {
    const { view } = await playing();
    view.scrubEl.value = "800";
    view.scrubEl.fire("input");
    view.scrubEl.fire("change");
    equal(view.scrubbing, false);
    view.videoEl.currentTime = 30;
    view.videoEl.fire("timeupdate");
    equal(view.scrubEl.value, String(SCRUB_RESOLUTION / 2));
  });

  test("a drag released outside the bar still ends", async () => {
    const { view } = await playing();
    view.scrubEl.fire("input");
    view.scrubEl.fire("pointerup");
    equal(view.scrubbing, false);
  });

  test("the readout shows hours once the file is long enough", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/clip.mp4");
    metadata(view, 3725);
    view.videoEl.currentTime = 3600;
    view.videoEl.fire("timeupdate");
    equal(view.timeEl.textContent, "1:00:00 / 1:02:05");
  });
});

group("the speed ladder", () => {
  test("clamps to the ends of the range rather than trusting a rate", () => {
    equal(core.clampSpeed(8), 4);
    equal(core.clampSpeed(0.1), 0.25);
    equal(core.clampSpeed(1.5), 1.5);
  });

  test("a nonsense or stopped rate reads as normal speed", () => {
    equal(core.clampSpeed(0), 1);
    equal(core.clampSpeed(-2), 1);
    equal(core.clampSpeed(NaN), 1);
    equal(core.clampSpeed(undefined), 1);
  });

  test("an off-ladder rate lands on the nearest rung, so the control shows one", () => {
    equal(core.nearestSpeed(1.3), 1.25);
    equal(core.nearestSpeed(2.6), 3);
    equal(core.nearestSpeed(0.01), 0.25);
    equal(core.nearestSpeed("2"), 2);
  });

  test("stepping moves one rung", () => {
    equal(core.stepSpeed(1, 1), 1.25);
    equal(core.stepSpeed(1, -1), 0.75);
    equal(core.stepSpeed(1, 3), 2);
  });

  test("and holds at the ends instead of wrapping", () => {
    equal(core.stepSpeed(4, 1), 4);
    equal(core.stepSpeed(0.25, -1), 0.25);
    equal(core.stepSpeed(1, 99), 4);
  });

  test("a step from between rungs starts at the nearest one", () => {
    equal(core.stepSpeed(1.3, 1), 1.5);
  });

  test("the labels drop trailing zeros", () => {
    deepEqual(SPEED_STEPS.map(core.formatSpeed), [
      "0.25x",
      "0.5x",
      "0.75x",
      "1x",
      "1.25x",
      "1.5x",
      "2x",
      "3x",
      "4x",
    ]);
  });
});

group("the speed control", () => {
  test("offers the whole ladder and starts at normal speed", async () => {
    const { view } = await playing();
    deepEqual(
      view.speedEl.children.map((option) => option.textContent),
      ["0.25x", "0.5x", "0.75x", "1x", "1.25x", "1.5x", "2x", "3x", "4x"]
    );
    equal(view.speedEl.value, "1");
    equal(view.videoEl.playbackRate, 1);
  });

  test("choosing a speed changes the rate on the element that plays", async () => {
    const { view } = await playing();
    view.speedEl.value = "2";
    view.speedEl.fire("change");
    equal(view.videoEl.playbackRate, 2);
    equal(view.playbackRate, 2);
  });

  test("shift-comma and shift-full-stop step it", async () => {
    const { view } = await playing();
    equal(view.handleKey({ key: ">" }), true);
    equal(view.videoEl.playbackRate, 1.25);
    view.handleKey({ key: "<" });
    view.handleKey({ key: "<" });
    equal(view.videoEl.playbackRate, 0.75);
    equal(view.speedEl.value, "0.75", "and the control follows the keyboard");
  });

  test("the speed is the pane's, so the next video keeps it", async () => {
    const { plugin, view } = await playing();
    view.setPlaybackRate(2);
    plugin.select("data/assets/other.webm");
    metadata(view, 30);
    equal(view.videoEl.playbackRate, 2);
    equal(view.speedEl.value, "2");
  });

  test("and it survives an image in between", async () => {
    const { plugin, view } = await playing();
    view.setPlaybackRate(0.5);
    plugin.select("data/assets/a.png");
    plugin.select("data/assets/clip.mp4");
    metadata(view, 60);
    equal(view.videoEl.playbackRate, 0.5);
  });

  test("a rate the element resets on load is reapplied when metadata arrives", async () => {
    const { plugin, view } = await playing();
    view.setPlaybackRate(3);
    plugin.select("data/assets/other.webm");
    view.videoEl.playbackRate = 1;
    metadata(view, 30);
    equal(view.videoEl.playbackRate, 3);
  });

  test("with no video open the control is disabled and the keys do nothing", async () => {
    const { view } = await paneOver(FILES);
    equal(view.speedEl.disabled, true);
    equal(view.stepPlaybackRate(1), false);
    equal(view.playbackRate, 1);
  });
});

group("hovering holds the video, scrolling steps it", () => {
  test("the pointer arriving on a playing video pauses it", async () => {
    const { view } = await playing();
    view.togglePlayback();
    view.stageEl.fire("pointerenter");
    equal(view.videoEl.paused, true);
    ok(view.hoverPaused, "and remembers that the pointer did it");
  });

  test("and the pointer leaving starts it again — a peek, not a stop", async () => {
    // Without the resume, crossing the pane on the way to something else would
    // silently halt playback and leave the user to work out why.
    const { view } = await playing();
    view.togglePlayback();
    view.stageEl.fire("pointerenter");
    view.stageEl.fire("pointerleave");
    equal(view.videoEl.paused, false);
    equal(view.hoverPaused, false);
  });

  test("hovering an already-paused video leaves it alone", async () => {
    const { view } = await playing();
    view.stageEl.fire("pointerenter");
    equal(view.hoverPaused, false);
    view.stageEl.fire("pointerleave");
    equal(view.videoEl.paused, true, "and leaving does not start it playing");
  });

  test("the wheel steps a frame forward as it scrolls down", async () => {
    const { view } = await playing();
    view.videoEl.currentTime = 10;
    view.stageEl.fire("wheel", { deltaY: 120 });
    close(view.videoEl.currentTime, 10 + VIDEO_FRAME_SECONDS, 1e-9);
    view.stageEl.fire("wheel", { deltaY: -120 });
    close(view.videoEl.currentTime, 10, 1e-9);
  });

  test("scrolling a playing video pauses it, which is what stepping means", async () => {
    const { view } = await playing();
    view.togglePlayback();
    view.stageEl.fire("wheel", { deltaY: 120 });
    equal(view.videoEl.paused, true);
  });

  test("a frame stepped to stays put when the pointer leaves", async () => {
    // The pointer may only undo what the pointer did. Scrolling is deliberate,
    // so it ends the peek and the frame the user chose survives.
    const { view } = await playing();
    view.togglePlayback();
    view.stageEl.fire("pointerenter");
    view.stageEl.fire("wheel", { deltaY: 120 });
    view.stageEl.fire("pointerleave");
    equal(view.videoEl.paused, true, "still on the chosen frame");
    equal(view.hoverPaused, false);
  });

  test("pressing play during a peek keeps control of the video", async () => {
    const { view } = await playing();
    view.togglePlayback();
    view.stageEl.fire("pointerenter");
    view.togglePlayback();
    equal(view.hoverPaused, false, "the peek is over");
    view.stageEl.fire("pointerleave");
    equal(view.videoEl.paused, false, "and leaving does not pause what the user started");
  });

  test("a seek during a peek does the same", async () => {
    const { view } = await playing();
    view.togglePlayback();
    view.stageEl.fire("pointerenter");
    view.handleKey({ key: "w" });
    view.stageEl.fire("pointerleave");
    equal(view.videoEl.paused, true, "the seeked-to position is kept");
  });

  test("the wheel still zooms an image", async () => {
    const { plugin, view } = await playing();
    plugin.select("data/assets/a.png");
    const img = view.imageEl;
    img.naturalWidth = 800;
    img.naturalHeight = 600;
    img.fire("load");
    const before = view.zoom;
    view.stageEl.fire("wheel", { deltaY: -120, clientX: 0, clientY: 0 });
    ok(view.zoom > before, "zoomed in rather than stepping a frame");
  });

  test("moving to another video ends any peek with it", async () => {
    const { plugin, view } = await playing();
    view.togglePlayback();
    view.stageEl.fire("pointerenter");
    plugin.select("data/assets/other.webm");
    equal(view.hoverPaused, false);
  });
});

group("the zoom controls in video mode", () => {
  test("the zoom readout is empty and its buttons are disabled", async () => {
    const { view } = await playing();
    equal(view.zoomEl.textContent, "");
    equal(view.fitEl.disabled, true);
    equal(view.fullEl.disabled, true);
  });

  test("and they come back for an image", async () => {
    const { plugin, view } = await playing();
    plugin.select("data/assets/a.png");
    equal(view.fitEl.disabled, false);
    equal(view.fullEl.disabled, false);
  });

  test("the wheel and a drag do nothing on a video", async () => {
    const { view } = await playing();
    view.handleWheel({ deltaY: -100, clientX: 0, clientY: 0 });
    equal(view.zoom, 1);
    view.handlePointerDown({ pointerId: 1, clientX: 0, clientY: 0 });
    equal(view.dragging, null);
  });
});

group("releasing the video", () => {
  test("navigating away pauses it, because a detached element keeps playing", async () => {
    const { plugin, view } = await playing();
    const video = view.videoEl;
    view.togglePlayback();
    plugin.select("data/assets/a.png");
    equal(video.paused, true);
    equal(video.src, "", "and its source is dropped so the fetch stops");
    ok(video.loadCount > 0, "load() after clearing src is what abandons the request");
  });

  test("closing the pane does the same", async () => {
    const { view } = await playing();
    const video = view.videoEl;
    view.togglePlayback();
    await view.onClose();
    equal(video.paused, true);
    equal(view.videoEl, null);
  });

  test("stepping from one video to the next releases the first", async () => {
    const { plugin, view } = await playing();
    const first = view.videoEl;
    plugin.select("data/assets/other.webm");
    ok(view.videoEl !== first, "a new element");
    equal(first.paused, true);
    equal(view.videoEl.src, "app://local/data/assets/other.webm?v=0");
  });

  test("a released element's late events are ignored", async () => {
    // A seek in flight when the user moves on still fires. Acting on it would
    // redraw the transport for a file that is no longer open.
    const { plugin, view } = await playing();
    const first = view.videoEl;
    plugin.select("data/assets/other.webm");
    metadata(view, 20);
    view.videoEl.currentTime = 10;
    view.videoEl.fire("timeupdate");
    first.duration = 999;
    first.currentTime = 500;
    first.fire("timeupdate");
    equal(view.timeEl.textContent, "0:10 / 0:20", "the open file, not the released one");
  });
});

group("a video written to underneath the viewer", () => {
  test("is re-read at the position it was left at", async () => {
    const { plugin, view, app } = await playing();
    view.videoEl.currentTime = 25;
    app.vault.version = 1;
    plugin.index.handleModify({ path: "data/assets/clip.mp4" });
    equal(view.videoEl.src, "app://local/data/assets/clip.mp4?v=1", "re-read");
    equal(view.pendingSeek, 25, "with the position held for the new metadata");
    // The reload restarts at zero; the pending seek is applied when the new
    // metadata arrives, which is the only moment currentTime will take it.
    view.videoEl.currentTime = 0;
    metadata(view, 60);
    equal(view.videoEl.currentTime, 25);
    equal(view.pendingSeek, null, "and is not applied twice");
  });

  test("a modify elsewhere in the folder leaves it alone", async () => {
    const { plugin, view, app } = await playing();
    view.videoEl.currentTime = 25;
    app.vault.version = 1;
    plugin.index.handleModify({ path: "data/assets/other.webm" });
    equal(view.videoEl.src, "app://local/data/assets/clip.mp4?v=0");
    equal(view.videoEl.currentTime, 25);
  });

  test("deleting the open video moves the viewer to its neighbour", async () => {
    const { plugin, view } = await playing();
    const video = view.videoEl;
    plugin.index.handleDelete({ path: "data/assets/clip.mp4" });
    equal(view.viewerPath, "data/assets/other.webm");
    equal(video.paused, true, "and the deleted one is released");
  });
});


/* Reverse playback — MV-REVERSE. There is no backwards in a video element, so
   this is a seek per animation frame, and the measured rate is as much the
   deliverable as the playback. */

group("playing backwards", () => {
  test("each frame walks the head back by the time the last one took", () => {
    // 100ms at 1x is a tenth of a second of video.
    close(core.reverseStep(10, 100, 1), 9.9, 1e-9);
    close(core.reverseStep(10, 100, 2), 9.8, 1e-9, "and the speed applies");
  });

  test("a stalled frame does not jump the head backwards", () => {
    // Without the clamp, one slow frame makes a stall look like a seek bug.
    close(core.reverseStep(60, 5000, 1), 59.75, 1e-9);
  });

  test("it stops at the start rather than going negative", () => {
    equal(core.reverseStep(0.05, 100, 1), 0);
    equal(core.reverseStep(0, 100, 1), 0);
  });

  test("nonsense in does not move the head", () => {
    equal(core.reverseStep(10, 0, 1), 10);
    equal(core.reverseStep(10, NaN, 1), 10);
    equal(core.reverseStep(NaN, 100, 1), 0);
  });

  test("the measured rate is frames over the time they took", () => {
    equal(core.measuredFrameRate(30, 1000), 30);
    equal(core.measuredFrameRate(6, 1000), 6);
    equal(core.measuredFrameRate(0, 0), 0, "and an unrun loop reports nothing rather than dividing");
  });

  test("R starts it, and the video is paused first", async () => {
    const { view } = await playing();
    view.videoEl.currentTime = 30;
    view.togglePlayback();
    equal(view.videoEl.paused, false);
    view.handleKey({ key: "r" });
    ok(view.reversing, "running");
    equal(view.videoEl.paused, true, "forward and reverse would fight over currentTime");
  });

  test("each animation frame moves the head back", async () => {
    const { view } = await playing();
    view.videoEl.currentTime = 30;
    view.startReverse();
    const before = view.videoEl.currentTime;
    // Backdated, because a test runs inside one millisecond and a frame that
    // took no time is deliberately a frame that moves nothing.
    view.reversing.last = Date.now() - 100;
    dom.runFrames();
    ok(view.videoEl.currentTime < before, "moved back");
  });

  test("playing forwards ends the run", async () => {
    const { view } = await playing();
    view.videoEl.currentTime = 30;
    view.startReverse();
    view.togglePlayback();
    equal(view.reversing, null);
  });

  test("reaching the start ends it, rather than looping", async () => {
    // Forward playback stops at the end rather than looping, and this is the
    // same rule at the other end of the file.
    const { view } = await playing();
    view.videoEl.currentTime = 0;
    view.startReverse();
    equal(view.reversing, null, "it stopped on the first step");
    equal(view.videoEl.currentTime, 0);
  });

  test("leaving the video ends it, so nothing seeks a released element", async () => {
    const { plugin, view } = await playing();
    view.videoEl.currentTime = 30;
    view.startReverse();
    plugin.select("data/assets/a.png");
    equal(view.reversing, null);
    equal(dom.runFrames(), 0, "and no frame is left queued");
  });

  test("with no video there is nothing to reverse", async () => {
    const { view } = await paneOver(FILES);
    equal(view.toggleReverse(), false);
  });
});

report("video");
