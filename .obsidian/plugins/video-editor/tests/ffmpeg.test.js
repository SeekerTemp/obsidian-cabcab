/* What ffmpeg is going to be told, and what it says back.
 *
 * The thing hardest to test by running it — a native binary over a 60-minute
 * file — is easiest to test by reading the arguments before they are sent.
 * This suite is why the argument builders are pure functions.
 */
require("./stub-dom.js").installDom();
const { core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const at = (args, flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};

group("seconds", () => {
  test("plain decimal, never exponent notation", () => {
    // String(1e-7) is "1e-7", which ffmpeg reads as one second.
    equal(core.secondsArg(0.0000001), "0");
    equal(core.secondsArg(12.5), "12.5");
    equal(core.secondsArg(10), "10");
    equal(core.secondsArg(3599.999), "3599.999");
  });

  test("a negative or missing start is zero, not a broken argument", () => {
    equal(core.secondsArg(-5), "0");
    equal(core.secondsArg(NaN), "0");
  });
});

group("trim arguments", () => {
  const base = { input: "/vault/walk.mp4", output: "/vault/walk+trim.mp4", start: 900, duration: 30 };

  test("seeks before the input, which is what makes an hour-long file usable", () => {
    // -ss after -i decodes and discards everything before the cut. On a
    // sixty-minute walkthrough that is minutes rather than seconds.
    const args = core.trimArgs(Object.assign({}, base, { mode: core.MODE_COPY }));
    ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss comes before -i");
    equal(at(args, "-ss"), "900");
    equal(at(args, "-i"), "/vault/walk.mp4");
  });

  test("asks for a duration rather than an end time", () => {
    // What -to is relative to has changed between ffmpeg releases when input
    // seeking is in play. A duration has not.
    const args = core.trimArgs(base);
    equal(at(args, "-t"), "30");
    equal(args.includes("-to"), false);
  });

  test("a cut at zero omits the seek entirely", () => {
    const args = core.trimArgs(Object.assign({}, base, { start: 0 }));
    equal(args.includes("-ss"), false);
  });

  test("stream copy rebases timestamps", () => {
    const args = core.trimArgs(Object.assign({}, base, { mode: core.MODE_COPY }));
    ok(args.join(" ").includes("-c copy"), "copies the streams");
    equal(at(args, "-avoid_negative_ts"), "make_zero");
  });

  test("re-encode names a codec, a quality and a pixel format", () => {
    const args = core.trimArgs(Object.assign({}, base, { mode: core.MODE_ENCODE, crf: 18, preset: "slow" }));
    equal(at(args, "-c:v"), "libx264");
    equal(at(args, "-crf"), "18");
    equal(at(args, "-preset"), "slow");
    equal(at(args, "-pix_fmt"), "yuv420p", "the profile Electron's Chromium always plays");
    equal(at(args, "-c:a"), "aac");
  });

  test("muting drops the audio in either mode", () => {
    ok(core.trimArgs(Object.assign({}, base, { mode: core.MODE_COPY, mute: true })).includes("-an"));
    ok(core.trimArgs(Object.assign({}, base, { mode: core.MODE_ENCODE, mute: true })).includes("-an"));
  });

  test("faststart follows the container, not the mode", () => {
    ok(core.trimArgs(base).includes("-movflags"), "mp4 gets it");
    equal(core.trimArgs(Object.assign({}, base, { output: "/v/out.mkv" })).includes("-movflags"), false);
  });

  test("progress goes to stdout so stderr stays only errors", () => {
    const args = core.trimArgs(base);
    equal(at(args, "-progress"), "pipe:1");
    ok(args.includes("-nostats"));
    ok(args.includes("-nostdin"), "without this a run that hits a prompt hangs forever");
  });

  test("the output is last, and unquoted — spawn takes an array", () => {
    const args = core.trimArgs(Object.assign({}, base, { output: "/vault/my videos/out.mp4" }));
    equal(args[args.length - 1], "/vault/my videos/out.mp4");
  });

  test("a zero-length request is widened rather than sent", () => {
    equal(at(core.trimArgs(Object.assign({}, base, { duration: 0 })), "-t"), core.secondsArg(core.MIN_RANGE_SECONDS));
  });
});

group("concat list", () => {
  test("one quoted line per file", () => {
    equal(
      core.concatListText(["/tmp/a.mp4", "/tmp/b.mp4"]),
      "file '/tmp/a.mp4'\nfile '/tmp/b.mp4'\n"
    );
  });

  test("a quote in a path is escaped the demuxer's way, not the shell's", () => {
    equal(core.concatListText(["/tmp/o'brien.mp4"]), "file '/tmp/o'\\''brien.mp4'\n");
  });

  test("backslashes become slashes, because the demuxer reads them as escapes", () => {
    equal(core.concatListText(["C:\\Temp\\a.mp4"]), "file 'C:/Temp/a.mp4'\n");
  });

  test("an empty list is empty text, not a file with a blank line", () => {
    equal(core.concatListText([]), "");
  });
});

group("concat arguments", () => {
  test("names the demuxer and turns off the safety that refuses absolute paths", () => {
    const args = core.concatArgs({ listPath: "/tmp/list.txt", output: "/v/out.mp4", mode: core.MODE_COPY });
    equal(at(args, "-f"), "concat");
    equal(at(args, "-safe"), "0");
    equal(at(args, "-i"), "/tmp/list.txt");
    ok(args.join(" ").includes("-c copy"));
  });
});

group("still arguments", () => {
  test("seeks first, takes one frame, and pipes it out", () => {
    const args = core.stillArgs({ input: "/v/walk.mp4", time: 1800, height: 90 });
    ok(args.indexOf("-ss") < args.indexOf("-i"));
    equal(at(args, "-frames:v"), "1");
    equal(at(args, "-vf"), "scale=-2:90", "-2 keeps the aspect and forces an even width");
    equal(args[args.length - 1], "pipe:1", "no temp file per still");
  });
});

group("audio arguments", () => {
  test("drops the video and names a codec", () => {
    const args = core.audioArgs({ input: "/v/walk.mp4", output: "/v/walk.m4a", start: 10, duration: 5 });
    ok(args.includes("-vn"));
    equal(at(args, "-c:a"), "aac");
    equal(at(args, "-t"), "5");
  });

  test("without a duration it takes the rest of the file", () => {
    equal(core.audioArgs({ input: "a", output: "b", start: 0 }).includes("-t"), false);
  });
});

group("ffprobe output", () => {
  const sample = JSON.stringify({
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", r_frame_rate: "1000/1" },
      { codec_type: "audio", codec_name: "aac" },
    ],
    format: { duration: "3492.500000", bit_rate: "2500000", size: "1091406250" },
  });

  test("reads the six facts the pane needs", () => {
    const info = core.parseProbeOutput(sample);
    close(info.duration, 3492.5, 1e-9);
    equal(info.width, 1920);
    equal(info.height, 1080);
    close(info.fps, 30000 / 1001, 1e-9);
    equal(info.videoCodec, "h264");
    equal(info.hasAudio, true);
  });

  test("prefers the average frame rate over the base one", () => {
    // r_frame_rate on a variable-rate screen recording is often a wild 1000/1,
    // and frame-stepping by a thousandth of a second is not a frame step.
    close(core.parseProbeOutput(sample).fps, 29.97, 0.01);
  });

  test("a file with no streams is not a file this can edit", () => {
    equal(core.parseProbeOutput(JSON.stringify({ streams: [], format: {} })), null);
  });

  test("unparseable output returns null rather than a duration of NaN", () => {
    equal(core.parseProbeOutput("not json"), null);
    equal(core.parseProbeOutput(""), null);
  });

  test("an audio-only file still reports a duration", () => {
    const info = core.parseProbeOutput(
      JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac", duration: "12.5" }], format: {} })
    );
    close(info.duration, 12.5, 1e-9);
    equal(info.hasVideo, false);
  });
});

