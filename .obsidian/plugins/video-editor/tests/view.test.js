/* The pane, built against the DOM stub.
 *
 * Not a screenshot test — it asserts the behaviour that has a right answer:
 * that the in/out overlay covers what is excluded, that a key does what the
 * tooltip says, that a drag on the timeline moves the handle it grabbed, and
 * that a job cannot be started twice.
 */
const dom = require("./stub-dom.js").installDom();
const { VideoEditorView, FfmpegRunner, Filmstrip, core } = require("./load-plugin.js");
const { createFakeApp } = require("./fake-vault.js");
const { Notice } = require("./stub-obsidian.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const HOUR = 3600;

function makeView(options) {
  const settings = options || {};
  const vault = createFakeApp({ basePath: "/vault" });
  const file = vault.addFile(settings.path || "data/walk.mp4");
  const stills = [];
  const plugin = {
    settings: Object.assign({}, core.DEFAULT_SETTINGS, { filmstrip: false }, settings.settings || {}),
    runner: {
      available: settings.available === undefined ? true : settings.available,
      version: "7.1",
      async check() {
        return this.available;
      },
      async probe() {
        return settings.info === undefined ? { duration: HOUR, width: 1920, height: 1080, fps: 30 } : settings.info;
      },
      async still(path, time) {
        stills.push(time);
        return Buffer.from([1, 2, 3]);
      },
      killAll() {},
    },
    exporter: {
      absolute: (path) => "/vault/" + path,
      calls: [],
      async trim(path, range, opts) {
        plugin.exporter.calls.push({ kind: "trim", path, range });
        if (settings.jobWork) await settings.jobWork(opts);
        return { path: "data/walk+trim+1.mp4", file: null };
      },
      async exportClips(clips, opts) {
        plugin.exporter.calls.push({ kind: "export", clips });
        if (settings.jobWork) await settings.jobWork(opts);
        return { path: "data/walk+cut+1.mp4", file: null };
      },
      async extractAudio(path, range) {
        plugin.exporter.calls.push({ kind: "audio", path, range });
        return { path: "data/walk+audio+1.m4a", file: null };
      },
    },
  };
  const leaf = { app: vault.app, updateHeader() {} };
  const view = new VideoEditorView(leaf, plugin);
  view.app = vault.app;
  return { view, plugin, vault, file, stills };
}

// The stub cannot lay anything out, so a test that drags says how wide the
// timeline is. 1000px over an hour is one pixel a second, which makes the
// arithmetic in the assertions readable.
// The stub keeps text on the element that was given it, so a row’s text is
// spread across its children. This is what a person reads off the row.
function textOf(element) {
  if (!element) return "";
  const own = element.text || "";
  return own + (element.children || []).map(textOf).join(" ");
}

function layOut(view, width) {
  view.timelineEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: width || 1000, height: 56 });
  view.timelineEl.clientWidth = width || 1000;
}

async function openView(options) {
  const made = makeView(options);
  await made.view.onOpen();
  return made;
}

group("building", () => {
  test("draws a stage, a timeline and a clip list", async () => {
    const { view } = await openView();
    ok(view.videoEl, "a video element");
    ok(view.timelineEl, "a timeline");
    ok(view.clipListEl, "a clip list");
    ok(view.toolbarEl, "and the floating toolbar");
  });

  test("says so when ffmpeg is missing, rather than failing at the first cut", async () => {
    const { view } = await openView({ available: false });
    ok(view.binaryEl.text.includes("missing"));
    ok(view.binaryEl.hasClass("is-missing"));
  });

  test("names the version when it is there", async () => {
    const { view } = await openView();
    ok(view.binaryEl.text.includes("7.1"));
    ok(view.binaryEl.hasClass("is-ok"));
  });

  test("opens with nothing loaded and does not pretend otherwise", async () => {
    const { view } = await openView();
    equal(view.file, null);
    equal(view.session.path, null);
  });
});

