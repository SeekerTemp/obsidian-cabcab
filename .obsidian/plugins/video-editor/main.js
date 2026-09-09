"use strict";

/* Video Editor — trim, split, arrange and export vault video.
 *
 * Sibling to Media Viewer and deliberately not part of it. A trim is a crop in
 * the time dimension, so it wants the same lineage machinery — but it also
 * wants a native ffmpeg binary, a child process, a cancel button and a
 * progress bar, none of which Media Viewer has any use for. Keeping them apart
 * keeps a browser-only pane browser-only.
 *
 * What is shared is the *record*, not the code: both plugins write
 * `MediaInstance` notes into the vault's schema system, so a frame captured in
 * Media Viewer from a clip trimmed here resolves up a single chain to the
 * original walkthrough. That is the whole point — a captured frame that cannot
 * name its video and its second has failed at the main job.
 *
 * The file opens with a block of pure functions exported as
 * `module.exports.core`: path building, timecode parsing, range maths,
 * ffmpeg argument construction, ffprobe and progress parsing, export planning
 * and note rendering. They run under plain node with a stubbed
 * `require("obsidian")`, which is how the argument lists that drive a native
 * binary are verified without a native binary. Anything worth testing belongs
 * there. Everything below the "End of core" banner touches Obsidian.
 */

const { ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, setIcon } = require("obsidian");

const VIEW_TYPE_VIDEO_EDITOR = "video-editor-pane";

/* ======================================================================== *
 *                                  core
 * ======================================================================== */

/* ------------------------------------------------------------------------ *
 * Paths.
 *
 * Duplicated from Media Viewer rather than shared, because a shared file
 * between two plugins in a vault with no build step means one plugin reaching
 * into the other's folder — a load-order dependency that breaks the moment a
 * user disables one of them. Eight small string functions is the cheaper of
 * the two costs.
 * ------------------------------------------------------------------------ */

const VIDEO_EXTENSIONS = ["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"];
const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "wav", "ogg", "flac", "opus"];

// Containers that can carry their index at the front, so a player can start
// before the whole file has arrived. Applied on write, never on read.
const FASTSTART_EXTENSIONS = ["mp4", "m4v", "mov"];

function normaliseSeparators(path) {
  return String(path === null || path === undefined ? "" : path).split("\\").join("/");
}

function baseNameOf(path) {
  const text = normaliseSeparators(path);
  const at = text.lastIndexOf("/");
  return at === -1 ? text : text.slice(at + 1);
}

function folderOf(path) {
  const text = normaliseSeparators(path);
  const at = text.lastIndexOf("/");
  return at === -1 ? "" : text.slice(0, at);
}

function extensionOf(path) {
  const name = baseNameOf(path);
  const at = name.lastIndexOf(".");
  if (at <= 0) return "";
  return name.slice(at + 1).toLowerCase();
}

function stemOf(path) {
  const name = baseNameOf(path);
  const at = name.lastIndexOf(".");
  return at <= 0 ? name : name.slice(0, at);
}

function joinPath(folder, name) {
  const head = normaliseSeparators(folder).replace(/\/+$/, "");
  const tail = normaliseSeparators(name).replace(/^\/+/, "");
  if (!head) return tail;
  if (!tail) return head;
  return head + "/" + tail;
}

function classifyExtension(extension) {
  const normalised = String(extension || "").toLowerCase();
  if (VIDEO_EXTENSIONS.includes(normalised)) return "video";
  if (AUDIO_EXTENSIONS.includes(normalised)) return "audio";
  return "other";
}

function isVideoPath(path) {
  return classifyExtension(extensionOf(path)) === "video";
}

function isAudioPath(path) {
  return classifyExtension(extensionOf(path)) === "audio";
}

function supportsFaststart(extension) {
  return FASTSTART_EXTENSIONS.includes(String(extension || "").toLowerCase());
}

/* `yyMMddHHmmss`, local time.
 *
 * Local rather than UTC because this is a filename a person reads and sorts
 * by eye; the record's `created` is UTC, and that is the one anything
 * automated should be reading.
 */
function timestampFor(date) {
  const at = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    String(at.getFullYear()).slice(-2) +
    pad(at.getMonth() + 1) +
    pad(at.getDate()) +
    pad(at.getHours()) +
    pad(at.getMinutes()) +
    pad(at.getSeconds())
  );
}

/* A path that is not taken.
 *
 * `taken(path)` answers whether something is there already. The suffix is
 * numeric and starts at 2, which is the convention the rest of this vault
 * uses, and the loop is capped so a broken `taken` cannot hang the pane.
 */
function uniquePath(folder, stem, extension, taken) {
  const isTaken = typeof taken === "function" ? taken : () => false;
  const suffix = extension ? "." + extension : "";
  let candidate = joinPath(folder, stem + suffix);
  let counter = 2;
  while (isTaken(candidate) && counter < 1000) {
    candidate = joinPath(folder, stem + "-" + counter + suffix);
    counter += 1;
  }
  return candidate;
}

/* `<stem>+<tag>+<timestamp>.<ext>` beside the source, or in `folder` when one
 * is given.
 *
 * The timestamp is in the name only to keep two cuts of the same video apart
 * at a glance. Nothing reads it back — where the clip came from and which
 * seconds it covers live in the record, which is the thing that survives a
 * rename.
 */
function derivedPathFor(sourcePath, tag, options) {
  const settings = options || {};
  const folder = settings.folder === undefined || settings.folder === null || settings.folder === ""
    ? folderOf(sourcePath)
    : normaliseSeparators(settings.folder).replace(/\/+$/, "");
  const extension = settings.extension || extensionOf(sourcePath) || "mp4";
  const stamp = timestampFor(settings.date);
  return uniquePath(folder, stemOf(sourcePath) + "+" + tag + "+" + stamp, extension, settings.taken);
}

function trimPathFor(sourcePath, options) {
  return derivedPathFor(sourcePath, "trim", options);
}

function cutPathFor(sourcePath, options) {
  return derivedPathFor(sourcePath, "cut", options);
}

function audioPathFor(sourcePath, options) {
  return derivedPathFor(sourcePath, "audio", Object.assign({ extension: "m4a" }, options || {}));
}

/* ------------------------------------------------------------------------ *
 * Time.
 *
 * Everything here is seconds as a float. Milliseconds matter: a 60-minute
 * walkthrough is scrubbed to a moment, and "the second the button was clicked"
 * is not the same claim as "somewhere in that second".
 * ------------------------------------------------------------------------ */

// Below this, a range is not a clip — ffmpeg will happily be asked for it and
// produce a file with no frames in it.
const MIN_RANGE_SECONDS = 0.05;

/* Slack for the comparison, not for the value.
 *
 * A selection pinned to the very end of a file is widened by subtracting the
 * minimum from the duration, and `120 - 119.95` is 0.04999999999999716. Without
 * this, a clip taken at the end of a video is silently dropped as too short —
 * which is a real cut, quietly refused, at exactly the moment a walkthrough's
 * last click usually happens.
 */
const RANGE_EPSILON = 1e-6;

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function clampTime(time, duration) {
  const value = Number(time);
  if (!Number.isFinite(value) || value < 0) return 0;
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return value;
  return value > total ? total : value;
}

/* `HH:MM:SS.mmm`, with the hours dropped under an hour.
 *
 * Dropping the hours is not cosmetic: most clips are minutes long, and a
 * leading `00:` on every readout makes the part that changes harder to find.
 * `withHours` forces them back for the ruler, where the columns have to line
 * up.
 */
function formatTimecode(seconds, options) {
  const settings = options === true ? { millis: true } : options || {};
  const value = Number(seconds);
  const total = Number.isFinite(value) && value > 0 ? value : 0;
  const whole = Math.floor(total);
  const millis = Math.round((total - whole) * 1000);
  // Rounding can carry: 1.9996 s is 2 s and 0 ms, not 1 s and 1000 ms.
  const carried = millis === 1000 ? whole + 1 : whole;
  const ms = millis === 1000 ? 0 : millis;
  const hours = Math.floor(carried / 3600);
  const minutes = Math.floor((carried % 3600) / 60);
  const secs = carried % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const head = hours > 0 || settings.withHours ? pad(hours) + ":" : "";
  const tail = settings.millis ? "." + String(ms).padStart(3, "0") : "";
  return head + pad(minutes) + ":" + pad(secs) + tail;
}

/* The inverse, forgiving of what a person types.
 *
 * "1:02:03.5", "2:03", "123", "123.4" all parse. "N/A" — which is what ffmpeg
 * emits before it knows — does not, and returns null rather than 0, because a
 * progress bar that reads a failure as "start of file" jumps backwards.
 */
function parseTimecode(text) {
  const raw = String(text === null || text === undefined ? "" : text).trim();
  if (!raw) return null;
  if (!/^-?\d+(\.\d+)?$|^-?(\d+:)?\d{1,2}:\d{1,2}(\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const parts = body.split(":");
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    seconds = seconds * 60 + value;
  }
  return negative ? -seconds : seconds;
}

function formatDuration(seconds) {
  return formatTimecode(seconds, { millis: true });
}

function seekTime(current, delta, duration) {
  return clampTime(Number(current || 0) + Number(delta || 0), duration);
}

/* One frame, or several.
 *
 * The frame rate is what ffprobe reported. When it did not report one — a
 * variable-frame-rate capture, or a probe that failed — 30 stands in, because
 * a step of "one thirtieth of a second" is wrong by a few milliseconds and a
 * step of NaN is wrong by the whole file.
 */
function frameStepTime(current, frames, fps, duration) {
  const rate = Number(fps);
  const step = Number.isFinite(rate) && rate > 0 ? 1 / rate : 1 / 30;
  return clampTime(Number(current || 0) + Number(frames || 0) * step, duration);
}

function clampSpeed(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return 1;
  const min = SPEEDS[0];
  const max = SPEEDS[SPEEDS.length - 1];
  return Math.min(max, Math.max(min, value));
}

function stepSpeed(rate, steps) {
  const current = clampSpeed(rate);
  let nearest = 0;
  for (let i = 1; i < SPEEDS.length; i += 1) {
    if (Math.abs(SPEEDS[i] - current) < Math.abs(SPEEDS[nearest] - current)) nearest = i;
  }
  const at = Math.min(SPEEDS.length - 1, Math.max(0, nearest + Number(steps || 0)));
  return SPEEDS[at];
}

function formatSpeed(rate) {
  const value = clampSpeed(rate);
  return (Number.isInteger(value) ? String(value) : String(value)) + "\u00d7";
}

// Fraction of the way along the timeline, 0..1. A zero-length or unknown
// duration parks the playhead at the start rather than dividing by zero.
function positionForTime(time, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, clampTime(time, total) / total));
}

function timeForPosition(position, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const fraction = Number(position);
  if (!Number.isFinite(fraction)) return 0;
  return clampTime(Math.min(1, Math.max(0, fraction)) * total, total);
}

/* ------------------------------------------------------------------------ *
 * Ranges — the in and out points.
 *
 * A range is `{ start, end }` in source seconds. Every mutation goes through
 * `normaliseRange`, so there is one place that decides what happens when the
 * out point is dragged past the in point, and it is tested.
 * ------------------------------------------------------------------------ */

function normaliseRange(range, duration) {
  const source = range || {};
  const total = Number(duration);
  const hasTotal = Number.isFinite(total) && total > 0;
  let start = Number(source.start);
  let end = Number(source.end);
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end)) end = hasTotal ? total : start + MIN_RANGE_SECONDS;
  if (hasTotal) {
    start = Math.min(start, total);
    end = Math.min(end, total);
  }
  // Dragging one handle past the other swaps them rather than refusing the
  // drag. Refusing feels like the mouse stopped working; swapping is what
  // every other editor does.
  if (end < start) {
    const held = start;
    start = end;
    end = held;
  }
  if (end - start < MIN_RANGE_SECONDS) {
    end = start + MIN_RANGE_SECONDS;
    if (hasTotal && end > total) {
      end = total;
      start = Math.max(0, total - MIN_RANGE_SECONDS);
    }
  }
  return { start, end };
}

function rangeDuration(range) {
  const value = range || {};
  const span = Number(value.end) - Number(value.start);
  return Number.isFinite(span) && span > 0 ? span : 0;
}

function withStart(range, time, duration) {
  return normaliseRange({ start: time, end: (range || {}).end }, duration);
}

function withEnd(range, time, duration) {
  return normaliseRange({ start: (range || {}).start, end: time }, duration);
}

// The whole file, which is the range a newly opened video starts with.
function wholeRange(duration) {
  return normaliseRange({ start: 0, end: duration }, duration);
}

/* Cut a range in two at `at`.
 *
 * Returns null when the split point is outside the range or would leave a
 * piece too short to be a clip — the caller says "not there" rather than
 * silently producing a zero-length half.
 */
function splitRange(range, at, duration) {
  const whole = normaliseRange(range, duration);
  const point = Number(at);
  if (!Number.isFinite(point)) return null;
  if (point - whole.start < MIN_RANGE_SECONDS - RANGE_EPSILON) return null;
  if (whole.end - point < MIN_RANGE_SECONDS - RANGE_EPSILON) return null;
  return [
    { start: whole.start, end: point },
    { start: point, end: whole.end },
  ];
}

function rangeContains(range, time) {
  const value = range || {};
  const at = Number(time);
  return Number.isFinite(at) && at >= Number(value.start) && at <= Number(value.end);
}

function rangeLabel(range) {
  const value = range || {};
  return formatTimecode(value.start, { millis: true }) + " \u2192 " + formatTimecode(value.end, { millis: true });
}

