/* End-to-end against a real ffmpeg.
 *
 *   node tests/smoke.js
 *
 * Not part of `tests/all.js`, and deliberately: the other suites run anywhere
 * with no binary, and that is what makes them worth running on every change.
 * This one needs ffmpeg and takes a couple of minutes, because it builds a
 * **60-minute** video and cuts it.
 *
 * What it is for is the half the fakes cannot reach. A fake child process will
 * happily accept an argument list that real ffmpeg rejects, and every "the
 * arguments say X" assertion in ffmpeg.test.js is only worth as much as the
 * claim that X is what ffmpeg does. This checks that claim, including the one
 * the whole design rests on: that seeking before the input makes an hour-long
 * file cheap to cut.
 *
 * It exits non-zero on failure, so it can be driven by something other than a
 * person reading it.
 */
require("./stub-dom.js").installDom();
const { FfmpegRunner, core } = require("./load-plugin.js");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOUR = 3600;
const results = { passed: 0, failed: 0 };

function check(label, condition, detail) {
  if (condition) {
    results.passed += 1;
    console.log("  ok    " + label + (detail ? "  (" + detail + ")" : ""));
    return true;
  }
  results.failed += 1;
  console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : ""));
  return false;
}

function near(label, actual, expected, tolerance, detail) {
  const ok = Math.abs(Number(actual) - Number(expected)) <= tolerance;
  return check(
    label,
    ok,
    (detail ? detail + ", " : "") + "got " + Number(actual).toFixed(3) + ", wanted " + expected + " ±" + tolerance
  );
}

// The runner the plugin uses, pointed at the plugin's own bin/ the way the
// plugin points it — so this also proves the bundled-binary lookup works.
const pluginFolder = path.join(__dirname, "..");
const runner = new FfmpegRunner({
  getSettings: () => core.DEFAULT_SETTINGS,
  bundledFolder: () => pluginFolder,
});

async function main() {
  console.log("Video Editor — end-to-end against a real ffmpeg\n");

  if (!(await runner.check())) {
    console.log(core.missingBinaryMessage("ffmpeg", "", pluginFolder));
    console.log("\nSkipped: nothing to test against.");
    return;
  }
  const source = runner.sourceOf("ffmpeg");
  console.log("ffmpeg " + runner.version);
  console.log("found via: " + source.kind + " — " + source.path + "\n");

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "video-editor-smoke-"));
  try {
    await run(work);
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (error) {
      console.log("  (could not clear " + work + ")");
    }
  }

  console.log("");
  console.log(results.failed ? results.passed + " passed, " + results.failed + " FAILED" : results.passed + " passed");
  if (results.failed) process.exitCode = 1;
}