group("opening a video", () => {
  test("probes it, because the element knows no frame rate", async () => {
    // Frame-stepping without a frame rate is a guess.
    const { view, file } = await openView();
    await view.openFile(file);
    equal(view.session.duration, HOUR);
    equal(view.session.fps, 30);
    equal(view.videoEl.src, "app://fake/data/walk.mp4");
  });

  test("selects the whole file to begin with", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    deepEqual(view.session.range, { start: 0, end: HOUR });
  });

  test("a file ffprobe cannot read still opens, and says why it is rougher", async () => {
    Notice.messages.length = 0;
    const { view, file } = await openView({ info: null });
    await view.openFile(file);
    ok(Notice.messages.some((message) => message.includes("ffprobe could not read")));
    equal(view.session.duration, 0, "and nothing pretends to know the length");
  });

  test("falls back to the element's own metadata when ffprobe said nothing", async () => {
    const { view, file } = await openView({ info: null });
    await view.openFile(file);
    view.videoEl.duration = 120;
    view.videoEl.videoWidth = 640;
    view.videoEl.videoHeight = 360;
    view.videoEl.fire("loadedmetadata");
    equal(view.session.duration, 120, "something to scrub with beats a dead pane");
  });
});

group("the timeline", () => {
  test("dims what is excluded at both ends", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    view.session.setRange({ start: HOUR * 0.2, end: HOUR * 0.6 });
    equal(view.beforeEl.style.width, "20%");
    equal(view.afterEl.style.width, "40%");
    equal(view.rangeEl.style.width, "40%");
  });

  test("a drag on the start handle moves the start and leaves the end", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    layOut(view, 1000);
    view.session.setRange({ start: 600, end: 1800 });
    view.startHandleEl.fire("pointerdown", { clientX: 300, preventDefault() {}, stopPropagation() {} });
    close(view.session.range.start, 1080, 1, "300px of 1000 over an hour");
    close(view.session.range.end, 1800, 1e-9, "the other end did not move");
    dom.fireDocument("pointerup", {});
  });

  test("a drag that leaves the strip keeps tracking, because a drag that stops fights the user", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    layOut(view, 1000);
    view.endHandleEl.fire("pointerdown", { clientX: 900, preventDefault() {}, stopPropagation() {} });
    dom.fireDocument("pointermove", { clientX: 950 });
    close(view.session.range.end, 3420, 1);
    dom.fireDocument("pointerup", {});
  });

  test("a drag past the far handle swaps the two rather than refusing", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    layOut(view, 1000);
    view.session.setRange({ start: 1800, end: 2400 });
    view.endHandleEl.fire("pointerdown", { clientX: 100, preventDefault() {}, stopPropagation() {} });
    ok(view.session.range.start < view.session.range.end);
    close(view.session.range.start, 360, 1);
    dom.fireDocument("pointerup", {});
  });

  test("clicking the strip moves the playhead, not a handle", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    layOut(view, 1000);
    const before = Object.assign({}, view.session.range);
    view.timelineEl.fire("pointerdown", { clientX: 500, preventDefault() {} });
    close(view.videoEl.currentTime, 1800, 1);
    deepEqual(view.session.range, before, "the selection was left alone");
    dom.fireDocument("pointerup", {});
  });

  test("the ruler labels an hour in hours", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    equal(view.rulerEl.children.length, 7);
    equal(view.rulerEl.children[6].text, "01:00:00");
  });
});