/* ------------------------------------------------------------------------ *
 * Clips — what will be exported, in order.
 *
 * A clip is a range plus the file it came from, so a single export can stitch
 * pieces of several walkthroughs together. Ids are assigned by the caller and
 * carried through, because the list is reordered by dragging and an index is
 * not a stable name for a row.
 * ------------------------------------------------------------------------ */

function clipFrom(path, range, options) {
  const settings = options || {};
  const span = normaliseRange(range, settings.duration);
  return {
    id: settings.id || null,
    path: normaliseSeparators(path),
    start: span.start,
    end: span.end,
  };
}

function normaliseClip(clip) {
  if (!clip || typeof clip !== "object") return null;
  const path = normaliseSeparators(clip.path);
  if (!path) return null;
  const start = Number(clip.start);
  const end = Number(clip.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  /* Measured before normalising, not after.
   *
   * Dragging a handle onto its neighbour should widen the selection — that is
   * a gesture in progress. A clip already in the list is a decision someone
   * made, and widening it would export half a second nobody chose. So the
   * interactive path widens and the stored path refuses. */
  if (Math.abs(end - start) < MIN_RANGE_SECONDS - RANGE_EPSILON) return null;
  const span = normaliseRange({ start, end });
  return { id: clip.id || null, path, start: span.start, end: span.end };
}

function clipDuration(clip) {
  const value = normaliseClip(clip);
  return value ? rangeDuration(value) : 0;
}

function clipsDuration(clips) {
  return (Array.isArray(clips) ? clips : []).reduce((sum, clip) => sum + clipDuration(clip), 0);
}

/* Move one item, returning a new list.
 *
 * Out-of-range indices return the list unchanged rather than throwing: a drag
 * that ends outside the list is an ordinary gesture, not an error.
 */
function moveItem(list, from, to) {
  const items = Array.isArray(list) ? list.slice() : [];
  const source = Number(from);
  const target = Number(to);
  if (!Number.isInteger(source) || source < 0 || source >= items.length) return items;
  if (!Number.isInteger(target) || target < 0 || target >= items.length) return items;
  if (source === target) return items;
  const [held] = items.splice(source, 1);
  items.splice(target, 0, held);
  return items;
}

function removeAt(list, index) {
  const items = Array.isArray(list) ? list.slice() : [];
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= items.length) return items;
  items.splice(at, 1);
  return items;
}

// Which row to select once one has gone: the one that took its place, or the
// new last row when the removed one was last. -1 when nothing is left.
function indexAfterRemoval(length, removed) {
  const count = Number(length);
  if (!Number.isFinite(count) || count <= 1) return -1;
  const at = Number(removed);
  if (!Number.isFinite(at)) return 0;
  return Math.min(Math.max(0, Math.floor(at)), count - 2);
}

function clipLabel(clip) {
  const value = normaliseClip(clip);
  if (!value) return "";
  return baseNameOf(value.path) + "  " + rangeLabel(value);
}

/* ------------------------------------------------------------------------ *
 * The timeline strip.
 *
 * A 60-minute file is 3,600 seconds, and a thumbnail per second is 3,600
 * ffmpeg invocations for a strip about 90 pixels tall. So the count comes from
 * how many stills fit across the pane, not from the duration — the strip costs
 * the same for a ten-second clip and an hour-long walkthrough, which is the
 * only way the hour-long one is usable.
 * ------------------------------------------------------------------------ */

const STILL_WIDTH = 96;
const STILL_MAX = 24;

function filmstripCount(width, stillWidth, max) {
  const available = Number(width);
  if (!Number.isFinite(available) || available <= 0) return 0;
  const each = Number(stillWidth) > 0 ? Number(stillWidth) : STILL_WIDTH;
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : STILL_MAX;
  return Math.max(1, Math.min(cap, Math.floor(available / each)));
}

/* The moment each still stands for: the middle of its cell, not its left
 * edge. A still taken at the left edge of the first cell is the very first
 * frame, which on a screen recording is a black fade often enough to make the
 * whole strip start with a black square.
 */
function filmstripTimes(duration, count) {
  const total = Number(duration);
  const cells = Math.floor(Number(count));
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(cells) || cells <= 0) return [];
  const times = [];
  for (let i = 0; i < cells; i += 1) {
    times.push(clampTime((total * (i + 0.5)) / cells, total));
  }
  return times;
}

// Labels under the strip. `count` is how many, ends included, so 7 ticks over
// an hour is one every ten minutes.
function rulerTicks(duration, count) {
  const total = Number(duration);
  const marks = Math.floor(Number(count));
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(marks) || marks < 2) return [];
  const ticks = [];
  for (let i = 0; i < marks; i += 1) {
    const at = (total * i) / (marks - 1);
    ticks.push({ time: at, label: formatTimecode(at), position: positionForTime(at, total) });
  }
  return ticks;
}

/* ------------------------------------------------------------------------ *
 * ffmpeg.
 *
 * Every argument list is built here, as a pure function returning an array.
 * That is the point of the split: the thing that drives a native binary over
 * a 60-minute file is the thing hardest to test by running it, and easiest to
 * test by reading what it was going to say.
 *
 * Arrays, never a command string. `spawn` with an argument array means a path
 * with a space or a quote in it is a path, not three arguments — and this
 * vault's folders have spaces in them.
 * ------------------------------------------------------------------------ */

const MODE_COPY = "copy";
const MODE_ENCODE = "encode";

// Shared prefix. `-nostdin` matters: without it ffmpeg competes for the
// parent's stdin and a run that hits a prompt hangs forever with no output.
const FFMPEG_PREFIX = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];

// Progress on stdout, so stderr stays nothing but errors and the error
// summary does not have to filter a thousand status lines out of it.
const PROGRESS_ARGS = ["-progress", "pipe:1", "-nostats"];

function binaryName(name, platform) {
  const base = String(name || "");
  return String(platform || "") === "win32" ? base + ".exe" : base;
}

/* Seconds as ffmpeg wants them: plain decimal, microsecond resolution, no
 * exponent. `String(1e-7)` is "1e-7", which ffmpeg reads as 1 second.
 */
function secondsArg(seconds) {
  const value = Number(seconds);
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  const text = safe.toFixed(6);
  return text.indexOf(".") === -1 ? text : text.replace(/0+$/, "").replace(/\.$/, "");
}

function probeArgs(input) {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    String(input),
  ];
}

// "30000/1001" → 29.97. ffprobe reports frame rates as exact fractions, and
// 29.97 is not one — rounding it here rather than at the call site keeps
// frame-stepping on NTSC footage from drifting.
function parseFraction(text) {
  const raw = String(text === null || text === undefined ? "" : text).trim();
  if (!raw || raw === "0/0") return null;
  const at = raw.indexOf("/");
  if (at === -1) {
    const single = Number(raw);
    return Number.isFinite(single) && single > 0 ? single : null;
  }
  const top = Number(raw.slice(0, at));
  const bottom = Number(raw.slice(at + 1));
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return null;
  const value = top / bottom;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* The first of several candidates that is actually a number.
 *
 * Absent candidates are skipped rather than converted, because Number(null) is
 * 0 and Number("") is 0 — so a file whose container declares no duration would
 * otherwise report a confident zero, and an audio-only file would open with a
 * timeline no seconds long. */
function firstFinite(values) {
  for (const value of values || []) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/* What ffprobe said, as the six facts the pane needs.
 *
 * Returns null on anything unparseable, which the caller shows as "could not
 * read this file" — better than a pane built around a duration of NaN.
 */
function parseProbeOutput(text) {
  let data = null;
  try {
    data = JSON.parse(String(text || ""));
  } catch (error) {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream && stream.codec_type === "video") || null;
  const audio = streams.find((stream) => stream && stream.codec_type === "audio") || null;
  const format = data.format && typeof data.format === "object" ? data.format : {};
  const duration = firstFinite([format.duration, video && video.duration, audio && audio.duration]);
  if (!video && !audio) return null;
  return {
    duration: duration === null ? null : Math.max(0, duration),
    width: video ? firstFinite([video.width]) : null,
    height: video ? firstFinite([video.height]) : null,
    // avg_frame_rate first: r_frame_rate is the *base* rate and on a
    // variable-rate screen recording it is often a wild 1000/1.
    fps: video ? parseFraction(video.avg_frame_rate) || parseFraction(video.r_frame_rate) : null,
    videoCodec: video && video.codec_name ? String(video.codec_name) : null,
    audioCodec: audio && audio.codec_name ? String(audio.codec_name) : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    bitrate: firstFinite([format.bit_rate]),
    sizeBytes: firstFinite([format.size]),
  };
}

function clampCrf(crf) {
  const value = Math.round(Number(crf));
  if (!Number.isFinite(value)) return 20;
  return Math.min(51, Math.max(0, value));
}

/* How the streams are handled, which is the whole copy-versus-encode choice.
 *
 * Copy is a demux and a remux: an hour-long file is done in a second or two
 * and loses nothing, but it can only start on a keyframe, so the clip may run
 * up to a group-of-pictures early. Encode is frame-exact and costs real time.
 * Both are offered because neither is right for every cut, and the pane says
 * which one it is about to do.
 */
function streamArgs(options) {
  const settings = options || {};
  const mute = Boolean(settings.mute);
  if (settings.mode === MODE_ENCODE) {
    const args = [
      "-c:v",
      "libx264",
      "-preset",
      String(settings.preset || "veryfast"),
      "-crf",
      String(clampCrf(settings.crf)),
      // Not every h264 profile a phone or a capture card produces plays in
      // Electron's bundled Chromium; yuv420p is the one that always does.
      "-pix_fmt",
      "yuv420p",
    ];
    if (mute) args.push("-an");
    else args.push("-c:a", "aac", "-b:a", String(settings.audioBitrate || "192k"));
    return args;
  }
  const args = ["-c", "copy"];
  if (mute) args.push("-an");
  // A copy that starts mid-stream can carry negative timestamps from the
  // keyframe it actually began at. Players show that as a clip that will not
  // seek; make_zero rebases them.
  args.push("-avoid_negative_ts", "make_zero");
  return args;
}

/* One trim.
 *
 * `-ss` goes *before* `-i`. After it, ffmpeg decodes the whole file from the
 * start and throws away everything before the cut — on a 60-minute walkthrough
 * that is the difference between two seconds and several minutes. Input
 * seeking has been accurate for re-encodes since ffmpeg 2.1, so the only cost
 * is the keyframe rounding that stream copy has anyway.
 */
function trimArgs(options) {
  const settings = options || {};
  const start = Math.max(0, Number(settings.start) || 0);
  const duration = Math.max(MIN_RANGE_SECONDS, Number(settings.duration) || 0);
  const args = FFMPEG_PREFIX.slice();
  if (start > 0) args.push("-ss", secondsArg(start));
  args.push("-i", String(settings.input));
  // `-t` rather than `-to`: with input seeking, what `-to` is relative to has
  // changed between ffmpeg releases, and a duration has not.
  args.push("-t", secondsArg(duration));
  for (const arg of streamArgs(settings)) args.push(arg);
  if (supportsFaststart(extensionOf(settings.output))) args.push("-movflags", "+faststart");
  for (const arg of PROGRESS_ARGS) args.push(arg);
  args.push(String(settings.output));
  return args;
}

/* The concat demuxer's list file.
 *
 * Single-quoted, with `'` written as `'\''` — the demuxer's own escaping, not
 * the shell's. Separators are forced to `/` because a Windows path full of
 * backslashes reads as escapes here and silently loses characters.
 */
function concatListText(paths) {
  const lines = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    const text = normaliseSeparators(path).trim();
    if (!text) continue;
    lines.push("file '" + text.split("'").join("'\\''") + "'");
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

function concatArgs(options) {
  const settings = options || {};
  const args = FFMPEG_PREFIX.slice();
  // `-safe 0` because the list holds absolute paths, which the demuxer
  // otherwise refuses on the grounds that it might have come from the network.
  args.push("-f", "concat", "-safe", "0", "-i", String(settings.listPath));
  for (const arg of streamArgs(settings)) args.push(arg);
  if (supportsFaststart(extensionOf(settings.output))) args.push("-movflags", "+faststart");
  for (const arg of PROGRESS_ARGS) args.push(arg);
  args.push(String(settings.output));
  return args;
}

/* One still, to stdout as JPEG.
 *
 * Piped rather than written, because the strip is 24 throwaway images and a
 * temp file each is 24 files to create, read and delete on every pane resize.
 * `scale=-2:h` keeps the aspect and forces an even width, which the encoder
 * requires.
 */
function stillArgs(options) {
  const settings = options || {};
  const height = Math.max(2, Math.round(Number(settings.height) || 90));
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  args.push("-ss", secondsArg(settings.time));
  args.push("-i", String(settings.input));
  args.push("-frames:v", "1", "-vf", "scale=-2:" + height, "-q:v", "6");
  args.push("-f", "image2", "-vcodec", "mjpeg", "pipe:1");
  return args;
}

function audioArgs(options) {
  const settings = options || {};
  const start = Math.max(0, Number(settings.start) || 0);
  const duration = Number(settings.duration);
  const args = FFMPEG_PREFIX.slice();
  if (start > 0) args.push("-ss", secondsArg(start));
  args.push("-i", String(settings.input));
  if (Number.isFinite(duration) && duration > 0) args.push("-t", secondsArg(duration));
  args.push("-vn", "-c:a", "aac", "-b:a", String(settings.audioBitrate || "192k"));
  for (const arg of PROGRESS_ARGS) args.push(arg);
  args.push(String(settings.output));
  return args;
}

/* One block of `-progress` output.
 *
 * ffmpeg emits `key=value` lines and closes each block with `progress=`.
 * Partial blocks arrive all the time on a pipe, so this parses whatever it is
 * given and reports nulls for what was not in it; the caller keeps the last
 * good value rather than resetting the bar to zero between blocks.
 */
function parseProgress(text) {
  const found = { seconds: null, speed: null, frame: null, fps: null, done: false };
  for (const line of String(text || "").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === "out_time_us" || key === "out_time_ms") {
      /* Both are microseconds. `out_time_ms` is misnamed and has been since it
         was added; reading them the same way is what keeps the bar right on
         builds that emit only one of the two. */
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) found.seconds = number / 1e6;
    } else if (key === "out_time") {
      const parsed = parseTimecode(value);
      if (parsed !== null && found.seconds === null) found.seconds = parsed;
    } else if (key === "speed") {
      const number = parseFloat(value);
      if (Number.isFinite(number)) found.speed = number;
    } else if (key === "frame") {
      const number = Number(value);
      if (Number.isFinite(number)) found.frame = number;
    } else if (key === "fps") {
      const number = Number(value);
      if (Number.isFinite(number)) found.fps = number;
    } else if (key === "progress" && value === "end") {
      found.done = true;
    }
  }
  return found;
}

function progressPercent(seconds, total) {
  const done = Number(seconds);
  const whole = Number(total);
  if (!Number.isFinite(done) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.min(1, Math.max(0, done / whole));
}

/* How much longer, from ffmpeg's own `speed=` figure.
 *
 * `speed` is output seconds produced per wall second, so the remaining output
 * divided by it is the remaining wall time. Null until ffmpeg has reported a
 * speed, because "0 seconds remaining" on a job that has not started is worse
 * than saying nothing.
 */
function etaSeconds(done, total, speed) {
  const produced = Number(done);
  const whole = Number(total);
  const rate = Number(speed);
  if (!Number.isFinite(produced) || !Number.isFinite(whole) || whole <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const left = Math.max(0, whole - produced);
  return left / rate;
}

// Coarse on purpose: an ETA that ticks every second reads as precision the
// number does not have, and a job whose speed varies makes a liar of it.
function formatEta(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 10) return "a few seconds left";
  if (value < 90) return Math.round(value / 5) * 5 + "s left";
  const minutes = Math.round(value / 60);
  if (minutes < 60) return minutes + " min left";
  const hours = Math.floor(minutes / 60);
  return hours + "h " + (minutes % 60) + "m left";
}

// What an export will do, before it does any of it. Pure, so the pane can say
// "3 clips, 2:41, one concat" before a process is spawned.
const CONCAT_WEIGHT = 0.15;

function exportPlan(clips, options) {
  const settings = options || {};
  const prefix = String(settings.prefix || "ve-seg");
  const segments = [];
  for (const clip of Array.isArray(clips) ? clips : []) {
    const value = normaliseClip(clip);
    if (!value) continue;
    const index = segments.length;
    /* Without a container named, each piece keeps its own source's. That is
       what makes a stream copy of a mixed list work at all: copying an mkv's
       streams into an mp4 fails on codecs mp4 cannot hold, and the failure
       arrives at the *last* clip rather than the first. Re-encoding names one
       container for the whole plan, because then every piece really is the
       same thing. */
    const extension = settings.extension ? String(settings.extension) : extensionOf(value.path) || "mp4";
    segments.push({
      index,
      clipId: value.id,
      input: value.path,
      start: value.start,
      end: value.end,
      duration: rangeDuration(value),
      temp: prefix + "-" + String(index).padStart(3, "0") + "." + extension,
    });
  }
  const totalSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);
  const needsConcat = segments.length > 1;
  return {
    segments,
    totalSeconds,
    needsConcat,
    // The trims, plus the concat when there is one to do.
    steps: segments.length + (needsConcat ? 1 : 0),
    sources: Array.from(new Set(segments.map((segment) => segment.input))),
  };
}

/* Overall progress across a multi-step export, 0..1.
 *
 * Each trim is weighted by the seconds it produces, so a 3-second clip does
 * not take a third of the bar next to a 3-minute one. The concat is charged a
 * fixed fraction of the whole, because it is a copy and its cost tracks total
 * output rather than anything it can report while running.
 */
function progressAcross(plan, stepIndex, secondsInStep) {
  if (!plan || !Array.isArray(plan.segments) || !plan.segments.length) return 0;
  const concatWork = plan.needsConcat ? plan.totalSeconds * CONCAT_WEIGHT : 0;
  const total = plan.totalSeconds + concatWork;
  if (!(total > 0)) return 0;
  const at = Math.max(0, Math.floor(Number(stepIndex) || 0));
  const within = Math.max(0, Number(secondsInStep) || 0);
  let done = 0;
  for (let i = 0; i < plan.segments.length && i < at; i += 1) done += plan.segments[i].duration;
  if (at < plan.segments.length) {
    done += Math.min(within, plan.segments[at].duration);
  } else {
    done = plan.totalSeconds + Math.min(within, plan.totalSeconds) * CONCAT_WEIGHT;
  }
  return Math.min(1, Math.max(0, done / total));
}

/* The last thing ffmpeg said that a person can act on.
 *
 * `-loglevel error` means stderr is already only errors, so this is mostly
 * about length: a codec failure can be twenty lines of the same complaint, and
 * a Notice that long is a Notice nobody reads.
 */
function ffmpegErrorSummary(text, limit) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[a-z_]+=/.test(line));
  if (!lines.length) return "";
  const keep = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 3;
  return lines.slice(-keep).join(" \u2014 ");
}