group("fractions", () => {
  test("reads what ffprobe writes", () => {
    close(core.parseFraction("30000/1001"), 29.970029970029973, 1e-9);
    equal(core.parseFraction("25/1"), 25);
    equal(core.parseFraction("50"), 50);
  });

  test("refuses the shapes that mean 'unknown'", () => {
    equal(core.parseFraction("0/0"), null);
    equal(core.parseFraction("25/0"), null);
    equal(core.parseFraction(""), null);
  });
});

group("progress", () => {
  test("reads a whole block", () => {
    const block = [
      "frame=1200",
      "fps=240.0",
      "out_time_us=40000000",
      "out_time=00:00:40.000000",
      "speed=8.02x",
      "progress=continue",
      "",
    ].join("\n");
    const progress = core.parseProgress(block);
    close(progress.seconds, 40, 1e-9);
    close(progress.speed, 8.02, 1e-9);
    equal(progress.frame, 1200);
    equal(progress.done, false);
  });

  test("out_time_ms is microseconds too, despite the name", () => {
    // It has been misnamed since it was added. Reading both the same way is
    // what keeps the bar right on builds that emit only one of them.
    close(core.parseProgress("out_time_ms=90000000\nprogress=continue").seconds, 90, 1e-9);
  });

  test("notices the end of a job", () => {
    equal(core.parseProgress("progress=end").done, true);
  });

  test("a block that says nothing useful reports nulls, not zeros", () => {
    // A caller that reset the bar to zero on every partial block would make it
    // flicker for the whole hour.
    const progress = core.parseProgress("out_time=N/A\nspeed=N/A\nprogress=continue");
    equal(progress.seconds, null);
    equal(progress.speed, null);
  });

  test("a percentage never leaves 0..1", () => {
    close(core.progressPercent(30, 120), 0.25, 1e-9);
    equal(core.progressPercent(500, 120), 1);
    equal(core.progressPercent(30, 0), 0);
  });
});

