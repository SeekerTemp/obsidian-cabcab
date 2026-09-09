// Paths, timecodes, ranges, clips and the timeline strip. Everything here is
// pure, so none of it needs Obsidian, a video, or ffmpeg.
require("./stub-dom.js").installDom();
const { core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

group("paths", () => {
  test("splits a vault path into its parts", () => {
    equal(core.folderOf("data/media/walk.mp4"), "data/media");
    equal(core.baseNameOf("data/media/walk.mp4"), "walk.mp4");
    equal(core.stemOf("data/media/walk.mp4"), "walk");
    equal(core.extensionOf("data/media/walk.MP4"), "mp4");
  });

  test("a file at the vault root has no folder", () => {
    equal(core.folderOf("walk.mp4"), "");
    equal(core.joinPath("", "walk.mp4"), "walk.mp4");
  });

  test("backslashes are separators, because Windows hands them over", () => {
    equal(core.folderOf("data\\media\\walk.mp4"), "data/media");
    equal(core.baseNameOf("data\\media\\walk.mp4"), "walk.mp4");
  });

  test("a dotfile is not an extension", () => {
    equal(core.extensionOf(".gitignore"), "");
    equal(core.stemOf(".gitignore"), ".gitignore");
  });

  test("classifies what it can edit", () => {
    equal(core.classifyExtension("mp4"), "video");
    equal(core.classifyExtension("MKV"), "video");
    equal(core.classifyExtension("m4a"), "audio");
    equal(core.classifyExtension("png"), "other");
    equal(core.isVideoPath("a/b/clip.mov"), true);
    equal(core.isVideoPath("a/b/cover.png"), false);
  });

  test("only mp4-family containers get faststart", () => {
    equal(core.supportsFaststart("mp4"), true);
    equal(core.supportsFaststart("mov"), true);
    equal(core.supportsFaststart("mkv"), false);
    equal(core.supportsFaststart("webm"), false);
  });
});

group("derived paths", () => {
  const date = new Date(2026, 8, 9, 14, 5, 3);

  test("a trim lands beside its source, tagged and stamped", () => {
    equal(
      core.trimPathFor("data/media/walk.mp4", { date }),
      "data/media/walk+trim+260909140503.mp4"
    );
  });

  test("an output folder overrides the source's", () => {
    equal(
      core.trimPathFor("data/media/walk.mp4", { date, folder: "data/cuts" }),
      "data/cuts/walk+trim+260909140503.mp4"
    );
  });

  test("a name that is taken gets a numeric suffix, never an overwrite", () => {
    const taken = new Set(["data/media/walk+trim+260909140503.mp4"]);
    equal(
      core.trimPathFor("data/media/walk.mp4", { date, taken: (path) => taken.has(path) }),
      "data/media/walk+trim+260909140503-2.mp4"
    );
  });

  test("audio extraction changes the container", () => {
    equal(core.audioPathFor("data/media/walk.mp4", { date }), "data/media/walk+audio+260909140503.m4a");
  });

  test("a cut is tagged as one", () => {
    equal(core.cutPathFor("data/media/walk.mp4", { date }), "data/media/walk+cut+260909140503.mp4");
  });
});

group("timecodes", () => {
  test("drops the hours under an hour and keeps them over", () => {
    equal(core.formatTimecode(83), "01:23");
    equal(core.formatTimecode(3723), "01:02:03");
    equal(core.formatTimecode(83, { withHours: true }), "00:01:23");
  });

  test("milliseconds when asked, and only then", () => {
    equal(core.formatTimecode(83.25, { millis: true }), "01:23.250");
    equal(core.formatTimecode(83.25), "01:23");
  });

  test("a rounding carry does not produce 1000 milliseconds", () => {
    equal(core.formatTimecode(1.9996, { millis: true }), "00:02.000");
    equal(core.formatTimecode(59.9999, { millis: true }), "01:00.000");
  });

  test("an hour-long file reads as one", () => {
    equal(core.formatTimecode(3600), "01:00:00");
    equal(core.formatTimecode(3599.5, { millis: true }), "59:59.500");
  });

  test("parses back what it writes, and what a person types", () => {
    close(core.parseTimecode("01:02:03.500"), 3723.5, 1e-9);
    close(core.parseTimecode("02:03"), 123, 1e-9);
    close(core.parseTimecode("123.4"), 123.4, 1e-9);
    equal(core.parseTimecode("12"), 12);
  });

  test("refuses what it cannot read rather than answering zero", () => {
    // ffmpeg emits N/A before it knows, and a progress bar that reads that as
    // the start of the file jumps backwards.
    equal(core.parseTimecode("N/A"), null);
    equal(core.parseTimecode(""), null);
    equal(core.parseTimecode("later"), null);
  });
});

group("seeking", () => {
  test("clamps to the file, both ends", () => {
    equal(core.clampTime(-5, 100), 0);
    equal(core.clampTime(500, 100), 100);
    equal(core.clampTime(50, 100), 50);
  });

  test("a seek past the end stops at the end", () => {
    equal(core.seekTime(98, 5, 100), 100);
    equal(core.seekTime(2, -5, 100), 0);
  });

  test("a frame step uses the probed rate", () => {
    close(core.frameStepTime(10, 1, 25, 100), 10.04, 1e-9);
    close(core.frameStepTime(10, -2, 50, 100), 9.96, 1e-9);
  });

  test("without a rate it steps a thirtieth, not NaN", () => {
    // A step of "roughly one frame" is wrong by milliseconds. A step of NaN is
    // wrong by the whole file.
    close(core.frameStepTime(10, 1, null, 100), 10 + 1 / 30, 1e-9);
    ok(Number.isFinite(core.frameStepTime(10, 1, 0, 100)), "a zero frame rate still yields a number");
  });

  test("position and time are inverses", () => {
    close(core.positionForTime(30, 120), 0.25, 1e-9);
    close(core.timeForPosition(0.25, 120), 30, 1e-9);
    equal(core.positionForTime(30, 0), 0, "an unknown duration parks the playhead at the start");
  });
});

group("speed", () => {
  test("clamps to the offered range", () => {
    equal(core.clampSpeed(0.01), 0.25);
    equal(core.clampSpeed(99), 4);
    equal(core.clampSpeed("nonsense"), 1);
  });

  test("steps between the offered rates", () => {
    equal(core.stepSpeed(1, 1), 1.25);
    equal(core.stepSpeed(1, -1), 0.75);
    equal(core.stepSpeed(4, 1), 4, "the top step stays at the top");
  });
});

group("ranges", () => {
  test("a new file selects all of itself", () => {
    deepEqual(core.wholeRange(120), { start: 0, end: 120 });
  });

  test("dragging one handle past the other swaps them", () => {
    // Refusing the drag feels like the mouse stopped working.
    deepEqual(core.normaliseRange({ start: 80, end: 20 }, 120), { start: 20, end: 80 });
  });

  test("clamps to the duration", () => {
    deepEqual(core.normaliseRange({ start: -10, end: 500 }, 120), { start: 0, end: 120 });
  });

  test("a selection too short to be a clip is widened, not accepted", () => {
    const range = core.normaliseRange({ start: 10, end: 10 }, 120);
    ok(core.rangeDuration(range) >= core.MIN_RANGE_SECONDS, "widened to the minimum");
    equal(range.start, 10);
  });

  test("widening at the very end moves the start back instead of overrunning", () => {
    const range = core.normaliseRange({ start: 120, end: 120 }, 120);
    equal(range.end, 120);
    ok(range.start < 120, "the start moved back");
    ok(core.normaliseClip({ path: "a.mp4", start: range.start, end: range.end }), "still a usable clip");
  });

  test("setting one end leaves the other alone", () => {
    const range = { start: 10, end: 50 };
    deepEqual(core.withStart(range, 20, 120), { start: 20, end: 50 });
    deepEqual(core.withEnd(range, 90, 120), { start: 10, end: 90 });
  });

  test("splits at the playhead", () => {
    deepEqual(core.splitRange({ start: 10, end: 50 }, 30, 120), [
      { start: 10, end: 30 },
      { start: 30, end: 50 },
    ]);
  });

  test("refuses a split that would leave nothing", () => {
    equal(core.splitRange({ start: 10, end: 50 }, 5, 120), null, "outside the range");
    equal(core.splitRange({ start: 10, end: 50 }, 10.001, 120), null, "too close to the edge");
    equal(core.splitRange({ start: 10, end: 50 }, NaN, 120), null);
  });

  test("knows whether the playhead is inside", () => {
    equal(core.rangeContains({ start: 10, end: 50 }, 30), true);
    equal(core.rangeContains({ start: 10, end: 50 }, 60), false);
  });
});

group("clips", () => {
  const clip = (path, start, end, id) => ({ id: id || null, path, start, end });

  test("a clip carries its file, so a list can span several videos", () => {
    const made = core.clipFrom("a/walk.mp4", { start: 10, end: 20 }, { duration: 100, id: "clip-1" });
    deepEqual(made, { id: "clip-1", path: "a/walk.mp4", start: 10, end: 20 });
  });

  test("rejects a clip with no file or no length", () => {
    equal(core.normaliseClip(null), null);
    equal(core.normaliseClip({ path: "", start: 0, end: 5 }), null);
  });

  test("totals the list", () => {
    close(core.clipsDuration([clip("a.mp4", 0, 10), clip("b.mp4", 5, 12.5)]), 17.5, 1e-9);
  });

  test("reorders by moving one item", () => {
    const list = ["a", "b", "c"];
    deepEqual(core.moveItem(list, 0, 2), ["b", "c", "a"]);
    deepEqual(core.moveItem(list, 2, 0), ["c", "a", "b"]);
    deepEqual(list, ["a", "b", "c"], "the original is untouched");
  });

  test("a drag that ends nowhere changes nothing", () => {
    deepEqual(core.moveItem(["a", "b"], 0, 9), ["a", "b"]);
    deepEqual(core.moveItem(["a", "b"], -1, 1), ["a", "b"]);
  });

  test("removes by index", () => {
    deepEqual(core.removeAt(["a", "b", "c"], 1), ["a", "c"]);
    deepEqual(core.removeAt(["a"], 5), ["a"]);
  });

  test("selection follows the row that took the removed one's place", () => {
    equal(core.indexAfterRemoval(3, 0), 0);
    equal(core.indexAfterRemoval(3, 2), 1, "removing the last row selects the new last");
    equal(core.indexAfterRemoval(1, 0), -1, "nothing left to select");
  });

  test("labels a clip by its file and its span", () => {
    equal(core.clipLabel(clip("a/walk.mp4", 10, 20)), "walk.mp4  00:10.000 → 00:20.000");
  });
});

group("filmstrip", () => {
  test("the count comes from the width, not the duration", () => {
    // This is the whole reason a sixty-minute file is usable: the strip costs
    // the same as it does for a ten-second one.
    equal(core.filmstripCount(960, 96, 24), 10);
    equal(core.filmstripCount(4000, 96, 24), 24, "capped");
    equal(core.filmstripCount(50, 96, 24), 1, "always at least one");
    equal(core.filmstripCount(0, 96, 24), 0, "an unlaid-out pane asks for none");
  });

  test("each still stands for the middle of its cell", () => {
    // Taking the first still at t=0 puts the fade-in of a screen recording at
    // the front of every strip.
    deepEqual(core.filmstripTimes(100, 4), [12.5, 37.5, 62.5, 87.5]);
  });

  test("no duration, no strip", () => {
    deepEqual(core.filmstripTimes(0, 4), []);
    deepEqual(core.filmstripTimes(100, 0), []);
  });

  test("the ruler labels both ends and the gaps between", () => {
    const ticks = core.rulerTicks(3600, 7);
    equal(ticks.length, 7);
    equal(ticks[0].label, "00:00");
    equal(ticks[6].label, "01:00:00");
    close(ticks[3].position, 0.5, 1e-9);
  });
});

group("settings", () => {
  test("fills in what a fresh data.json does not have", () => {
    const settings = core.normaliseSettings(null);
    equal(settings.mode, core.MODE_COPY);
    equal(settings.noteFolder, core.DEFAULT_NOTE_FOLDER);
    equal(settings.filmstrip, true);
  });

  test("refuses a mode it does not have", () => {
    equal(core.normaliseSettings({ mode: "magic" }).mode, core.MODE_COPY);
    equal(core.normaliseSettings({ mode: "encode" }).mode, core.MODE_ENCODE);
  });

  test("clamps the quality and the strip length", () => {
    equal(core.normaliseSettings({ crf: -5 }).crf, 0);
    equal(core.normaliseSettings({ crf: 900 }).crf, 51);
    equal(core.normaliseSettings({ filmstripMax: 1 }).filmstripMax, 4);
    equal(core.normaliseSettings({ filmstripMax: 900 }).filmstripMax, 64);
  });

  test("an empty record folder falls back rather than writing to the vault root", () => {
    equal(core.normaliseSettings({ noteFolder: "   " }).noteFolder, core.DEFAULT_NOTE_FOLDER);
  });
});

report("video-editor core");