function missingBinaryMessage(name, configured) {
  const which = String(name || "ffmpeg");
  if (configured) {
    return (
      which + " was not found at " + configured + ". Check the path in Video Editor settings."
    );
  }
  return (
    which +
    " was not found on PATH. Install it, or set the full path in Video Editor settings \u2014 " +
    "nothing here can cut video without it."
  );
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return (size >= 10 ? Math.round(size) : Math.round(size * 10) / 10) + " " + units[unit];
}

function errorText(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  return String(error);
}

/* ------------------------------------------------------------------------ *
 * MediaInstance records.
 *
 * The same note type Media Viewer writes, so a chain crosses the two plugins
 * without either knowing about the other. Rendering is duplicated for the
 * reason the path helpers are; the *format* is shared, and it lives in
 * `data/schema/MediaInstance.schema.md`.
 * ------------------------------------------------------------------------ */

const INSTANCE_SCHEMA = "MediaInstance";
const DEFAULT_NOTE_FOLDER = "data/media";
// Media Viewer's marker, deliberately. Two markers would mean a note written
// here and edited there loses the prose below one of them.
const NOTES_MARKER = "<!-- media-viewer:notes -->";

const OP_TRIM = "trim";
const OP_CUT = "cut";
const OP_AUDIO = "audio";

const STATUS_EDITED = "edited";

/* Fields that describe *this* file rather than the subject it is of, and so
 * are never inherited down the chain.
 *
 * `sourceStart`, `sourceEnd` and `clips` are the three this plugin adds. A
 * child inheriting its parent's `sourceStart` would claim to begin at a second
 * it does not begin at — the same mistake as inheriting a crop rectangle.
 */
const INTRINSIC_FIELDS = [
  "media",
  "source",
  "op",
  "crop",
  "transform",
  "sourceTime",
  "sourceStart",
  "sourceEnd",
  "clips",
  "width",
  "height",
  "created",
];

const INSTANCE_FIELD_ORDER = [
  "media",
  "source",
  "op",
  "crop",
  "transform",
  "sourceTime",
  "sourceStart",
  "sourceEnd",
  "clips",
  "width",
  "height",
  "created",
  "useCase",
  "shows",
  "status",
  "labels",
];

function linkTargetOf(value) {
  if (value === null || value === undefined) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const text = String(raw === null || raw === undefined ? "" : raw).trim();
  if (!text) return null;
  const inner = text.startsWith("[[") && text.endsWith("]]") ? text.slice(2, -2) : text;
  const pipe = inner.indexOf("|");
  const withoutAlias = pipe === -1 ? inner : inner.slice(0, pipe);
  const hash = withoutAlias.indexOf("#");
  const target = (hash === -1 ? withoutAlias : withoutAlias.slice(0, hash)).trim();
  return target || null;
}

function wikilinkFor(path) {
  const text = String(path === null || path === undefined ? "" : path).trim();
  return text ? "[[" + text + "]]" : "";
}

function isoTimestamp(date) {
  const at = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function asIsoString(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : isoTimestamp(value);
  const text = String(value === null || value === undefined ? "" : value).trim();
  return text || null;
}

function yamlScalar(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : '""';
  const text = String(value);
  if (text === "") return '""';
  if (/^[A-Za-z0-9][A-Za-z0-9 _.+\-/]*$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text)) {
    return text;
  }
  return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function yamlFlowMap(value) {
  const entries = Object.entries(value || {});
  if (!entries.length) return "{}";
  return "{ " + entries.map(([key, item]) => key + ": " + yamlScalar(item)).join(", ") + " }";
}

function yamlFlowList(value) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return "[]";
  return "[" + items.map((item) => yamlScalar(item)).join(", ") + "]";
}

function yamlValueFor(key, value) {
  if (key === "crop" || key === "transform") return yamlFlowMap(value);
  if (Array.isArray(value)) return yamlFlowList(value);
  if (value && typeof value === "object") return yamlFlowMap(value);
  if (key === "created") return String(value);
  return yamlScalar(value);
}

function notesBodyOf(raw) {
  const text = String(raw || "");
  const at = text.indexOf(NOTES_MARKER);
  if (at === -1) return "";
  return text.slice(at + NOTES_MARKER.length).replace(/^\r?\n/, "");
}

function renderInstanceNote(fields, body) {
  const values = fields || {};
  const lines = ["---", "implements: " + INSTANCE_SCHEMA];
  const written = new Set(["implements"]);
  for (const key of INSTANCE_FIELD_ORDER) {
    if (values[key] === undefined || values[key] === null) continue;
    written.add(key);
    lines.push(key + ": " + yamlValueFor(key, values[key]));
  }
  for (const [key, value] of Object.entries(values)) {
    if (written.has(key) || value === undefined || value === null) continue;
    lines.push(key + ": " + yamlValueFor(key, value));
  }
  lines.push("---", "", NOTES_MARKER, "");
  const tail = String(body || "");
  return lines.join("\n") + (tail ? tail.replace(/^\r?\n/, "") : "");
}

function instanceRecordFrom(frontmatter, notePath) {
  const front = frontmatter || {};
  const number = (value) =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  return {
    notePath: notePath || null,
    mediaLink: linkTargetOf(front.media),
    sourceLink: linkTargetOf(front.source),
    op: front.op === undefined || front.op === null ? null : String(front.op),
    sourceTime: number(front.sourceTime),
    sourceStart: number(front.sourceStart),
    sourceEnd: number(front.sourceEnd),
    clips: Array.isArray(front.clips) ? front.clips.slice() : [],
    width: number(front.width),
    height: number(front.height),
    created: asIsoString(front.created),
    status: front.status === undefined || front.status === null ? null : String(front.status),
    labels: Array.isArray(front.labels) ? front.labels.slice() : [],
    frontmatter: front,
  };
}

function isIntrinsicField(name) {
  return INTRINSIC_FIELDS.includes(String(name));
}

function notePathFor(folder, mediaPath, taken) {
  return uniquePath(folder, stemOf(mediaPath), "md", taken);
}

/* An export's recipe, one line per clip.
 *
 * Written into `clips:` because a concatenation has more than one parent and
 * `source:` holds exactly one. `source:` still names the first clip's file, so
 * the chain resolves; `clips:` is what says the rest of the truth, in a form a
 * person or a model can read without this plugin.
 */
function clipRecipeLines(clips) {
  const lines = [];
  for (const clip of Array.isArray(clips) ? clips : []) {
    const value = normaliseClip(clip);
    if (!value) continue;
    lines.push(
      value.path +
        " " +
        formatTimecode(value.start, { millis: true, withHours: true }) +
        "-" +
        formatTimecode(value.end, { millis: true, withHours: true })
    );
  }
  return lines;
}

// The record a trim writes. Rounded to milliseconds because that is the
// resolution the cut was actually made at, and six decimal places of float
// noise in a record a person reads is just noise.
function trimFields(options) {
  const settings = options || {};
  const round = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 1000) / 1000 : null);
  const fields = {
    source: wikilinkFor(settings.sourcePath),
    op: OP_TRIM,
    sourceStart: round(settings.start),
    sourceEnd: round(settings.end),
    created: isoTimestamp(settings.date),
    status: STATUS_EDITED,
  };
  if (Number.isFinite(Number(settings.width))) fields.width = Number(settings.width);
  if (Number.isFinite(Number(settings.height))) fields.height = Number(settings.height);
  return fields;
}

function cutFields(options) {
  const settings = options || {};
  const clips = Array.isArray(settings.clips) ? settings.clips : [];
  const first = clips.length ? normaliseClip(clips[0]) : null;
  const fields = {
    source: wikilinkFor(settings.sourcePath || (first ? first.path : "")),
    op: OP_CUT,
    clips: clipRecipeLines(clips),
    created: isoTimestamp(settings.date),
    status: STATUS_EDITED,
  };
  // A single-clip export is a trim by another name, so it says where it came
  // from the way a trim does rather than making a reader parse `clips:`.
  if (clips.length === 1 && first) {
    fields.sourceStart = Math.round(first.start * 1000) / 1000;
    fields.sourceEnd = Math.round(first.end * 1000) / 1000;
  }
  if (Number.isFinite(Number(settings.width))) fields.width = Number(settings.width);
  if (Number.isFinite(Number(settings.height))) fields.height = Number(settings.height);
  return fields;
}