group("the filmstrip", () => {
  test("asks for a fixed number of stills, whatever the duration", async () => {
    // The whole reason a sixty-minute file is usable: the strip costs what it
    // costs for a ten-second one.
    const { view, file, stills } = await openView({ settings: { filmstrip: true, filmstripMax: 8 } });
    layOut(view, 800);
    await view.openFile(file);
    /* openFile does not wait for the strip — a pane that blocked until 24
       ffmpeg seeks finished would take seconds to show a video it can already
       play. So the test waits where the pane does not, counting only the run
       it waited for: the one openFile started is superseded partway through,
       which is itself the behaviour that keeps a fast folder-switch cheap. */
    stills.length = 0;
    await view.rebuildFilmstrip();
    equal(stills.length, 8);
    close(stills[0], HOUR / 16, 1, "the middle of the first cell, not its edge");
  });

  test("releases its object URLs, rather than leaking one per resize", async () => {
    const { view, file } = await openView({ settings: { filmstrip: true, filmstripMax: 4 } });
    layOut(view, 400);
    const before = dom.liveUrls.size;
    await view.openFile(file);
    await view.rebuildFilmstrip();
    ok(dom.liveUrls.size > before, "stills were drawn");
    view.filmstrip.clear();
    equal(dom.liveUrls.size, before, "and every one of them was released");
  });

  test("is skipped entirely when there is no ffmpeg to ask", async () => {
    const { view, file, stills } = await openView({ available: false, settings: { filmstrip: true } });
    await view.openFile(file);
    await view.rebuildFilmstrip();
    equal(stills.length, 0);
  });
});

group("keys", () => {
  async function ready() {
    const made = await openView();
    await made.view.openFile(made.file);
    made.view.session.setRange({ start: 600, end: 1800 });
    made.view.videoEl.currentTime = 900;
    return made;
  }

  test("I and O set the points the toolbar says they do", async () => {
    const { view } = await ready();
    view.handleKey({ key: "i" });
    close(view.session.range.start, 900, 1e-9);
    view.videoEl.currentTime = 1200;
    view.handleKey({ key: "O" });
    close(view.session.range.end, 1200, 1e-9);
  });

  test("the arrows seek five seconds", async () => {
    const { view } = await ready();
    view.handleKey({ key: "ArrowRight" });
    close(view.videoEl.currentTime, 905, 1e-9);
    view.handleKey({ key: "ArrowLeft" });
    close(view.videoEl.currentTime, 900, 1e-9);
  });

  test("comma and full stop step one frame", async () => {
    const { view } = await ready();
    view.handleKey({ key: "." });
    close(view.videoEl.currentTime, 900 + 1 / 30, 1e-9);
  });

  test("with shift they change speed instead", async () => {
    const { view } = await ready();
    view.handleKey({ key: ".", shiftKey: true });
    equal(view.speed, 1.25);
    equal(view.videoEl.playbackRate, 1.25);
  });

  test("C adds a clip and S splits at the playhead", async () => {
    const { view } = await ready();
    view.handleKey({ key: "c" });
    equal(view.session.clips.length, 1);
    view.handleKey({ key: "s" });
    equal(view.session.clips.length, 3, "a split adds both halves");
  });

  test("a key it does not own is left alone", async () => {
    const { view } = await ready();
    equal(view.handleKey({ key: "z" }), false);
  });
});

group("playing", () => {
  test("stops at the out point, so the excluded part is not judged as included", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    view.session.setRange({ start: 100, end: 200 });
    view.videoEl.paused = false;
    view.videoEl.currentTime = 210;
    view.videoEl.fire("timeupdate");
    equal(view.videoEl.paused, true);
    close(view.videoEl.currentTime, 200, 1e-9);
  });

  test("pressing play outside the selection starts at the in point", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    view.session.setRange({ start: 100, end: 200 });
    view.videoEl.currentTime = 3000;
    view.togglePlay();
    close(view.videoEl.currentTime, 100, 1e-9);
  });
});