async function run(work) {
  const input = path.join(work, "walkthrough.mp4");

  /* A 60-minute file, because that is the requirement and because none of the
     timing claims below mean anything on a ten-second one. Small and cheap to
     encode, with a two-second keyframe interval — which is also what makes the
     stream-copy rounding measurable rather than theoretical. */
  console.log("Building a 60-minute test video (this is the slow part)...");
  const built = Date.now();
  await runner.run(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-t", String(HOUR),
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "64k",
      "-shortest", input,
    ],
    {}
  );
  const sizeMb = fs.statSync(input).size / (1024 * 1024);
  console.log("  built in " + Math.round((Date.now() - built) / 1000) + "s, " + sizeMb.toFixed(1) + " MB\n");

  /* ---- probing --------------------------------------------------------- */
  console.log("Probing");
  const info = await runner.probe(input);
  check("ffprobe output parsed", Boolean(info));
  if (!info) return;
  near("duration", info.duration, HOUR, 1);
  check("dimensions", info.width === 320 && info.height === 240, info.width + "×" + info.height);
  near("frame rate", info.fps, 10, 0.01);
  check("audio found", info.hasAudio === true);
  check("codecs named", info.videoCodec === "h264" && info.audioCodec === "aac");

  /* ---- the claim the design rests on ----------------------------------- */
  console.log("\nStream-copy trim, 30s taken from 50 minutes in");
  const copyOut = path.join(work, "copy.mp4");
  const copyArgs = core.trimArgs({
    input,
    output: copyOut,
    start: 3000,
    duration: 30,
    mode: core.MODE_COPY,
  });
  const copyStarted = Date.now();
  const seen = [];
  await runner.run("ffmpeg", copyArgs, { onProgress: (progress) => seen.push(progress) });
  const copyMs = Date.now() - copyStarted;

  /* Input seeking is the whole reason a 60-minute file is usable here. With
     `-ss` after `-i` this decodes 50 minutes and throws them away. */
  check("finished in under 5s, 50 minutes into an hour", copyMs < 5000, copyMs + "ms");
  const copyInfo = await runner.probe(copyOut);
  near("output duration", copyInfo.duration, 30, 1.5, "copy rounds to a keyframe");
  check("output plays back as h264", copyInfo.videoCodec === "h264");
  check(
    "lossless — no re-encode happened",
    copyInfo.videoCodec === info.videoCodec && copyInfo.width === info.width
  );

  console.log("\nProgress reporting");
  check("ffmpeg reported progress at all", seen.length > 0, seen.length + " blocks");
  const ended = seen.filter((progress) => progress.done);
  check("the closing block was not missed", ended.length > 0, "this is what the read-carry is for");
  const withSeconds = seen.filter((progress) => progress.seconds !== null);
  check("seconds were parsed", withSeconds.length > 0);
  if (withSeconds.length) {
    const last = withSeconds[withSeconds.length - 1];
    near("last reported position", last.seconds, 30, 2, "out_time_us is microseconds");
  }

  /* ---- frame-exact ------------------------------------------------------ */
  console.log("\nRe-encode trim, same span");
  const encodeOut = path.join(work, "encode.mp4");
  const encodeStarted = Date.now();
  await runner.run(
    "ffmpeg",
    core.trimArgs({
      input,
      output: encodeOut,
      start: 3000,
      duration: 30,
      mode: core.MODE_ENCODE,
      crf: 28,
      preset: "ultrafast",
    }),
    {}
  );
  const encodeInfo = await runner.probe(encodeOut);
  near("output duration is exact", encodeInfo.duration, 30, 0.2, "this is what re-encode buys");
  console.log("  (took " + Math.round((Date.now() - encodeStarted) / 1000) + "s)");

  /* ---- muting ---------------------------------------------------------- */
  console.log("\nMuting");
  const mutedOut = path.join(work, "muted.mp4");
  await runner.run(
    "ffmpeg",
    core.trimArgs({ input, output: mutedOut, start: 10, duration: 5, mode: core.MODE_COPY, mute: true }),
    {}
  );
  const mutedInfo = await runner.probe(mutedOut);
  check("the audio stream is gone", mutedInfo.hasAudio === false);

  /* ---- joining --------------------------------------------------------- */
  console.log("\nExport: two clips, trimmed then joined");
  const clips = [
    { path: input, start: 60, end: 90 },
    { path: input, start: 1800, end: 1820 },
  ];
  const plan = core.exportPlan(clips);
  check("plan is one pass per clip plus a join", plan.steps === 3, plan.steps + " steps");
  const produced = [];
  for (const segment of plan.segments) {
    const temp = path.join(work, segment.temp);
    await runner.run(
      "ffmpeg",
      core.trimArgs({
        input: segment.input,
        output: temp,
        start: segment.start,
        duration: segment.duration,
        mode: core.MODE_COPY,
      }),
      {}
    );
    produced.push(temp);
  }
  const listPath = path.join(work, "concat.txt");
  fs.writeFileSync(listPath, core.concatListText(produced), "utf8");
  const joined = path.join(work, "joined.mp4");
  await runner.run("ffmpeg", core.concatArgs({ listPath, output: joined, mode: core.MODE_COPY }), {});
  const joinedInfo = await runner.probe(joined);
  check("the concat list was accepted", Boolean(joinedInfo));
  near("joined duration is the sum of the clips", joinedInfo.duration, 50, 3);

  /* ---- the filmstrip --------------------------------------------------- */
  console.log("\nFilmstrip");
  const times = core.filmstripTimes(HOUR, core.filmstripCount(960, core.STILL_WIDTH, core.STILL_MAX));
  check("count came from the width, not the duration", times.length === 10, times.length + " stills for an hour");
  const stripStarted = Date.now();
  const stills = [];
  for (const time of times) {
    stills.push(await runner.still(input, time, 90));
  }
  const stripMs = Date.now() - stripStarted;
  check("every still came back", stills.every((still) => still && still.length > 0));
  check(
    "they are JPEGs, not text",
    stills.every((still) => still[0] === 0xff && still[1] === 0xd8),
    "a JPEG through String() is a corrupt JPEG"
  );
  check("the whole strip took under 20s for a 60-minute file", stripMs < 20000, stripMs + "ms");

  /* ---- audio ----------------------------------------------------------- */
  console.log("\nAudio extraction");
  const audioOut = path.join(work, "audio.m4a");
  await runner.run(
    "ffmpeg",
    core.audioArgs({ input, output: audioOut, start: 100, duration: 15 }),
    {}
  );
  const audioInfo = await runner.probe(audioOut);
  near("audio duration", audioInfo.duration, 15, 1);
  check("and no video came with it", audioInfo.hasVideo === false);

  /* ---- failing --------------------------------------------------------- */
  console.log("\nFailing usefully");
  const broken = path.join(work, "broken.mp4");
  fs.writeFileSync(broken, "this is not a video");
  check("an unreadable file probes as null, not as a crash", (await runner.probe(broken)) === null);
  let message = "";
  try {
    await runner.run(
      "ffmpeg",
      core.trimArgs({ input: broken, output: path.join(work, "nope.mp4"), start: 0, duration: 1 }),
      {}
    );
  } catch (error) {
    message = error.message;
  }
  check(
    "a failed run carries ffmpeg's own reason",
    message.includes("Invalid data") && !/exited d/.test(message),
    message
  );

  /* ---- cancelling ------------------------------------------------------ */
  console.log("\nCancelling a long job");
  const signal = { cancelled: false };
  const slow = runner.run(
    "ffmpeg",
    core.trimArgs({
      input,
      output: path.join(work, "cancelled.mp4"),
      start: 0,
      duration: HOUR,
      mode: core.MODE_ENCODE,
      crf: 18,
      preset: "veryslow",
    }),
    { signal }
  );
  setTimeout(() => {
    signal.cancelled = true;
  }, 1200);
  let cancelled = false;
  try {
    await slow;
  } catch (error) {
    cancelled = Boolean(error && error.cancelled);
  }
  check("the process actually stopped", cancelled);
  check("and nothing was left running", runner.running.size === 0);
}

main().catch((error) => {
  console.error("\nsmoke run failed: " + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