function audioFields(options) {
  const settings = options || {};
  const round = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 1000) / 1000 : null);
  return {
    source: wikilinkFor(settings.sourcePath),
    op: OP_AUDIO,
    sourceStart: round(settings.start),
    sourceEnd: round(settings.end),
    created: isoTimestamp(settings.date),
    status: STATUS_EDITED,
  };
}

/* ------------------------------------------------------------------------ *
 * Settings.
 * ------------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  // "" means "find it on PATH", which is right on a machine where ffmpeg was
  // installed by a package manager and wrong nowhere.
  ffmpegPath: "",
  ffprobePath: "",
  mode: MODE_COPY,
  crf: 20,
  preset: "veryfast",
  audioBitrate: "192k",
  noteFolder: DEFAULT_NOTE_FOLDER,
  // "" means "beside the source", which keeps a clip in the folder its
  // walkthrough lives in.
  outputFolder: "",
  filmstrip: true,
  filmstripMax: STILL_MAX,
  debug: false,
};

function normaliseSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, source);
  settings.mode = settings.mode === MODE_ENCODE ? MODE_ENCODE : MODE_COPY;
  settings.crf = clampCrf(settings.crf);
  settings.filmstrip = Boolean(settings.filmstrip);
  const max = Math.round(Number(settings.filmstripMax));
  settings.filmstripMax = Number.isFinite(max) ? Math.min(64, Math.max(4, max)) : STILL_MAX;
  settings.noteFolder = String(settings.noteFolder || DEFAULT_NOTE_FOLDER).trim() || DEFAULT_NOTE_FOLDER;
  settings.outputFolder = String(settings.outputFolder || "").trim();
  settings.ffmpegPath = String(settings.ffmpegPath || "").trim();
  settings.ffprobePath = String(settings.ffprobePath || "").trim();
  settings.debug = Boolean(settings.debug);
  return settings;
}

const core = {
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  MIN_RANGE_SECONDS,
  RANGE_EPSILON,
  SPEEDS,
  MODE_COPY,
  MODE_ENCODE,
  STILL_WIDTH,
  STILL_MAX,
  CONCAT_WEIGHT,
  INSTANCE_SCHEMA,
  INSTANCE_FIELD_ORDER,
  INTRINSIC_FIELDS,
  NOTES_MARKER,
  DEFAULT_NOTE_FOLDER,
  DEFAULT_SETTINGS,
  OP_TRIM,
  OP_CUT,
  OP_AUDIO,
  STATUS_EDITED,

  normaliseSeparators,
  baseNameOf,
  folderOf,
  extensionOf,
  stemOf,
  joinPath,
  classifyExtension,
  isVideoPath,
  isAudioPath,
  supportsFaststart,
  timestampFor,
  uniquePath,
  derivedPathFor,
  trimPathFor,
  cutPathFor,
  audioPathFor,

  clampTime,
  formatTimecode,
  parseTimecode,
  formatDuration,
  seekTime,
  frameStepTime,
  clampSpeed,
  stepSpeed,
  formatSpeed,
  positionForTime,
  timeForPosition,

  normaliseRange,
  rangeDuration,
  withStart,
  withEnd,
  wholeRange,
  splitRange,
  rangeContains,
  rangeLabel,

  clipFrom,
  normaliseClip,
  clipDuration,
  clipsDuration,
  moveItem,
  removeAt,
  indexAfterRemoval,
  clipLabel,

  filmstripCount,
  filmstripTimes,
  rulerTicks,

  binaryName,
  secondsArg,
  probeArgs,
  parseFraction,
  parseProbeOutput,
  clampCrf,
  streamArgs,
  trimArgs,
  concatListText,
  concatArgs,
  stillArgs,
  audioArgs,
  parseProgress,
  progressPercent,
  etaSeconds,
  formatEta,
  exportPlan,
  progressAcross,
  ffmpegErrorSummary,
  missingBinaryMessage,
  formatBytes,
  errorText,

  linkTargetOf,
  wikilinkFor,
  isoTimestamp,
  asIsoString,
  yamlScalar,
  yamlFlowMap,
  yamlFlowList,
  yamlValueFor,
  notesBodyOf,
  renderInstanceNote,
  instanceRecordFrom,
  isIntrinsicField,
  notePathFor,
  clipRecipeLines,
  trimFields,
  cutFields,
  audioFields,
  normaliseSettings,
};

/* ======================================================================== *
 *                              End of core
 *
 * Everything below touches Obsidian, the filesystem or a child process.
 * ======================================================================== */

/* Failures are reported where a tester can reach them: the console for the
   detail, a Notice for the person. Nothing here swallows an error silently. */
function reportFailure(scope, message, error) {
  const detail = error ? " \u2014 " + errorText(error) : "";
  console.error("Video Editor: " + scope + ": " + message + detail, error || "");
}

function guarded(scope, subject, action, fallback) {
  try {
    return action();
  } catch (error) {
    reportFailure(scope, String(subject), error);
    return fallback;
  }
}

/* ------------------------------------------------------------------------ *
 * FfmpegRunner — the only thing in this plugin that spawns a process.
 *
 * Three jobs: find the binaries, run one and report progress, and stop.
 * Everything it decides about *what* to run is a `core` function; what it adds
 * is the process, the pipes and the cancellation.
 * ------------------------------------------------------------------------ */

class FfmpegRunner {
  constructor(options) {
    const settings = options || {};
    this.getSettings = typeof settings.getSettings === "function" ? settings.getSettings : () => DEFAULT_SETTINGS;
    // Injected so the tests can drive a fake process; in the app it is node's.
    this.spawn = settings.spawn || null;
    this.platform = settings.platform || (typeof process !== "undefined" ? process.platform : "");
    this.available = null;
    this.version = null;
    this.running = new Set();
  }

  childProcess() {
    if (this.spawn) return { spawn: this.spawn };
    // Required lazily, so the module still loads under a test harness that has
    // no business spawning anything.
    return require("child_process");
  }

  binaryFor(which) {
    const settings = this.getSettings();
    const configured = which === "ffprobe" ? settings.ffprobePath : settings.ffmpegPath;
    if (configured) return configured;
    return binaryName(which, this.platform);
  }

  configuredPath(which) {
    const settings = this.getSettings();
    return which === "ffprobe" ? settings.ffprobePath : settings.ffmpegPath;
  }

  /* Is there an ffmpeg at all?
   *
   * Cached, because the answer is asked on every pane open and the process
   * spawn costs more than everything else the pane does at that moment. Reset
   * whenever the configured path changes.
   */
  async check(force) {
    if (!force && this.available !== null) return this.available;
    try {
      const result = await this.run("ffmpeg", ["-hide_banner", "-version"], { capture: true });
      const first = String(result.stdout || "").split(/\r?\n/)[0] || "";
      const match = first.match(/ffmpeg version (\S+)/);
      this.version = match ? match[1] : first.trim() || "present";
      this.available = true;
    } catch (error) {
      this.version = null;
      this.available = false;
    }
    return this.available;
  }

  forget() {
    this.available = null;
    this.version = null;
  }

  /* Read a file's shape.
   *
   * Returns null rather than throwing when the probe fails or says nothing
   * useful — a file the toolchain cannot read is a normal thing to find in a
   * vault, and the pane says so rather than breaking.
   */
  async probe(inputPath) {
    try {
      const result = await this.run("ffprobe", probeArgs(inputPath), { capture: true });
      return parseProbeOutput(result.stdout);
    } catch (error) {
      reportFailure("probing", inputPath, error);
      return null;
    }
  }

  /* One still, as a Buffer of JPEG.
   *
   * stdout is collected as binary. Failures return null: a strip with a gap in
   * it is better than a pane that will not open because one seek landed past
   * the end of a file whose duration was a lie.
   */
  async still(inputPath, time, height) {
    try {
      const result = await this.run("ffmpeg", stillArgs({ input: inputPath, time, height }), {
        capture: true,
        binary: true,
      });
      const buffer = result.stdoutBuffer;
      return buffer && buffer.length ? buffer : null;
    } catch (error) {
      return null;
    }
  }

  /* Run a job, with progress.
   *
   * `onProgress` is handed `{ seconds, speed, percent }` whenever ffmpeg says
   * something. `signal` is a plain `{ cancelled }` box the caller can flip;
   * this checks it and kills the child, because AbortController's plumbing
   * through spawn is not uniform across the node versions Obsidian ships.
   */
  run(which, args, options) {
    const settings = options || {};
    const binary = this.binaryFor(which);
    const { spawn } = this.childProcess();
    return new Promise((resolve, reject) => {
      let child = null;
      try {
        child = spawn(binary, args, { windowsHide: true });
      } catch (error) {
        reject(new Error(missingBinaryMessage(which, this.configuredPath(which))));
        return;
      }
      if (!child) {
        reject(new Error(missingBinaryMessage(which, this.configuredPath(which))));
        return;
      }
      this.running.add(child);

      const stdoutChunks = [];
      let stdoutText = "";
      let stderrText = "";
      let settled = false;
      let carry = "";

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        this.running.delete(child);
        if (timer) clearInterval(timer);
        fn(value);
      };

      if (child.stdout) {
        child.stdout.on("data", (chunk) => {
          if (settings.binary) {
            stdoutChunks.push(chunk);
            return;
          }
          const text = String(chunk);
          if (settings.capture) stdoutText += text;
          if (typeof settings.onProgress === "function") {
            /* Blocks arrive split across reads, so a partial last line is
               carried into the next chunk. Without this the `progress=end`
               that closes a job is missed about as often as it is seen. */
            const combined = carry + text;
            const at = combined.lastIndexOf("\n");
            const complete = at === -1 ? "" : combined.slice(0, at + 1);
            carry = at === -1 ? combined : combined.slice(at + 1);
            if (complete) settings.onProgress(parseProgress(complete));
          }
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          stderrText += String(chunk);
          // A runaway error stream on a corrupt file should not become the
          // reason the pane runs out of memory.
          if (stderrText.length > 64000) stderrText = stderrText.slice(-32000);
        });
      }

      child.on("error", (error) => {
        const code = error && error.code;
        if (code === "ENOENT") {
          finish(reject, new Error(missingBinaryMessage(which, this.configuredPath(which))));
          return;
        }
        finish(reject, error);
      });

      child.on("close", (code) => {
        if (settings.signal && settings.signal.cancelled) {
          finish(reject, new CancelledError());
          return;
        }
        if (code === 0) {
          finish(resolve, {
            stdout: stdoutText,
            stdoutBuffer: stdoutChunks.length ? Buffer.concat(stdoutChunks) : null,
            stderr: stderrText,
          });
          return;
        }
        const summary = ffmpegErrorSummary(stderrText);
        finish(
          reject,
          new Error(which + " exited " + code + (summary ? ": " + summary : ""))
        );
      });

      /* Cancellation is polled rather than pushed. The alternative is handing
         every caller a kill function to hold and remember to drop, and a box
         with a boolean in it is the thing that is actually easy to get right. */
      let timer = null;
      if (settings.signal) {
        timer = setInterval(() => {
          if (!settings.signal.cancelled) return;
          clearInterval(timer);
          timer = null;
          try {
            child.kill();
          } catch (error) {
            reportFailure("cancelling", which, error);
          }
        }, 120);
      }
    });
  }

  // Everything still running, stopped. Called on unload, so closing Obsidian
  // does not leave an hour-long encode orphaned.
  killAll() {
    for (const child of Array.from(this.running)) {
      guarded("stopping", "ffmpeg", () => child.kill());
    }
    this.running.clear();
  }
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
    this.cancelled = true;
  }
}

/* ------------------------------------------------------------------------ *
 * Filmstrip — stills for the timeline, generated once and cached.
 *
 * Keyed by file path and by the times asked for, so a resize that changes the
 * count regenerates and a resize that does not, does not. Blob URLs are
 * revoked on clear; a pane left open on a dozen videos otherwise leaks every
 * still it ever drew.
 * ------------------------------------------------------------------------ */

class Filmstrip {
  constructor(runner, options) {
    const settings = options || {};
    this.runner = runner;
    this.height = Number(settings.height) || 90;
    this.urls = [];
    this.token = 0;
    this.path = null;
  }