group("time remaining", () => {
  test("comes from ffmpeg's own speed figure", () => {
    // speed is output seconds per wall second, so what is left over it is the
    // wall time left.
    close(core.etaSeconds(600, 3600, 2), 1500, 1e-9);
  });

  test("says nothing until there is a speed to say it from", () => {
    equal(core.etaSeconds(0, 3600, null), null);
    equal(core.etaSeconds(0, 3600, 0), null);
    equal(core.etaSeconds(0, 0, 5), null);
  });

  test("is coarse on purpose", () => {
    equal(core.formatEta(4), "a few seconds left");
    equal(core.formatEta(42), "40s left");
    equal(core.formatEta(600), "10 min left");
    equal(core.formatEta(5400), "1h 30m left");
  });
});

group("export plan", () => {
  const clips = [
    { id: "a", path: "data/walk.mp4", start: 10, end: 40 },
    { id: "b", path: "data/walk.mp4", start: 100, end: 130 },
    { id: "c", path: "data/login.mkv", start: 0, end: 60 },
  ];

  test("one segment per clip, in order, with its own temp name", () => {
    const plan = core.exportPlan(clips);
    equal(plan.segments.length, 3);
    equal(plan.segments[0].temp, "ve-seg-000.mp4");
    equal(plan.segments[2].temp, "ve-seg-002.mkv", "each piece keeps its own source's container");
    close(plan.totalSeconds, 120, 1e-9);
    equal(plan.needsConcat, true);
    equal(plan.steps, 4, "three trims and a join");
  });

  test("re-encoding names one container for the whole plan", () => {
    // Because then every piece really is the same thing, and the join cannot
    // fail on a codec the container will not hold.
    const plan = core.exportPlan(clips, { extension: "mp4" });
    equal(plan.segments[2].temp, "ve-seg-002.mp4");
  });

  test("lists the distinct sources, which is what a copy-join can fail on", () => {
    deepEqual(core.exportPlan(clips).sources, ["data/walk.mp4", "data/login.mkv"]);
  });

  test("one clip needs no join", () => {
    const plan = core.exportPlan([clips[0]]);
    equal(plan.needsConcat, false);
    equal(plan.steps, 1);
  });

  test("clips too short to cut are dropped before ffmpeg sees them", () => {
    equal(core.exportPlan([{ path: "a.mp4", start: 5, end: 5.001 }]).segments.length, 0);
    equal(core.exportPlan([]).segments.length, 0);
  });
});