group("the clip list", () => {
  async function withClips() {
    const made = await openView();
    await made.view.openFile(made.file);
    made.view.session.setRange({ start: 10, end: 40 });
    made.view.session.addClip();
    made.view.session.setRange({ start: 100, end: 130 });
    made.view.session.addClip();
    return made;
  }

  test("draws one row per clip, with its span", async () => {
    const { view } = await withClips();
    equal(view.clipListEl.children.length, 2);
    ok(textOf(view.clipListEl.children[0]).includes("00:10.000"));
    ok(textOf(view.clipListEl.children[0]).includes("walk.mp4"));
  });

  test("counts them on the export button, so the button says what it will do", async () => {
    const { view } = await withClips();
    ok(textOf(view.exportButton).includes("2 clips"));
  });

  test("export is disabled with nothing to export", async () => {
    const { view } = await openView();
    equal(view.exportButton.disabled, true);
  });

  test("removing a row leaves the rest", async () => {
    const { view } = await withClips();
    const remove = view.clipListEl.children[0].children[1];
    remove.fire("click", { stopPropagation() {} });
    equal(view.session.clips.length, 1);
    close(view.session.clips[0].start, 100, 1e-9);
  });

  test("dropping one row on another reorders the list", async () => {
    const { view } = await withClips();
    const data = { getData: () => "0", setData() {} };
    view.clipListEl.children[1].fire("drop", { preventDefault() {}, dataTransfer: data });
    deepEqual(view.session.clips.map((clip) => clip.start), [100, 10]);
  });
});

group("jobs", () => {
  test("a trim hands the exporter the selection", async () => {
    const { view, file, plugin } = await openView();
    await view.openFile(file);
    view.session.setRange({ start: 718, end: 800.5 });
    await view.runTrim();
    equal(plugin.exporter.calls[0].kind, "trim");
    close(plugin.exporter.calls[0].range.start, 718, 1e-9);
  });

  test("only one at a time, because two ffmpegs on one disk finish later than one", async () => {
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { view, file, plugin } = await openView({ jobWork: () => gate });
    await view.openFile(file);
    Notice.messages.length = 0;
    const first = view.runTrim();
    const second = view.runTrim();
    await second;
    ok(Notice.messages.some((message) => message.includes("One job at a time")));
    release();
    await first;
    equal(plugin.exporter.calls.length, 1);
  });

  test("refuses to start with no ffmpeg, and says where to fix it", async () => {
    Notice.messages.length = 0;
    const { view, file, plugin } = await openView({ available: false });
    await view.openFile(file);
    await view.runTrim();
    equal(plugin.exporter.calls.length, 0);
    ok(Notice.messages.some((message) => message.includes("not found")));
  });

  test("an export with an empty list is refused before anything spawns", async () => {
    Notice.messages.length = 0;
    const { view, file, plugin } = await openView();
    await view.openFile(file);
    await view.runExport();
    equal(plugin.exporter.calls.length, 0);
    ok(Notice.messages.some((message) => message.includes("at least one clip")));
  });

  test("cancelling flips the signal the exporter is watching", async () => {
    let seen = null;
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { view, file } = await openView({
      jobWork: (opts) => {
        seen = opts.signal;
        return gate;
      },
    });
    await view.openFile(file);
    const running = view.runTrim();
    // The slot is claimed before anything is awaited, so it is here to cancel
    // even though ffmpeg has not been reached yet.
    const signal = view.job.signal;
    view.cancelJob();
    equal(signal.cancelled, true);
    release();
    await running;
    equal(seen, signal, "and it is the same box the exporter was handed");
  });

  test("progress reaches the bar as a percentage", async () => {
    const { view, file } = await openView();
    await view.openFile(file);
    view.session.setRange({ start: 0, end: 100 });
    view.job = { label: "Trim", signal: { cancelled: false } };
    view.onJobProgress({ percent: 0.42, speed: 8, label: "Trimming" });
    equal(view.progressFillEl.style.width, "42%");
    ok(view.progressLabelEl.text.includes("42%"));
    ok(view.progressLabelEl.text.includes("left"), "and an estimate of what is left");
  });

  test("the bar goes quiet between jobs rather than disappearing", async () => {
    // Otherwise the layout jumps every time one finishes.
    const { view } = await openView();
    view.renderProgress(null);
    ok(view.progressEl.hasClass("is-idle"));
    equal(view.progressLabelEl.text, "");
  });
});

report("video-editor view");