  clear() {
    for (const url of this.urls) {
      guarded("releasing", "still", () => {
        if (typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(url);
      });
    }
    this.urls = [];
    this.path = null;
  }

  /* Generate for one file. `onStill(index, url)` fires as each arrives, so the
   * strip fills in rather than appearing all at once several seconds later.
   *
   * Sequential, not parallel: 24 concurrent ffmpeg processes on a 60-minute
   * file will each seek the same disk, and the whole set finishes later than
   * one at a time while making the machine unusable meanwhile.
   */
  async generate(path, times, onStill) {
    this.clear();
    this.path = path;
    this.token += 1;
    const token = this.token;
    for (let i = 0; i < times.length; i += 1) {
      if (token !== this.token) return;
      const buffer = await this.runner.still(path, times[i], this.height);
      if (token !== this.token) return;
      if (!buffer) continue;
      const url = guarded("drawing", "still", () => {
        const blob = new Blob([buffer], { type: "image/jpeg" });
        return URL.createObjectURL(blob);
      }, null);
      if (!url) continue;
      this.urls.push(url);
      if (typeof onStill === "function") onStill(i, url);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * TrimSession — the model behind the pane.
 *
 * Holds the file, its probed shape, the in/out range and the clip list, and
 * nothing else. Every decision it makes is a `core` function; what it adds is
 * that the values persist while the pane is open and that one `onChange` fires
 * when any of them move.
 *
 * It sits beside `EditSession` in Media Viewer the way `CropOverlay` does: the
 * same shape of thing, for the time dimension.
 * ------------------------------------------------------------------------ */

class TrimSession {
  constructor(options) {
    const settings = options || {};
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.path = null;
    this.info = null;
    this.range = { start: 0, end: MIN_RANGE_SECONDS };
    this.clips = [];
    this.selected = -1;
    this.nextId = 1;
  }

  get duration() {
    return this.info && Number.isFinite(this.info.duration) ? this.info.duration : 0;
  }

  get fps() {
    return this.info && Number.isFinite(this.info.fps) ? this.info.fps : null;
  }

  /* Open a file. The range resets to the whole of it, and the clip list does
     not — a clip list is built across several videos on purpose. */
  open(path, info) {
    this.path = path || null;
    this.info = info || null;
    this.range = wholeRange(this.duration);
    this.changed();
  }

  setRange(range) {
    this.range = normaliseRange(range, this.duration);
    this.changed();
    return this.range;
  }

  setStart(time) {
    this.range = withStart(this.range, time, this.duration);
    this.changed();
    return this.range;
  }

  setEnd(time) {
    this.range = withEnd(this.range, time, this.duration);
    this.changed();
    return this.range;
  }

  /* Split the selection at the playhead, adding both halves as clips.
   *
   * Returns false when the playhead is not inside the selection or is too
   * close to an edge, which the pane reports rather than silently doing
   * nothing.
   */
  split(at) {
    const halves = splitRange(this.range, at, this.duration);
    if (!halves) return false;
    this.addClip(halves[0]);
    this.addClip(halves[1]);
    this.range = normaliseRange(halves[1], this.duration);
    this.changed();
    return true;
  }

  addClip(range) {
    if (!this.path) return null;
    const clip = clipFrom(this.path, range || this.range, {
      duration: this.duration,
      id: "clip-" + this.nextId,
    });
    this.nextId += 1;
    this.clips.push(clip);
    this.selected = this.clips.length - 1;
    this.changed();
    return clip;
  }

  removeClip(index) {
    const before = this.clips.length;
    this.clips = removeAt(this.clips, index);
    if (this.clips.length !== before) {
      this.selected = indexAfterRemoval(before, index);
      this.changed();
      return true;
    }
    return false;
  }

  moveClip(from, to) {
    const moved = moveItem(this.clips, from, to);
    if (moved === this.clips) return false;
    this.clips = moved;
    this.selected = Number(to);
    this.changed();
    return true;
  }

  clearClips() {
    if (!this.clips.length) return false;
    this.clips = [];
    this.selected = -1;
    this.changed();
    return true;
  }

  selectClip(index) {
    const at = Number(index);
    this.selected = Number.isInteger(at) && at >= 0 && at < this.clips.length ? at : -1;
    this.changed();
    return this.selected;
  }

  selectedClip() {
    return this.selected >= 0 && this.selected < this.clips.length ? this.clips[this.selected] : null;
  }

  totalClipSeconds() {
    return clipsDuration(this.clips);
  }

  changed() {
    if (this.onChange) this.onChange(this);
  }
}

/* ------------------------------------------------------------------------ *
 * LineageStore — MediaInstance records, found by what they declare.
 *
 * A compact sibling of Media Viewer's. It needs less: this plugin writes
 * records and reads back whether one exists, but does not resolve chains or
 * draw panels — Media Viewer's pane already does that, over the same notes.
 *
 * The rule it does share, and the one that matters: **a note is found through
 * `metadataCache`, by the `media:` link it declares, never by its filename.**
 * ------------------------------------------------------------------------ */

class LineageStore {
  constructor(app, options) {
    const settings = options || {};
    this.app = app;
    this.noteFolder = settings.noteFolder || DEFAULT_NOTE_FOLDER;
    this.records = new Map();
    this.byMedia = new Map();
  }

  build() {
    this.records.clear();
    this.byMedia.clear();
    const files = typeof this.app.vault.getMarkdownFiles === "function" ? this.app.vault.getMarkdownFiles() : [];
    for (const file of files) {
      guarded("reading lineage from", file && file.path, () => {
        const cache = this.app.metadataCache.getFileCache(file);
        this.absorb(file, cache && cache.frontmatter);
      });
    }
    return this.records.size;
  }

  absorb(file, frontmatter) {
    this.retract(file.path);
    if (!frontmatter || frontmatter.implements !== INSTANCE_SCHEMA) return null;
    const record = instanceRecordFrom(frontmatter, file.path);
    record.mediaPath = this.resolveLink(record.mediaLink, file.path);
    record.sourcePath = this.resolveLink(record.sourceLink, file.path);
    this.records.set(file.path, record);
    if (record.mediaPath) {
      const existing = this.byMedia.get(record.mediaPath);
      if (existing && existing !== file.path) {
        console.warn(
          "Video Editor: " + record.mediaPath + " is claimed by two notes, " + existing + " and " + file.path
        );
      } else {
        this.byMedia.set(record.mediaPath, file.path);
      }
    }
    return record;
  }

  retract(notePath) {
    const previous = this.records.get(notePath);
    if (!previous) return false;
    this.records.delete(notePath);
    if (previous.mediaPath && this.byMedia.get(previous.mediaPath) === notePath) {
      this.byMedia.delete(previous.mediaPath);
    }
    return true;
  }

  resolveLink(link, fromPath) {
    if (!link) return null;
    const cache = this.app.metadataCache;
    if (cache && typeof cache.getFirstLinkpathDest === "function") {
      const dest = cache.getFirstLinkpathDest(link, fromPath || "");
      return dest ? dest.path : null;
    }
    const direct = this.app.vault.getAbstractFileByPath(link);
    return direct ? direct.path : null;
  }

  handleMetadataChange(file, data, cache) {
    if (!file || !file.path || !file.path.toLowerCase().endsWith(".md")) return false;
    const before = this.records.has(file.path);
    const after = guarded("reading lineage from", file.path, () => this.absorb(file, cache && cache.frontmatter), null);
    return Boolean(before || after);
  }

  handleDelete(file) {
    if (!file || !file.path) return false;
    return this.retract(file.path);
  }

  handleRename(file, oldPath) {
    if (!file || !file.path) return false;
    let changed = false;
    if (this.records.has(oldPath)) {
      const record = this.records.get(oldPath);
      this.retract(oldPath);
      record.notePath = file.path;
      this.records.set(file.path, record);
      if (record.mediaPath) this.byMedia.set(record.mediaPath, file.path);
      changed = true;
    }
    if (this.byMedia.has(oldPath)) {
      this.byMedia.set(file.path, this.byMedia.get(oldPath));
      this.byMedia.delete(oldPath);
      changed = true;
    }
    return changed;
  }

  isTracked(mediaPath) {
    return this.byMedia.has(mediaPath);
  }

  noteFileFor(mediaPath) {
    const notePath = this.byMedia.get(mediaPath);
    if (!notePath) return null;
    return this.app.vault.getAbstractFileByPath(notePath) || null;
  }

  recordFor(mediaPath) {
    const notePath = this.byMedia.get(mediaPath);
    return notePath ? this.records.get(notePath) || null : null;
  }

  /* Write a record for one file, creating the note or updating it.
   *
   * Prose below the notes marker survives either way, and so does any
   * frontmatter field the caller did not name — a field someone added by hand
   * is theirs, not ours to drop.
   */
  async write(mediaPath, fields) {
    const existing = this.noteFileFor(mediaPath);
    const values = Object.assign({}, fields, { media: wikilinkFor(mediaPath) });
    if (existing) {
      const raw = await this.app.vault.read(existing);
      const record = this.records.get(existing.path);
      const carried = record ? this.carriedFields(record.frontmatter, values) : {};
      await this.app.vault.modify(existing, renderInstanceNote(Object.assign(carried, values), notesBodyOf(raw)));
      return existing;
    }
    await this.ensureFolder(this.noteFolder);
    const path = notePathFor(this.noteFolder, mediaPath, (candidate) => this.exists(candidate));
    const file = await this.app.vault.create(path, renderInstanceNote(values, ""));
    /* Inserted here rather than waiting for `changed`: an export writes the
       root note for the source and the note for the output in the same breath,
       and the second must not be told the first does not exist. */
    if (file) this.absorb(file, Object.assign({ implements: INSTANCE_SCHEMA }, values));
    return file;
  }

  /* A root note for a source file, so a chain has a top.
   *
   * Written only when there is not one already — an existing record for the
   * source is the user's, and a trim is no reason to rewrite it.
   */
  async ensureRoot(mediaPath, fields) {
    if (this.isTracked(mediaPath)) return this.noteFileFor(mediaPath);
    return this.write(mediaPath, fields || { created: isoTimestamp(), status: STATUS_EDITED });
  }

  carriedFields(frontmatter, values) {
    const carried = {};
    for (const [key, value] of Object.entries(frontmatter || {})) {
      if (key === "implements") continue;
      if (values[key] !== undefined) continue;
      carried[key] = value;
    }
    return carried;
  }

  exists(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file !== null && file !== undefined;
  }

  async ensureFolder(folder) {
    if (!folder) return false;
    if (this.exists(folder)) return false;
    try {
      await this.app.vault.createFolder(folder);
      return true;
    } catch (error) {
      return false;
    }
  }
}

/* ------------------------------------------------------------------------ *
 * ExportRunner — a plan turned into files, and files turned into records.
 *
 * The one place that knows both halves of the job: ffmpeg writes to a real
 * path on a real disk, and the vault has to be told what appeared. Those are
 * different systems, and the seam between them is here rather than in the
 * pane.
 * ------------------------------------------------------------------------ */

// How long to wait for Obsidian's own watcher to notice a file ffmpeg wrote.
// Generous, because the file may be a gigabyte and the watcher fires on close.
const VAULT_SETTLE_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ExportRunner {
  constructor(options) {
    const settings = options || {};
    this.app = settings.app;
    this.runner = settings.runner;
    this.store = settings.store;
    this.getSettings = typeof settings.getSettings === "function" ? settings.getSettings : () => DEFAULT_SETTINGS;
    this.onProgress = typeof settings.onProgress === "function" ? settings.onProgress : null;
    // Injected in tests; node's own modules in the app.
    this.fs = settings.fs || null;
    this.os = settings.os || null;
    this.nodePath = settings.nodePath || null;
  }

  files() {
    return this.fs || require("fs");
  }

  paths() {
    return this.nodePath || require("path");
  }

  system() {
    return this.os || require("os");
  }

  /* Where this vault actually is.
   *
   * ffmpeg has no idea what a vault path is, so every argument that names a
   * file is absolute. A vault that is not on a local filesystem cannot be
   * edited here, and saying so is better than handing ffmpeg a path it will
   * report as missing.
   */
  basePath() {
    const adapter = this.app && this.app.vault ? this.app.vault.adapter : null;
    if (adapter && typeof adapter.getBasePath === "function") return adapter.getBasePath();
    if (adapter && adapter.basePath) return adapter.basePath;
    return null;
  }

  absolute(vaultPath) {
    const base = this.basePath();
    if (!base) {
      throw new Error("This vault is not on a local filesystem, so ffmpeg cannot reach its files.");
    }
    const parts = normaliseSeparators(vaultPath).split("/").filter(Boolean);
    return this.paths().join(base, ...parts);
  }

  taken() {
    return (candidate) => Boolean(this.app.vault.getAbstractFileByPath(candidate));
  }

  async ensureFolder(folder) {
    if (!folder) return false;
    if (this.app.vault.getAbstractFileByPath(folder)) return false;
    try {
      await this.app.vault.createFolder(folder);
      return true;
    } catch (error) {
      return false;
    }
  }

  /* Wait for the vault to see what ffmpeg wrote.
   *
   * The file is written straight into the vault folder rather than read into
   * memory and handed to `createBinary`: a 60-minute export is measured in
   * gigabytes, and buffering one to hand it back to the same disk is the kind
   * of thing that takes a machine down.
   *
   * Returning null is not a failure of the export — the file is there, and
   * Obsidian will catch up. It only means the caller cannot select it yet.
   */
  async waitForVaultFile(path, timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || VAULT_SETTLE_MS);
    for (;;) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) return file;
      if (Date.now() > deadline) return null;
      await sleep(150);
    }
  }

  report(percent, progress, label) {
    if (!this.onProgress) return;
    const speed = progress && Number.isFinite(progress.speed) ? progress.speed : null;
    this.onProgress({ percent, speed, label });
  }

  /* One trim, source to output.
   *
   * `options.outputPath` lets the export path reuse this for a single-clip
   * export without inventing a second copy of the same twenty lines.
   */
  async trim(sourcePath, range, options) {
    const settings = this.getSettings();
    const opts = options || {};
    const signal = opts.signal || { cancelled: false };
    const span = normaliseRange(range);
    const total = rangeDuration(span);
    const outputPath =
      opts.outputPath ||
      trimPathFor(sourcePath, {
        folder: settings.outputFolder,
        extension: settings.mode === MODE_ENCODE ? "mp4" : extensionOf(sourcePath),
        taken: this.taken(),
      });
    await this.ensureFolder(folderOf(outputPath));
    const args = trimArgs({
      input: this.absolute(sourcePath),
      output: this.absolute(outputPath),
      start: span.start,
      duration: total,
      mode: settings.mode,
      crf: settings.crf,
      preset: settings.preset,
      audioBitrate: settings.audioBitrate,
      mute: Boolean(opts.mute),
    });
    if (settings.debug) console.log("Video Editor: ffmpeg", args.join(" "));
    const started = Date.now();
    await this.runner.run("ffmpeg", args, {
      signal,
      onProgress: (progress) =>
        this.report(progressPercent(progress.seconds, total), progress, opts.label || "Trimming"),
    });
    if (settings.debug) console.log("Video Editor: trim ms=" + (Date.now() - started));
    const file = await this.waitForVaultFile(outputPath);
    await this.recordDerived(sourcePath, outputPath, opts.fields || trimFields({
      sourcePath,
      start: span.start,
      end: span.end,
      width: opts.width,
      height: opts.height,
    }));
    return { path: outputPath, file };
  }

  /* A clip list, joined into one file.
   *
   * Two ffmpeg passes rather than one filter graph: each clip is trimmed to a
   * temp file, then the concat *demuxer* joins them. The demuxer is a copy —
   * it costs seconds on an hour of footage — where a filter graph would
   * re-encode everything even when nothing needed re-encoding.
   */
  async exportClips(clips, options) {
    const settings = this.getSettings();
    const opts = options || {};
    const signal = opts.signal || { cancelled: false };
    const encoding = settings.mode === MODE_ENCODE;
    const plan = exportPlan(clips, encoding ? { extension: "mp4" } : {});
    if (!plan.segments.length) throw new Error("There are no clips to export.");

    const first = plan.segments[0];
    const outputPath =
      opts.outputPath ||
      cutPathFor(first.input, {
        folder: settings.outputFolder,
        extension: encoding ? "mp4" : extensionOf(first.input),
        taken: this.taken(),
      });
    const fields = cutFields({ clips, sourcePath: first.input, width: opts.width, height: opts.height });

    // One clip is a trim wearing a different hat. No temp files, no concat,
    // and the same record either way.
    if (plan.segments.length === 1) {
      return this.trim(
        first.input,
        { start: first.start, end: first.end },
        Object.assign({}, opts, { outputPath, fields, label: "Exporting" })
      );
    }

    await this.ensureFolder(folderOf(outputPath));
    const fs = this.files();
    const nodePath = this.paths();
    const tempDir = fs.mkdtempSync(nodePath.join(this.system().tmpdir(), "obsidian-video-editor-"));
    const produced = [];
    // Set only for the join, so a segment trim that fails is not answered with
    // advice about joining.
    let joining = false;
    try {
      for (const segment of plan.segments) {
        if (signal.cancelled) throw new CancelledError();
        const tempPath = nodePath.join(tempDir, segment.temp);
        const args = trimArgs({
          input: this.absolute(segment.input),
          output: tempPath,
          start: segment.start,
          duration: segment.duration,
          mode: settings.mode,
          crf: settings.crf,
          preset: settings.preset,
          audioBitrate: settings.audioBitrate,
        });
        if (settings.debug) console.log("Video Editor: ffmpeg", args.join(" "));
        await this.runner.run("ffmpeg", args, {
          signal,
          onProgress: (progress) =>
            this.report(
              progressAcross(plan, segment.index, progress.seconds),
              progress,
              "Clip " + (segment.index + 1) + " of " + plan.segments.length
            ),
        });
        produced.push(tempPath);
      }

      if (signal.cancelled) throw new CancelledError();
      joining = true;
      const listPath = nodePath.join(tempDir, "concat.txt");
      fs.writeFileSync(listPath, concatListText(produced), "utf8");
      const args = concatArgs({
        listPath,
        output: this.absolute(outputPath),
        // The segments were produced by the pass above, so at this point they
        // already match each other; joining them is always a copy.
        mode: MODE_COPY,
      });
      if (settings.debug) console.log("Video Editor: ffmpeg", args.join(" "));
      await this.runner.run("ffmpeg", args, {
        signal,
        onProgress: (progress) =>
          this.report(progressAcross(plan, plan.segments.length, progress.seconds), progress, "Joining"),
      });
    } catch (error) {
      throw joining ? this.explainConcatFailure(error, plan, settings) : error;
    } finally {
      guarded("clearing", tempDir, () => fs.rmSync(tempDir, { recursive: true, force: true }));
    }

    const file = await this.waitForVaultFile(outputPath);
    await this.recordDerived(first.input, outputPath, fields);
    return { path: outputPath, file, plan };
  }

  /* The one failure worth a longer sentence.
   *
   * Stream copy can only join pieces whose streams already match. Clips from
   * two different recordings usually do not, and ffmpeg says so in codec
   * terms that do not name the fix.
   */
  explainConcatFailure(error, plan, settings) {
    if (error instanceof CancelledError) return error;
    if (settings.mode === MODE_ENCODE || plan.sources.length < 2) return error;
    return new Error(
      errorText(error) +
        " — these clips come from " +
        plan.sources.length +
        " different files, which stream copy can only join when their streams match. Switch Output to Re-encode and try again."
    );
  }

  async extractAudio(sourcePath, range, options) {
    const settings = this.getSettings();
    const opts = options || {};
    const signal = opts.signal || { cancelled: false };
    const span = normaliseRange(range);
    const total = rangeDuration(span);
    const outputPath = audioPathFor(sourcePath, { folder: settings.outputFolder, taken: this.taken() });
    await this.ensureFolder(folderOf(outputPath));
    const args = audioArgs({
      input: this.absolute(sourcePath),
      output: this.absolute(outputPath),
      start: span.start,
      duration: total,
      audioBitrate: settings.audioBitrate,
    });
    if (settings.debug) console.log("Video Editor: ffmpeg", args.join(" "));
    await this.runner.run("ffmpeg", args, {
      signal,
      onProgress: (progress) =>
        this.report(progressPercent(progress.seconds, total), progress, "Extracting audio"),
    });
    const file = await this.waitForVaultFile(outputPath);
    await this.recordDerived(
      sourcePath,
      outputPath,
      audioFields({ sourcePath, start: span.start, end: span.end })
    );
    return { path: outputPath, file };
  }

  /* Two notes, not one.
   *
   * The derived file gets a record saying where it came from, and the source
   * gets a root record if it did not have one — otherwise the chain starts at
   * a file nothing declares, and `source:` on the child dangles the moment
   * anyone looks.
   */
  async recordDerived(sourcePath, outputPath, fields) {
    if (!this.store) return null;
    try {
      await this.store.ensureRoot(sourcePath, { created: isoTimestamp(), status: STATUS_EDITED });
      return await this.store.write(outputPath, fields);
    } catch (error) {
      reportFailure("recording", outputPath, error);
      new Notice("The file was written, but its lineage record was not: " + errorText(error));
      return null;
    }
  }
}

/* ------------------------------------------------------------------------ *
 * VideoEditorView — the pane.
 *
 * Laid out from docs/layout.html: a stage with a floating action bar over it,
 * a timeline underneath, and the clip list to one side. The floating bar is
 * the one piece of the design that is a preference rather than a deduction —
 * it keeps the controls where the eye already is, and it is what makes this
 * feel like an editor rather than a form.
 * ------------------------------------------------------------------------ */

const STILL_HEIGHT = 90;
const RULER_TICKS = 7;
const SEEK_STEP_SECONDS = 5;

class VideoEditorView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.session = new TrimSession({ onChange: () => this.renderState() });
    this.filmstrip = new Filmstrip(plugin.runner, { height: STILL_HEIGHT });
    this.file = null;
    this.job = null;
    this.drag = null;
    this.speed = 1;
    this.stillUrls = [];
  }

  getViewType() {
    return VIEW_TYPE_VIDEO_EDITOR;
  }

  getDisplayText() {
    return this.file ? "Video Editor: " + this.file.basename : "Video Editor";
  }

  getIcon() {
    return "scissors";
  }

  async onOpen() {
    const container = this.containerEl.children[1] || this.containerEl;
    container.empty();
    container.addClass("video-editor");
    this.build(container);
    this.renderState();
    await this.plugin.runner.check();
    this.renderBinaryState();
  }

  async onClose() {
    this.cancelJob();
    this.filmstrip.clear();
    if (this.videoEl) this.videoEl.src = "";
  }

  /* ---- construction --------------------------------------------------- */

  build(container) {
    this.headerEl = container.createDiv({ cls: "ve-header" });
    this.titleEl = this.headerEl.createDiv({ cls: "ve-title", text: "No video open" });
    this.infoEl = this.headerEl.createDiv({ cls: "ve-badge" });
    this.binaryEl = this.headerEl.createDiv({ cls: "ve-badge" });

    this.bodyEl = container.createDiv({ cls: "ve-body" });
    this.stageEl = this.bodyEl.createDiv({ cls: "ve-stage" });
    this.videoWrapEl = this.stageEl.createDiv({ cls: "ve-video" });
    this.videoEl = this.videoWrapEl.createEl("video", { cls: "ve-media" });
    this.videoEl.preload = "metadata";
    this.emptyEl = this.videoWrapEl.createDiv({
      cls: "ve-empty",
      text: "Open a video from the file explorer, the Media Viewer grid, or the command palette.",
    });

    this.buildToolbar(this.stageEl);
    this.buildTransport(this.stageEl);
    this.buildClips(this.bodyEl);
    this.buildProgress(container);
    this.wireVideo();
    this.wireKeys(container);
  }

  toolButton(parent, options) {
    const button = parent.createEl("button", { cls: "ve-tool" });
    if (options.icon && typeof setIcon === "function") {
      guarded("drawing", options.icon, () => setIcon(button, options.icon));
    }
    if (options.text) button.createSpan({ cls: "ve-tool-text", text: options.text });
    else if (!options.icon) button.setText(options.label || "");
    button.title = options.title || options.text || "";
    if (options.primary) button.addClass("is-primary");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      guarded("running", options.title || options.text, () => options.onClick(event));
    });
    return button;
  }

  buildToolbar(parent) {
    const bar = parent.createDiv({ cls: "ve-toolbar" });
    this.toolbarEl = bar;
    this.toolButton(bar, {
      icon: "chevrons-left",
      title: "Jump to the in point",
      onClick: () => this.seekTo(this.session.range.start),
    });
    this.toolButton(bar, {
      icon: "chevron-left",
      title: "Back one frame (,)",
      onClick: () => this.stepFrames(-1),
    });
    this.playButton = this.toolButton(bar, {
      icon: "play",
      text: "Play",
      title: "Play or pause (Space)",
      primary: true,
      onClick: () => this.togglePlay(),
    });
    this.toolButton(bar, {
      icon: "chevron-right",
      title: "Forward one frame (.)",
      onClick: () => this.stepFrames(1),
    });
    this.toolButton(bar, {
      icon: "chevrons-right",
      title: "Jump to the out point",
      onClick: () => this.seekTo(this.session.range.end),
    });

    bar.createDiv({ cls: "ve-sep" });
    this.toolButton(bar, {
      text: "[ In",
      title: "Set the in point to the playhead (I)",
      onClick: () => this.session.setStart(this.currentTime()),
    });
    this.toolButton(bar, {
      text: "Out ]",
      title: "Set the out point to the playhead (O)",
      onClick: () => this.session.setEnd(this.currentTime()),
    });
    this.toolButton(bar, {
      icon: "scissors",
      text: "Split",
      title: "Split the selection at the playhead (S)",
      onClick: () => this.splitHere(),
    });

    bar.createDiv({ cls: "ve-sep" });
    this.toolButton(bar, {
      icon: "plus",
      text: "Add clip",
      title: "Add the selection to the clip list (C)",
      onClick: () => this.addClip(),
    });
    this.toolButton(bar, {
      icon: "download",
      text: "Trim to file",
      title: "Write the selection as a new file",
      onClick: () => this.runTrim(),
    });
    this.toolButton(bar, {
      icon: "audio-lines",
      title: "Write the selection's audio as a new file",
      onClick: () => this.runAudio(),
    });

    bar.createDiv({ cls: "ve-sep" });
    this.speedButton = this.toolButton(bar, {
      text: formatSpeed(1),
      title: "Playback speed (Shift+, and Shift+.)",
      onClick: () => this.setSpeed(stepSpeed(this.speed, 1) === this.speed ? SPEEDS[0] : stepSpeed(this.speed, 1)),
    });
  }

  buildTransport(parent) {
    const transport = parent.createDiv({ cls: "ve-transport" });
    this.timesEl = transport.createDiv({ cls: "ve-times" });
    this.timelineEl = transport.createDiv({ cls: "ve-timeline" });
    this.stripEl = this.timelineEl.createDiv({ cls: "ve-strip" });
    this.beforeEl = this.timelineEl.createDiv({ cls: "ve-outside" });
    this.afterEl = this.timelineEl.createDiv({ cls: "ve-outside" });
    this.rangeEl = this.timelineEl.createDiv({ cls: "ve-range" });
    this.startHandleEl = this.timelineEl.createDiv({ cls: "ve-handle is-start" });
    this.endHandleEl = this.timelineEl.createDiv({ cls: "ve-handle is-end" });
    this.playheadEl = this.timelineEl.createDiv({ cls: "ve-playhead" });
    this.rulerEl = transport.createDiv({ cls: "ve-ruler" });
    this.wireTimeline();
  }

  buildClips(parent) {
    const panel = parent.createDiv({ cls: "ve-clips" });
    const head = panel.createDiv({ cls: "ve-clips-head" });
    this.clipCountEl = head.createSpan({ text: "Clips — 0" });
    this.clipTotalEl = head.createSpan({ text: "" });
    this.clipListEl = panel.createDiv({ cls: "ve-clip-list" });
    const foot = panel.createDiv({ cls: "ve-clips-foot" });
    this.exportButton = foot.createEl("button", { cls: "ve-export", text: "Export" });
    this.exportButton.addEventListener("click", () => this.runExport());
    this.clearButton = foot.createEl("button", { cls: "ve-clear", text: "Clear clips" });
    this.clearButton.addEventListener("click", () => this.session.clearClips());
  }

  buildProgress(parent) {
    this.progressEl = parent.createDiv({ cls: "ve-progress" });
    this.progressEl.addClass("is-idle");
    this.progressLabelEl = this.progressEl.createSpan({ cls: "ve-pct", text: "" });
    const bar = this.progressEl.createDiv({ cls: "ve-bar" });
    this.progressFillEl = bar.createSpan();
    this.cancelButton = this.progressEl.createEl("button", { cls: "ve-cancel", text: "Cancel" });
    this.cancelButton.addEventListener("click", () => this.cancelJob());
  }

  /* ---- wiring --------------------------------------------------------- */

  wireVideo() {
    const video = this.videoEl;
    video.addEventListener("loadedmetadata", () => this.onMetadata());
    video.addEventListener("timeupdate", () => this.renderPlayhead());
    video.addEventListener("seeked", () => this.renderPlayhead());
    video.addEventListener("play", () => this.renderPlayState());
    video.addEventListener("pause", () => this.renderPlayState());
    /* Playing past the out point stops there. The selection is the thing being
       judged, and running on into what was excluded is how you convince
       yourself the cut is in the wrong place. */
    video.addEventListener("timeupdate", () => {
      if (video.paused) return;
      if (video.currentTime > this.session.range.end) {
        video.pause();
        this.seekTo(this.session.range.end);
      }
    });
    video.addEventListener("error", () => {
      if (!this.file) return;
      new Notice("Obsidian cannot play " + this.file.name + ". Trimming may still work.");
    });
  }

  wireTimeline() {
    const start = (event, which) => {
      if (!this.session.duration) return;
      event.preventDefault();
      this.drag = which;
      this.applyDrag(event);
      const move = (moveEvent) => this.applyDrag(moveEvent);
      const stop = () => {
        this.drag = null;
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
    };
    this.startHandleEl.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      start(event, "start");
    });
    this.endHandleEl.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      start(event, "end");
    });
    this.timelineEl.addEventListener("pointerdown", (event) => start(event, "playhead"));
  }

  applyDrag(event) {
    if (!this.drag) return;
    const time = this.timeAtEvent(event);
    if (time === null) return;
    if (this.drag === "start") this.session.setStart(time);
    else if (this.drag === "end") this.session.setEnd(time);
    else this.seekTo(time);
  }

  timeAtEvent(event) {
    const box =
      typeof this.timelineEl.getBoundingClientRect === "function"
        ? this.timelineEl.getBoundingClientRect()
        : null;
    if (!box || !box.width) return null;
    return timeForPosition((Number(event.clientX) - box.left) / box.width, this.session.duration);
  }

  /* Keys, on the pane rather than globally.
   *
   * A global hotkey for Space would take the space bar away from every note in
   * the vault, so these are listened for on the pane's own element and only
   * fire while it has focus.
   */
  wireKeys(container) {
    container.tabIndex = 0;
    container.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const handled = this.handleKey(event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }

  /* One place that says what every key does, returning whether it claimed the
     event. Shift is checked before the bare key so that Shift+. is a speed
     change rather than a frame step at double speed. */
  handleKey(event) {
    const key = event.key;
    const actions = {
      " ": () => this.togglePlay(),
      ArrowRight: () => this.seekTo(seekTime(this.currentTime(), SEEK_STEP_SECONDS, this.session.duration)),
      ArrowLeft: () => this.seekTo(seekTime(this.currentTime(), -SEEK_STEP_SECONDS, this.session.duration)),
      i: () => this.session.setStart(this.currentTime()),
      o: () => this.session.setEnd(this.currentTime()),
      s: () => this.splitHere(),
      c: () => this.addClip(),
    };
    if (key === "," || key === ".") {
      const forward = key === ".";
      if (event.shiftKey) this.setSpeed(stepSpeed(this.speed, forward ? 1 : -1));
      else this.stepFrames(forward ? 1 : -1);
      return true;
    }
    const action = actions[key] || actions[String(key).toLowerCase()];
    if (!action) return false;
    action();
    return true;
  }

  /* ---- opening a file -------------------------------------------------- */

  async openFile(file) {
    if (!file) return;
    this.cancelJob();
    this.file = file;
    this.videoEl.src = this.app.vault.getResourcePath(file);
    this.titleEl.setText(file.name);
    this.emptyEl.style.display = "none";
    /* ffprobe rather than the video element's own metadata: the element knows
       duration and size but not the frame rate, and frame-stepping without a
       frame rate is a guess. */
    const info = await this.plugin.runner.probe(this.absoluteOf(file.path));
    this.session.open(file.path, info || { duration: 0 });
    if (!info) {
      new Notice("ffprobe could not read " + file.name + ". Trimming will be less precise.");
    }
    this.renderInfo();
    this.rebuildFilmstrip();
    if (typeof this.leaf.updateHeader === "function") this.leaf.updateHeader();
  }

  absoluteOf(vaultPath) {
    return guarded("locating", vaultPath, () => this.plugin.exporter.absolute(vaultPath), vaultPath);
  }

  /* The video element's own metadata, used only when ffprobe said nothing.
     A duration is enough to scrub with, and something to scrub with beats a
     dead pane. */
  onMetadata() {
    if (this.session.duration > 0) {
      this.renderState();
      return;
    }
    const duration = Number(this.videoEl.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.session.open(this.session.path, {
      duration,
      width: this.videoEl.videoWidth || null,
      height: this.videoEl.videoHeight || null,
      fps: null,
    });
    this.renderInfo();
    this.rebuildFilmstrip();
  }

  async rebuildFilmstrip() {
    this.stripEl.empty();
    this.stillUrls = [];
    const settings = this.plugin.settings;
    if (!settings.filmstrip || !this.session.path || !this.session.duration) return;
    if (this.plugin.runner.available === false) return;
    const width =
      this.timelineEl && this.timelineEl.clientWidth ? this.timelineEl.clientWidth : STILL_WIDTH * 8;
    const count = filmstripCount(width, STILL_WIDTH, settings.filmstripMax);
    const times = filmstripTimes(this.session.duration, count);
    const cells = [];
    for (let i = 0; i < times.length; i += 1) {
      cells.push(this.stripEl.createDiv({ cls: "ve-still" }));
    }
    await this.filmstrip.generate(this.session.path, times, (index, url) => {
      const cell = cells[index];
      if (!cell) return;
      cell.style.backgroundImage = "url(" + url + ")";
      cell.addClass("has-still");
    });
  }

  /* ---- transport ------------------------------------------------------- */

  currentTime() {
    return clampTime(Number(this.videoEl.currentTime) || 0, this.session.duration);
  }

  seekTo(time) {
    const at = clampTime(time, this.session.duration);
    this.videoEl.currentTime = at;
    this.renderPlayhead();
    return at;
  }

  togglePlay() {
    if (!this.file) return;
    if (this.videoEl.paused) {
      // Starting outside the selection is almost always a stale playhead
      // rather than an intention, so play begins at the in point.
      if (!rangeContains(this.session.range, this.currentTime())) this.seekTo(this.session.range.start);
      const played = this.videoEl.play();
      if (played && typeof played.catch === "function") {
        played.catch((error) => reportFailure("playing", this.file.path, error));
      }
    } else {
      this.videoEl.pause();
    }
  }

  stepFrames(frames) {
    this.videoEl.pause();
    this.seekTo(frameStepTime(this.currentTime(), frames, this.session.fps, this.session.duration));
  }

  setSpeed(rate) {
    this.speed = clampSpeed(rate);
    this.videoEl.playbackRate = this.speed;
    if (!this.speedButton) return;
    /* Rebuilt rather than setText, which replaces a button's children in the
       real DOM and would drop the label span the narrow-pane rule hides. */
    this.speedButton.empty();
    this.speedButton.createSpan({ cls: "ve-tool-text", text: formatSpeed(this.speed) });
  }

  splitHere() {
    if (!this.session.path) return;
    if (!this.session.split(this.currentTime())) {
      new Notice("Put the playhead inside the selection, away from its edges, to split there.");
    }
  }

  addClip() {
    if (!this.session.path) {
      new Notice("Open a video first.");
      return;
    }
    this.session.addClip();
  }

  /* ---- jobs ------------------------------------------------------------ */

  busy() {
    return Boolean(this.job);
  }

  /* One job at a time, and the slot is claimed before anything is awaited.
   *
   * Claiming it after the ffmpeg check meant two clicks on Trim in the same
   * moment both got past the guard — the second arrived while the first was
   * still inside its first await. Two ffmpeg processes then wrote to two
   * files, and the second one's record named a clip the user never asked for.
   */
  async withJob(label, work) {
    if (this.busy()) {
      new Notice("One job at a time — " + this.job.label + " is still running.");
      return null;
    }
    const signal = { cancelled: false };
    this.job = { label, signal };
    this.renderProgress(0, label);
    try {
      if (!(await this.plugin.runner.check())) {
        new Notice(missingBinaryMessage("ffmpeg", this.plugin.settings.ffmpegPath));
        return null;
      }
      return await work(signal);
    } catch (error) {
      if (error instanceof CancelledError || (error && error.cancelled)) {
        new Notice(label + " cancelled.");
        return null;
      }
      reportFailure(label.toLowerCase(), this.file ? this.file.path : "", error);
      new Notice(label + " failed: " + errorText(error));
      return null;
    } finally {
      this.job = null;
      this.renderProgress(null);
    }
  }

  cancelJob() {
    if (!this.job) return;
    this.job.signal.cancelled = true;
    this.plugin.runner.killAll();
  }

  async runTrim() {
    if (!this.session.path) {
      new Notice("Open a video first.");
      return;
    }
    const info = this.session.info || {};
    const result = await this.withJob("Trim", (signal) =>
      this.plugin.exporter.trim(this.session.path, this.session.range, {
        signal,
        width: info.width,
        height: info.height,
      })
    );
    if (result) this.announce(result.path, "Trimmed");
  }

  async runAudio() {
    if (!this.session.path) {
      new Notice("Open a video first.");
      return;
    }
    const result = await this.withJob("Audio extraction", (signal) =>
      this.plugin.exporter.extractAudio(this.session.path, this.session.range, { signal })
    );
    if (result) this.announce(result.path, "Extracted");
  }

  async runExport() {
    if (!this.session.clips.length) {
      new Notice("Add at least one clip first.");
      return;
    }
    const info = this.session.info || {};
    const result = await this.withJob("Export", (signal) =>
      this.plugin.exporter.exportClips(this.session.clips, {
        signal,
        width: info.width,
        height: info.height,
      })
    );
    if (result) this.announce(result.path, "Exported");
  }

  announce(path, verb) {
    new Notice(verb + " to " + baseNameOf(path));
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.app.workspace.trigger("video-editor:created", file);
    }
  }

  /* ---- rendering ------------------------------------------------------- */

  renderState() {
    this.renderTimes();
    this.renderRange();
    this.renderPlayhead();
    this.renderRuler();
    this.renderClips();
  }

  renderInfo() {
    const info = this.session.info || {};
    const parts = [];
    if (info.width && info.height) parts.push(info.width + "×" + info.height);
    if (info.fps) parts.push((Math.round(info.fps * 100) / 100) + " fps");
    if (this.session.duration) parts.push(formatTimecode(this.session.duration, { withHours: true }));
    if (info.sizeBytes) parts.push(formatBytes(info.sizeBytes));
    this.infoEl.setText(parts.join(" · "));
    this.renderState();
  }

  renderBinaryState() {
    const runner = this.plugin.runner;
    if (runner.available) {
      this.binaryEl.setText("ffmpeg " + (runner.version || "ready"));
      this.binaryEl.addClass("is-ok");
      this.binaryEl.removeClass("is-missing");
      return;
    }
    this.binaryEl.setText("ffmpeg missing");
    this.binaryEl.addClass("is-missing");
    this.binaryEl.removeClass("is-ok");
    this.binaryEl.title = missingBinaryMessage("ffmpeg", this.plugin.settings.ffmpegPath);
  }

  renderTimes() {
    const range = this.session.range;
    this.timesEl.empty();
    const pair = (label, value) => {
      const span = this.timesEl.createSpan();
      span.createSpan({ text: label + " " });
      span.createEl("b", { text: value });
    };
    pair("at", formatTimecode(this.currentTime(), { millis: true, withHours: true }));
    pair("in", formatTimecode(range.start, { millis: true, withHours: true }));
    pair("out", formatTimecode(range.end, { millis: true, withHours: true }));
    pair("selected", formatDuration(rangeDuration(range)));
  }

  renderRange() {
    const duration = this.session.duration;
    const range = this.session.range;
    const from = positionForTime(range.start, duration) * 100;
    const to = positionForTime(range.end, duration) * 100;
    this.beforeEl.style.left = "0";
    this.beforeEl.style.width = from + "%";
    this.afterEl.style.left = to + "%";
    this.afterEl.style.width = Math.max(0, 100 - to) + "%";
    this.rangeEl.style.left = from + "%";
    this.rangeEl.style.width = Math.max(0, to - from) + "%";
    this.startHandleEl.style.left = "calc(" + from + "% - 5px)";
    this.endHandleEl.style.left = "calc(" + to + "% - 5px)";
  }

  renderPlayhead() {
    const at = positionForTime(this.currentTime(), this.session.duration) * 100;
    this.playheadEl.style.left = at + "%";
    this.renderTimes();
  }

  renderPlayState() {
    if (!this.playButton) return;
    const paused = this.videoEl.paused;
    this.playButton.empty();
    if (typeof setIcon === "function") {
      guarded("drawing", "play", () => setIcon(this.playButton, paused ? "play" : "pause"));
    }
    this.playButton.createSpan({ cls: "ve-tool-text", text: paused ? "Play" : "Pause" });
  }

  renderRuler() {
    this.rulerEl.empty();
    for (const tick of rulerTicks(this.session.duration, RULER_TICKS)) {
      this.rulerEl.createSpan({ text: tick.label });
    }
  }

  renderClips() {
    const clips = this.session.clips;
    this.clipCountEl.setText("Clips — " + clips.length);
    this.clipTotalEl.setText(clips.length ? formatTimecode(this.session.totalClipSeconds()) + " total" : "");
    this.clipListEl.empty();
    this.exportButton.disabled = !clips.length;
    this.exportButton.setText(clips.length ? "Export " + clips.length + " clip" + (clips.length === 1 ? "" : "s") : "Export");
    clips.forEach((clip, index) => this.renderClip(clip, index));
  }

  renderClip(clip, index) {
    const row = this.clipListEl.createDiv({ cls: "ve-clip" });
    if (index === this.session.selected) row.addClass("is-selected");
    row.draggable = true;
    row.dataset.index = String(index);
    const body = row.createDiv({ cls: "ve-clip-body" });
    body.createDiv({ cls: "ve-clip-name", text: baseNameOf(clip.path) });
    body.createDiv({ cls: "ve-clip-span", text: rangeLabel(clip) });
    const remove = row.createEl("button", { cls: "ve-clip-remove", text: "×" });
    remove.title = "Remove this clip";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      this.session.removeClip(index);
    });
    row.addEventListener("click", () => {
      this.session.selectClip(index);
      // Selecting a clip moves the selection to it, so the video shows what
      // the row is talking about rather than leaving them out of step.
      if (clip.path === this.session.path) {
        this.session.setRange({ start: clip.start, end: clip.end });
        this.seekTo(clip.start);
      }
    });
    row.addEventListener("dragstart", (event) => {
      if (event.dataTransfer) event.dataTransfer.setData("text/plain", String(index));
    });
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = event.dataTransfer ? Number(event.dataTransfer.getData("text/plain")) : NaN;
      if (Number.isInteger(from)) this.session.moveClip(from, index);
    });
  }

  /* `percent` of null means "no job": the row goes quiet rather than
     disappearing, so the layout does not jump every time one finishes. */
  renderProgress(percent, label) {
    if (percent === null || percent === undefined) {
      this.progressEl.addClass("is-idle");
      this.progressLabelEl.setText("");
      this.progressFillEl.style.width = "0%";
      return;
    }
    this.progressEl.removeClass("is-idle");
    const pct = Math.round(percent * 100);
    this.progressFillEl.style.width = pct + "%";
    this.progressLabelEl.setText((label || "Working") + " " + pct + "%");
  }

  // Called by the plugin's exporter as ffmpeg reports. Kept separate from
  // renderProgress so the ETA maths has the numbers it needs.
  onJobProgress(update) {
    if (!this.job) return;
    const percent = Number(update.percent) || 0;
    this.progressEl.removeClass("is-idle");
    const pct = Math.round(percent * 100);
    this.progressFillEl.style.width = pct + "%";
    let tail = "";
    if (update.speed && percent > 0 && percent < 1) {
      const totalSeconds = this.jobTotalSeconds();
      const eta = etaSeconds(percent * totalSeconds, totalSeconds, update.speed);
      tail = eta === null ? "" : " · " + formatEta(eta);
    }
    this.progressLabelEl.setText((update.label || this.job.label) + " " + pct + "%" + tail);
  }

  jobTotalSeconds() {
    if (this.session.clips.length && this.job && this.job.label === "Export") {
      return this.session.totalClipSeconds();
    }
    return rangeDuration(this.session.range);
  }
}