group("export progress", () => {
  const plan = core.exportPlan([
    { path: "a.mp4", start: 0, end: 30 },
    { path: "a.mp4", start: 0, end: 90 },
  ]);

  test("starts at nothing and ends at everything", () => {
    equal(core.progressAcross(plan, 0, 0), 0);
    close(core.progressAcross(plan, 2, plan.totalSeconds), 1, 1e-9);
  });

  test("weights each clip by the seconds it produces", () => {
    // Otherwise a three-second clip takes as much of the bar as a three-minute
    // one, and the bar stalls at 50% for the whole second half.
    const totalWork = plan.totalSeconds * (1 + core.CONCAT_WEIGHT);
    close(core.progressAcross(plan, 1, 0), 30 / totalWork, 1e-9);
    close(core.progressAcross(plan, 1, 45), 75 / totalWork, 1e-9);
  });

  test("never reports more than the step it is on can account for", () => {
    const capped = core.progressAcross(plan, 0, 9999);
    close(capped, 30 / (plan.totalSeconds * (1 + core.CONCAT_WEIGHT)), 1e-9);
  });

  test("an empty plan is zero, not a division by zero", () => {
    equal(core.progressAcross(core.exportPlan([]), 0, 0), 0);
    equal(core.progressAcross(null, 0, 0), 0);
  });
});

group("errors", () => {
  test("keeps the last lines a person can act on", () => {
    const stderr = [
      "[concat @ 0x1] Unsafe file name",
      "out_time_us=100",
      "Error opening input files",
      "Conversion failed!",
    ].join("\n");
    equal(core.ffmpegErrorSummary(stderr, 2), "Error opening input files — Conversion failed!");
  });

  test("drops progress lines that leaked into stderr", () => {
    equal(core.ffmpegErrorSummary("out_time_us=1\nspeed=2x"), "");
  });

  test("a failure says what ffmpeg said, not what it returned", () => {
    // ffmpeg returns its AVERROR as an exit code, which Windows reports
    // unsigned: a corrupt input comes back as "exited 3199971767".
    equal(
      core.runFailureMessage("ffmpeg", 3199971767, "Error opening input files: Invalid data found"),
      "ffmpeg failed: Error opening input files: Invalid data found"
    );
  });

  test("but the code is still shown when ffmpeg said nothing at all", () => {
    equal(core.runFailureMessage("ffmpeg", 137, ""), "ffmpeg exited 137");
  });

  test("says where it looked when the binary is missing", () => {
    ok(core.missingBinaryMessage("ffmpeg", "").includes("PATH"));
    ok(core.missingBinaryMessage("ffmpeg", "C:/tools/ffmpeg.exe").includes("C:/tools/ffmpeg.exe"));
  });

  test("names the binary the platform actually has", () => {
    equal(core.binaryName("ffmpeg", "win32"), "ffmpeg.exe");
    equal(core.binaryName("ffmpeg", "darwin"), "ffmpeg");
  });
});

group("sizes", () => {
  test("reads as a person would say it", () => {
    equal(core.formatBytes(512), "512 B");
    equal(core.formatBytes(1536), "1.5 KB");
    equal(core.formatBytes(1091406250), "1 GB");
  });
});

report("video-editor ffmpeg");