/* ------------------------------------------------------------------------ *
 * Settings.
 * ------------------------------------------------------------------------ */

class VideoEditorSettingTab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("ffmpeg").setHeading();

    new Setting(containerEl)
      .setName("ffmpeg path")
      .setDesc("Leave empty to use the one on PATH. Give a full path if it is installed somewhere else.")
      .addText((text) =>
        text
          .setPlaceholder("ffmpeg")
          .setValue(this.plugin.settings.ffmpegPath)
          .onChange(async (value) => {
            this.plugin.settings.ffmpegPath = String(value).trim();
            await this.plugin.saveSettings();
            this.plugin.runner.forget();
          })
      );

    new Setting(containerEl)
      .setName("ffprobe path")
      .setDesc("Usually beside ffmpeg. Without it, frame-stepping falls back to 30 fps.")
      .addText((text) =>
        text
          .setPlaceholder("ffprobe")
          .setValue(this.plugin.settings.ffprobePath)
          .onChange(async (value) => {
            this.plugin.settings.ffprobePath = String(value).trim();
            await this.plugin.saveSettings();
            this.plugin.runner.forget();
          })
      );

    new Setting(containerEl)
      .setName("Check for ffmpeg")
      .setDesc(this.plugin.runner.available ? "Found: " + this.plugin.runner.version : "Not found yet.")
      .addButton((button) =>
        button.setButtonText("Check now").onClick(async () => {
          const found = await this.plugin.runner.check(true);
          new Notice(found ? "ffmpeg " + this.plugin.runner.version : missingBinaryMessage("ffmpeg", this.plugin.settings.ffmpegPath));
          this.display();
        })
      );

    new Setting(containerEl).setName("Output").setHeading();

    new Setting(containerEl)
      .setName("Cutting")
      .setDesc(
        "Stream copy is near-instant and lossless, but a cut can only land on a keyframe. " +
          "Re-encode is frame-exact and costs real time on a long file."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption(MODE_COPY, "Stream copy — fast, keyframe-aligned")
          .addOption(MODE_ENCODE, "Re-encode — exact, slow")
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            this.plugin.settings.mode = value === MODE_ENCODE ? MODE_ENCODE : MODE_COPY;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Re-encode quality")
      .setDesc("x264 CRF. Lower is better and bigger; 18 is visually lossless, 28 is small.")
      .addSlider((slider) =>
        slider
          .setLimits(14, 32, 1)
          .setValue(this.plugin.settings.crf)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.crf = clampCrf(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Leave empty to write beside the source, which keeps a clip with its walkthrough.")
      .addText((text) =>
        text
          .setPlaceholder("beside the source")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = String(value).trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Record folder")
      .setDesc("Where MediaInstance notes are created. Existing notes are found by what they declare, not by where they sit.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_NOTE_FOLDER)
          .setValue(this.plugin.settings.noteFolder)
          .onChange(async (value) => {
            this.plugin.settings.noteFolder = String(value).trim() || DEFAULT_NOTE_FOLDER;
            await this.plugin.saveSettings();
            this.plugin.store.noteFolder = this.plugin.settings.noteFolder;
          })
      );

    new Setting(containerEl).setName("Timeline").setHeading();

    new Setting(containerEl)
      .setName("Filmstrip")
      .setDesc("Thumbnails along the timeline. Each one is an ffmpeg seek, so this costs a little when a file opens.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.filmstrip).onChange(async (value) => {
          this.plugin.settings.filmstrip = Boolean(value);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Most thumbnails")
      .setDesc("The strip costs the same for a ten-second clip and a sixty-minute one, because the count comes from the pane's width rather than the duration.")
      .addSlider((slider) =>
        slider
          .setLimits(4, 64, 4)
          .setValue(this.plugin.settings.filmstripMax)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.filmstripMax = Number(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Log ffmpeg commands")
      .setDesc("Every argument list and every timing to the console.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
          this.plugin.settings.debug = Boolean(value);
          await this.plugin.saveSettings();
        })
      );
  }
}

/* ------------------------------------------------------------------------ *
 * The plugin.
 * ------------------------------------------------------------------------ */

class VideoEditorPlugin extends Plugin {
  async onload() {
    this.settings = normaliseSettings(await this.loadData());

    this.runner = new FfmpegRunner({ getSettings: () => this.settings });
    this.store = new LineageStore(this.app, { noteFolder: this.settings.noteFolder });
    this.exporter = new ExportRunner({
      app: this.app,
      runner: this.runner,
      store: this.store,
      getSettings: () => this.settings,
      onProgress: (update) => {
        const view = this.activeView();
        if (view) view.onJobProgress(update);
      },
    });

    this.registerView(VIEW_TYPE_VIDEO_EDITOR, (leaf) => new VideoEditorView(leaf, this));

    this.app.workspace.onLayoutReady(() => {
      guarded("building", "lineage", () => this.store.build());
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file, data, cache) => {
        this.store.handleMetadataChange(file, data, cache);
      })
    );
    this.registerEvent(this.app.vault.on("delete", (file) => this.store.handleDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.store.handleRename(file, oldPath)));

    /* The integration with Media Viewer, and it is one line.
     *
     * Media Viewer's grid triggers Obsidian's own "file-menu" for the tile
     * under the cursor, so listening for it puts this item in the grid's
     * context menu as well as the file explorer's — without either plugin
     * knowing the other exists. */
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, target) => {
        if (!(target instanceof TFile) || !isVideoPath(target.path)) return;
        menu.addItem((item) =>
          item
            .setTitle("Open in Video Editor")
            .setIcon("scissors")
            .onClick(() => this.openIn(target))
        );
      })
    );

    this.addRibbonIcon("scissors", "Video Editor", () => this.openActive());

    this.addCommand({
      id: "open-video-editor",
      name: "Open the video editor",
      callback: () => this.openActive(),
    });
    this.addCommand({
      id: "open-active-video",
      name: "Open the active file in the video editor",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const usable = Boolean(file && isVideoPath(file.path));
        if (usable && !checking) this.openIn(file);
        return usable;
      },
    });
    this.addCommand({
      id: "set-in-point",
      name: "Set the in point to the playhead",
      checkCallback: (checking) => this.withView(checking, (view) => view.session.setStart(view.currentTime())),
    });
    this.addCommand({
      id: "set-out-point",
      name: "Set the out point to the playhead",
      checkCallback: (checking) => this.withView(checking, (view) => view.session.setEnd(view.currentTime())),
    });
    this.addCommand({
      id: "add-clip",
      name: "Add the selection to the clip list",
      checkCallback: (checking) => this.withView(checking, (view) => view.addClip()),
    });
    this.addCommand({
      id: "split-at-playhead",
      name: "Split the selection at the playhead",
      checkCallback: (checking) => this.withView(checking, (view) => view.splitHere()),
    });
    this.addCommand({
      id: "trim-selection",
      name: "Trim the selection to a new file",
      checkCallback: (checking) => this.withView(checking, (view) => view.runTrim()),
    });
    this.addCommand({
      id: "export-clips",
      name: "Export the clip list",
      checkCallback: (checking) => this.withView(checking, (view) => view.runExport()),
    });
    this.addCommand({
      id: "extract-audio",
      name: "Extract the selection's audio",
      checkCallback: (checking) => this.withView(checking, (view) => view.runAudio()),
    });
    this.addCommand({
      id: "cancel-job",
      name: "Cancel the running job",
      checkCallback: (checking) => {
        const view = this.activeView();
        const usable = Boolean(view && view.busy());
        if (usable && !checking) view.cancelJob();
        return usable;
      },
    });

    this.addSettingTab(new VideoEditorSettingTab(this.app, this));
  }

  onunload() {
    // An hour-long encode does not get to outlive the plugin that started it.
    if (this.runner) this.runner.killAll();
  }

  withView(checking, action) {
    const view = this.activeView();
    if (!view || !view.session.path) return false;
    if (!checking) action(view);
    return true;
  }

  activeView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VIDEO_EDITOR);
    for (const leaf of leaves) {
      if (leaf.view instanceof VideoEditorView) return leaf.view;
    }
    return null;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async ensureLeaf() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_VIDEO_EDITOR);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    // A tab in the main area, not a sidebar: a video needs the room, and the
    // clip list needs it more.
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_VIDEO_EDITOR, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async openIn(file) {
    const leaf = await this.ensureLeaf();
    const view = leaf.view;
    if (view instanceof VideoEditorView) await view.openFile(file);
  }

  async openActive() {
    const file = this.app.workspace.getActiveFile();
    if (file && isVideoPath(file.path)) {
      await this.openIn(file);
      return;
    }
    await this.ensureLeaf();
  }
}

module.exports = VideoEditorPlugin;
module.exports.core = core;
module.exports.FfmpegRunner = FfmpegRunner;
module.exports.CancelledError = CancelledError;
module.exports.Filmstrip = Filmstrip;
module.exports.TrimSession = TrimSession;
module.exports.LineageStore = LineageStore;
module.exports.ExportRunner = ExportRunner;
module.exports.VideoEditorView = VideoEditorView;
module.exports.VideoEditorSettingTab = VideoEditorSettingTab;
module.exports.VIEW_TYPE_VIDEO_EDITOR = VIEW_TYPE_VIDEO_EDITOR;
