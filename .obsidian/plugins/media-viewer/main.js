const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, TFile, TFolder } = require("obsidian");

const VIEW_TYPE_MEDIA_VIEWER = "media-viewer-pane";

// Hoisted above the settings because the settings default to it. See the
// encoding block in core for why a lossy default exists at all.
const DEFAULT_ENCODE_QUALITY = 0.92;

// Where new lineage notes are written. Discovery never uses it — a note moved
// out of the folder keeps working — so it is only ever the answer to "where
// should this new one go". Hoisted here because the settings default to it.
const DEFAULT_NOTE_FOLDER = "data/media";

// Deliberately small. Anything the user can see in the pane header lives here
// so the pane comes back the way they left it, and nothing else does.
// Where the crash log is written, and how much of it is kept. A support tool
// whose log grows without bound becomes the problem it was meant to report, so
// the file is trimmed from the front — the newest failure is the one being
// asked about.
const CRASH_LOG_PATH = ".obsidian/plugins/media-viewer/crash.log";
const CRASH_LOG_MAX_BYTES = 262144;
// Entries held in memory for "Copy crash log", so the command answers without
// a file read and still works if the write failed.
const CRASH_LOG_BUFFER = 300;
// A failure usually arrives with friends — one bad file in a loop, or a
// re-render that throws on every frame. One notice per this many milliseconds
// says something is wrong without burying the app in toasts.
const CRASH_NOTICE_INTERVAL_MS = 15000;

const DEFAULT_SETTINGS = {
  lastFolder: null,
  recursive: false,
  filter: "both",
  // Following is what makes the pane feel connected to the file explorer, so
  // it starts on. Choosing a folder from its context menu pins the pane, which
  // is the only way an explicit choice can survive the next click.
  followActiveFile: true,
  // Off by default. What it turns on is `ms=` lines on the console for the
  // operations that historically hurt — MV-TIMING says which — and nothing
  // else. There is no log file: Electron's console already filters, persists
  // and survives the failure, which is what the old app's crash log was for.
  debugLogging: false,
  // What a JPEG or WebP output is encoded at. PNG ignores it: passing a
  // quality for a lossless format is a number that looks meaningful and is
  // not.
  encodeQuality: DEFAULT_ENCODE_QUALITY,
  // Where new lineage notes are written. Only ever an answer to "where should
  // this new one go" — a note moved out of it keeps working, because
  // discovery is by the media: link and never by location.
  noteFolder: DEFAULT_NOTE_FOLDER,
  // Off writes no lineage at all. The plugin still browses and still edits;
  // what stops is the record, which is a choice someone editing a vault they
  // do not want indexed should have.
  writeLineage: true,
  // On by default, unlike debugLogging. This is not tracing — it is the record
  // of things that actually went wrong, which is worth having before anyone
  // knows they need it.
  crashLog: true,
};

/* ------------------------------------------------------------------------ *
 * core — pure functions. No Obsidian API, no I/O, no `this`.
 * Everything between this banner and the next one runs under plain node with
 * a stubbed `require("obsidian")`, which is the only way this maths gets
 * verified without launching Obsidian. See tests/core.test.js.
 * ------------------------------------------------------------------------ */

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "avif"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"];
// Everything a lineage note writes below this marker is the user's, and is
// carried across every rewrite — the convention Schema Sync established here.
const NOTES_MARKER = "<!-- media-viewer:notes -->";

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 32;

// Loaded thumbnails held at once. Comfortably more than any pane can show —
// a wide split at the smallest tile size is around sixty — so eviction only
// ever reclaims tiles that have scrolled well away.
const THUMBNAIL_CACHE_SIZE = 240;
// How far outside the viewport a tile starts loading. Enough that a normal
// scroll finds thumbnails already there, small enough that a flick through a
// 500-file folder does not try to load all of it.
const THUMBNAIL_PRELOAD_MARGIN = "300px 0px";

// The wheel steps finer than the keyboard: a wheel is a continuous gesture the
// user modulates by how far they spin it, where W and S are discrete presses
// and want to cover ground.
const ZOOM_WHEEL_RATIO = 1.12;
const ZOOM_KEY_RATIO = 1.25;

// W and S seek by five seconds, the step every video player has settled on: far
// enough to skip past something, short enough to land near it.
const VIDEO_SEEK_SECONDS = 5;
// One frame, assumed. HTMLVideoElement reports no frame rate and no frame
// index, and the APIs that come close — requestVideoFrameCallback's metadata,
// WebCodecs — describe frames that have already been shown rather than the one
// before the current position. So a step is a fixed nudge of a thirtieth of a
// second: right for 30fps material, near enough on 24 and 25, half a step on
// 60. MV-REVERSE measures real timings and can revisit this.
const VIDEO_FRAME_SECONDS = 1 / 30;
// The scrub bar ranges over a fixed number of steps rather than over the
// duration, so its max never changes as metadata arrives and both conversions
// stay pure. A thousand steps is finer than the bar is ever wide in pixels, so
// no position on it is unreachable by a drag.
const SCRUB_RESOLUTION = 1000;
// The speeds worth having, as a ladder rather than a continuous range. A
// slider from 0.25 to 4 would offer 2.87x, which nobody wants and which makes
// 1x — the speed every viewing returns to — a thing to hunt for. Uneven at the
// top because the difference between 3x and 4x matters less than the
// difference between 1x and 1.25x.
const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const SPEED_MIN = SPEED_STEPS[0];
const SPEED_MAX = SPEED_STEPS[SPEED_STEPS.length - 1];

// Where a video thumbnail is taken from. One second in, because frame zero of
// a great many videos is black, a fade, or a slate — the one frame that says
// least about the file.
const VIDEO_THUMBNAIL_SECONDS = 1;
// Long edge of the drawn frame. The grid's tiles top out around 160 CSS pixels,
// so this covers a 2x display with room to spare and no more: the frames are
// held as blobs, and full-size ones would be megabytes of memory for pixels
// nothing can show.
const VIDEO_THUMBNAIL_MAX_EDGE = 320;
// How many videos are decoded at once. Seeking is disk-bound and the design's
// open risks name a folder of videos as a candidate for the old app's
// thumbnail stalls, so the queue is deliberately narrow: two keeps a drive
// busy without a folder of 500 trying to open 500 decoders.
const VIDEO_THUMBNAIL_CONCURRENCY = 2;
// A video that never reports metadata, or never finishes seeking, would hold a
// queue slot for the rest of the session. Ten seconds is far longer than a
// local file needs and short enough that a bad one does not stall the folder.
const VIDEO_THUMBNAIL_TIMEOUT_MS = 10000;
// Generated frames held as blob URLs. Smaller than the tile cache because
// these cost real memory rather than a browser-managed decode, and because a
// re-seek is the expensive thing being avoided — a frame kept is a disk read
// not repeated when the user scrolls back.
const VIDEO_FRAME_CACHE_SIZE = 120;

// Encoding follows the source, because encoding everything to PNG turns a 2 MB
// JPEG crop into a 15 MB file. Rotation, flipping and cropping never introduce
// transparency, so a JPEG source stays safely a JPEG.
/* What a pasted image is called, by what the clipboard says it is.
 *
 * Not the inverse of MIME_BY_EXTENSION below: that map answers "what should
 * this be encoded as", which deliberately sends BMP and GIF to PNG. This one
 * answers "what did I just receive", where a GIF must stay a GIF — the bytes
 * are already decided and renaming them would be a lie about the file. */
const EXTENSION_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

const MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  png: "image/png",
  bmp: "image/png",
  gif: "image/png",
};

// Vault paths use forward slashes, but a path can arrive from a drag or a
// clipboard carrying Windows separators, so both are normalised on the way in.
function normaliseSeparators(path) {
  return String(path == null ? "" : path).split("\\").join("/");
}

function baseNameOf(path) {
  const normalised = normaliseSeparators(path);
  const slash = normalised.lastIndexOf("/");
  return slash === -1 ? normalised : normalised.slice(slash + 1);
}

function folderOf(path) {
  const normalised = normaliseSeparators(path);
  const slash = normalised.lastIndexOf("/");
  return slash === -1 ? "" : normalised.slice(0, slash);
}

// "a/b/cover.PNG" -> "png". A name with no dot, or one ending in a dot, has no
// extension; a dotfile like ".gitignore" is a name, not an extension.
function extensionOf(path) {
  const name = baseNameOf(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

// The file name without its extension. Names carrying the plugin's own
// "+clone+" and "+frame+" markers keep them, so a crop of a crop stacks its
// provenance in the name rather than flattening it.
function stemOf(path) {
  const name = baseNameOf(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

function joinPath(folder, name) {
  const clean = normaliseSeparators(folder).replace(/\/+$/, "");
  return clean ? clean + "/" + name : name;
}

// Unknown and unrecognised extensions classify as "other" rather than throwing,
// so one odd file in a folder cannot take down the scan.
function classifyExtension(extension) {
  const normalised = String(extension == null ? "" : extension).toLowerCase().replace(/^\./, "");
  if (IMAGE_EXTENSIONS.includes(normalised)) return "image";
  if (VIDEO_EXTENSIONS.includes(normalised)) return "video";
  return "other";
}

function classifyPath(path) {
  return classifyExtension(extensionOf(path));
}

function isMediaPath(path) {
  return classifyPath(path) !== "other";
}

// The filter the grid applies. "both" is the default; "image" and "video" are
// the two single-kind cases.
function matchesFilter(path, filter) {
  if (filter === "image") return classifyPath(path) === "image";
  if (filter === "video") return classifyPath(path) === "video";
  return isMediaPath(path);
}

function mimeForExtension(extension) {
  const normalised = String(extension == null ? "" : extension).toLowerCase().replace(/^\./, "");
  return MIME_BY_EXTENSION[normalised] || "image/png";
}

// The extension a save writes, given the source extension. Anything that is
// not JPEG or WebP becomes PNG.
function outputExtensionFor(extension) {
  const mime = mimeForExtension(extension);
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

function clampZoom(zoom) {
  const value = Number(zoom);
  // Only NaN is nonsense. An infinity is a direction, and accumulated zoom
  // steps that overflow should land on the ceiling rather than snap back to
  // 100% under the user.
  if (Number.isNaN(value)) return 1;
  if (value < ZOOM_MIN) return ZOOM_MIN;
  if (value > ZOOM_MAX) return ZOOM_MAX;
  return value;
}

// Wheel and W/S both step by a fixed ratio, so a step up followed by a step
// down returns where it started — except at the clamps, where it cannot.
function stepZoom(zoom, steps, ratio) {
  const factor = Number.isFinite(Number(ratio)) && Number(ratio) > 1 ? Number(ratio) : 1.25;
  const count = Number(steps);
  if (!Number.isFinite(count) || count === 0) return clampZoom(zoom);
  return clampZoom(clampZoom(zoom) * Math.pow(factor, count));
}

// Fit the whole image inside the pane, never magnifying past 100%: a small
// thumbnail blown up to fill a wide pane looks worse than the same thumbnail
// shown at its own size.
function fitZoom(imageWidth, imageHeight, paneWidth, paneHeight) {
  const iw = Number(imageWidth);
  const ih = Number(imageHeight);
  const pw = Number(paneWidth);
  const ph = Number(paneHeight);
  if (!(iw > 0 && ih > 0 && pw > 0 && ph > 0)) return 1;
  return clampZoom(Math.min(pw / iw, ph / ih, 1));
}

/* Panning.
 *
 * The pan offset is the image's centre measured from the viewport's centre, in
 * CSS pixels. Centre-relative rather than top-left-relative because it makes
 * the two states that matter symmetrical: an image smaller than the viewport
 * has a pan limit of zero and so sits centred by construction, and an image
 * larger than it is free to move exactly as far as its overhang in each
 * direction.
 */
function panLimit(contentSize, viewportSize) {
  const content = Number(contentSize);
  const viewport = Number(viewportSize);
  if (!(content > 0) || !(viewport > 0)) return 0;
  return Math.max(0, (content - viewport) / 2);
}

function clampPan(offset, contentSize, viewportSize) {
  const value = Number(offset);
  if (!Number.isFinite(value)) return 0;
  const limit = panLimit(contentSize, viewportSize);
  // The `|| 0` is not decoration: clamping a negative value against a limit of
  // zero yields -0, which reaches the CSS as "translate(-0px, ...)".
  if (value < -limit) return -limit || 0;
  if (value > limit) return limit;
  return value || 0;
}

// Zooming about a point keeps whatever is under the cursor under the cursor.
// `cursor` is measured from the viewport centre, in the same space as `pan`.
//
// The image coordinate under the cursor is (cursor - pan) / oldZoom; holding it
// fixed at the new zoom gives the pan below. Without this, wheel-zooming into a
// detail walks it off the screen and the user chases it with the mouse.
function panAfterZoom(pan, cursor, oldZoom, newZoom) {
  const from = Number(oldZoom);
  const to = Number(newZoom);
  const offset = Number(pan);
  const at = Number(cursor);
  if (!(from > 0) || !(to > 0) || !Number.isFinite(offset) || !Number.isFinite(at)) return offset || 0;
  return at - (at - offset) * (to / from);
}

// Playback position, kept inside the media. A video whose metadata has not
// arrived reports a duration of NaN, which is why each of these treats an
// unknown duration as zero rather than letting it reach a currentTime the
// element would reject.
function clampTime(time, duration) {
  const value = Number(time);
  const limit = Number(duration);
  const max = Number.isFinite(limit) && limit > 0 ? limit : 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > max ? max : value;
}

// Seeking and frame-stepping are one operation at two scales, so they are one
// function: a signed distance from where the head is now.
function seekTime(current, delta, duration) {
  const step = Number(delta);
  return clampTime(clampTime(current, duration) + (Number.isFinite(step) ? step : 0), duration);
}

function frameStepTime(current, frames, duration, frameSeconds) {
  const size = Number(frameSeconds);
  const unit = Number.isFinite(size) && size > 0 ? size : VIDEO_FRAME_SECONDS;
  const count = Number(frames);
  return seekTime(current, (Number.isFinite(count) ? count : 0) * unit, duration);
}

// Position on the scrub bar, as an integer step. Zero while the duration is
// unknown — which is also when the bar is disabled.
function scrubPositionFor(time, duration, resolution) {
  const steps = scrubSteps(resolution);
  const length = Number(duration);
  if (!Number.isFinite(length) || length <= 0) return 0;
  return Math.round((clampTime(time, length) / length) * steps);
}

// The other direction: where a drag to this step lands in the media.
function timeFromScrub(position, duration, resolution) {
  const steps = scrubSteps(resolution);
  const length = Number(duration);
  if (!Number.isFinite(length) || length <= 0) return 0;
  const at = Number(position);
  if (!Number.isFinite(at)) return 0;
  return clampTime((Math.min(Math.max(at, 0), steps) / steps) * length, length);
}

function scrubSteps(resolution) {
  const steps = Number(resolution);
  return Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : SCRUB_RESOLUTION;
}

// m:ss, or h:mm:ss once there is an hour to show. Seconds floor rather than
// round, so the readout never shows a time the head has not reached: a counter
// that reads 1:20 on a 1:20 video half a second early looks like playback
// stopped short. An unknown duration reads as dashes rather than 0:00, because
// "not known yet" and "empty" are different states.
function formatTimecode(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "--:--";
  const total = Math.floor(value);
  const pad = (n) => String(n).padStart(2, "0");
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
}

/* Playback speed. Browsers accept rates outside this range and behave badly
   there — muted audio, dropped frames, and on some builds a stall that only a
   reload clears — so the ladder is also the limit. */
function clampSpeed(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(Math.max(value, SPEED_MIN), SPEED_MAX);
}

// The rung nearest a rate. A speed can arrive from a restored value or from an
// element that rounded it, and the control has to show one of its own options
// rather than an empty box.
function nearestSpeed(rate) {
  const value = clampSpeed(rate);
  let best = SPEED_STEPS[0];
  for (const step of SPEED_STEPS) {
    if (Math.abs(step - value) < Math.abs(best - value)) best = step;
  }
  return best;
}

// Up or down the ladder. Holding at the ends rather than wrapping: 4x wrapping
// to 0.25x on one extra press is a mistake that takes a moment to understand
// and several to undo.
function stepSpeed(rate, steps) {
  const count = Math.trunc(Number(steps)) || 0;
  const at = SPEED_STEPS.indexOf(nearestSpeed(rate));
  const next = Math.min(Math.max(at + count, 0), SPEED_STEPS.length - 1);
  return SPEED_STEPS[next];
}

// "1x", "0.25x". Trailing zeros go, because 0.50x reads as a precision the
// control does not have.
function formatSpeed(rate) {
  const value = Number(rate);
  return (Number.isFinite(value) && value > 0 ? String(Number(value.toFixed(2))) : "1") + "x";
}

/* Where in a video its thumbnail comes from. One second in, unless the video
   is shorter than that — a clip of half a second would otherwise be asked for
   a frame past its end, which seeks to the end and often yields black. */
function thumbnailSeekTime(duration, target) {
  const length = Number(duration);
  if (!Number.isFinite(length) || length <= 0) return 0;
  const at = Number(target);
  const want = Number.isFinite(at) && at >= 0 ? at : VIDEO_THUMBNAIL_SECONDS;
  // Half way through a short clip, rather than its final frame: the last frame
  // of a video is as likely to be black as its first.
  return length <= want ? length / 2 : want;
}

// The size a frame is drawn at: the source, scaled down to fit the cap, never
// scaled up. Integers, because a canvas sized 160.5 rounds somewhere out of
// sight and the drawn frame ends up a pixel short of its own edge.
function thumbnailCanvasSize(width, height, maxEdge) {
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const capValue = Number(maxEdge);
  const cap = Number.isFinite(capValue) && capValue > 0 ? capValue : VIDEO_THUMBNAIL_MAX_EDGE;
  const scale = Math.min(1, cap / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

// A clipboard type arrives as "image/png" or occasionally with parameters
// attached, and case is not guaranteed. Anything not recognised is not an
// image this plugin will write, which is the caller's cue to let the paste
// through untouched rather than to guess an extension.
function extensionForMime(mime) {
  const value = String(mime == null ? "" : mime)
    .split(";")[0]
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(EXTENSION_BY_MIME, value)
    ? EXTENSION_BY_MIME[value]
    : null;
}

/* Where a pasted image is written: into the folder the pane is showing.
 *
 * Obsidian already pastes images, into the attachment folder — the vault root
 * unless configured otherwise. That is the right default for a note being
 * written, and the wrong one for a pane that is looking at a particular folder
 * of assets. The name carries no source stem because a pasted image has no
 * source; the timestamp is what makes it collision-free and sortable, exactly
 * as it does for a clone or a capture. */
function pastePathFor(folder, extension, taken, date) {
  const normalised = String(extension == null ? "" : extension)
    .toLowerCase()
    .replace(/^\./, "");
  const suffix = normalised || "png";
  return uniquePath(folder, "pasted+" + timestampFor(date), suffix, taken);
}

/* The crash log's text, as pure functions.
 *
 * Reading a log is the one thing you do when everything else has failed, so
 * the format is fixed-width at the front and greppable: time, level, scope,
 * then whatever the failure said. */
function logTimestamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return d.toISOString();
}

// An Error, a string, or whatever a rejected promise happened to carry — all
// three reach this, and none of them may throw on the way through.
function errorText(error) {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  const message = error.message ? String(error.message) : String(error);
  const stack = error.stack ? String(error.stack) : "";
  // A stack normally opens "Error: <message>", so printing the message as well
  // would say it twice. Testing the first line rather than the whole string,
  // because the message also turns up inside frames often enough.
  if (stack && stack.split("\n")[0].indexOf(message) !== -1) return stack;
  return stack ? message + "\n" + stack : message;
}

// One entry, one line at the front. A stack keeps its own newlines, indented
// so that a reader — or a grep for "^2026" — can tell entries apart.
function formatLogEntry(entry) {
  const record = entry || {};
  const head = [
    logTimestamp(record.time),
    (record.level || "ERROR").toUpperCase(),
    record.scope || "plugin",
    record.message || "",
  ].join(" | ");
  const detail = errorText(record.error);
  if (!detail) return head;
  return head + "\n" + detail.split("\n").map((line) => "    " + line).join("\n");
}

// Keep the tail. Cutting at a byte offset would leave a fragment of whatever
// entry straddles it, so the first whole line after the cut is where the kept
// text starts.
function trimLogText(text, maxBytes) {
  const value = String(text == null ? "" : text);
  const cap = Number(maxBytes);
  const limit = Number.isFinite(cap) && cap > 0 ? cap : CRASH_LOG_MAX_BYTES;
  if (value.length <= limit) return value;
  const tail = value.slice(value.length - limit);
  const newline = tail.indexOf("\n");
  const whole = newline === -1 ? tail : tail.slice(newline + 1);
  return "… earlier entries trimmed …\n" + whole;
}

// A/D step through the list without wrapping. Wrapping from the last file back
// to the first reads as a jump to somewhere else rather than as a step, and
// there is no way to tell the two apart from the keyboard.
function siblingPath(paths, current, delta) {
  if (!Array.isArray(paths) || !paths.length) return null;
  const step = Number(delta) || 0;
  const at = paths.indexOf(current);
  // Nothing selected yet: a step in either direction starts at the near end.
  if (at === -1) return step < 0 ? paths[paths.length - 1] : paths[0];
  const next = at + step;
  if (next < 0 || next >= paths.length) return null;
  return paths[next];
}

// yymmddHHMMSS in local time — the convention the desktop app used, and the
// convention the files already in this vault carry.
function timestampFor(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    pad(d.getFullYear() % 100) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Collision suffixes go before the extension — "name.1.png", not "name.png.1" —
// so the file keeps an extension the OS and Obsidian both understand. `taken`
// is any callable answering "does this path already exist?".
function uniquePath(folder, stem, extension, taken) {
  const exists = typeof taken === "function" ? taken : () => false;
  const tail = extension ? "." + extension : "";
  const first = joinPath(folder, stem + tail);
  if (!exists(first)) return first;
  // Bounded, so a `taken` that always answers yes cannot spin forever. A
  // thousand collisions inside one second is not a case worth serving.
  for (let n = 1; n < 1000; n += 1) {
    const candidate = joinPath(folder, stem + "." + n + tail);
    if (!exists(candidate)) return candidate;
  }
  return joinPath(folder, stem + "." + Date.now() + tail);
}

// <stem>+clone+<yymmddHHMMSS>.<ext>, beside the source. The extension follows
// the source through outputExtensionFor, so a JPEG crop stays a JPEG.
function clonePathFor(sourcePath, taken, date) {
  const extension = outputExtensionFor(extensionOf(sourcePath));
  const stem = stemOf(sourcePath) + "+clone+" + timestampFor(date);
  return uniquePath(folderOf(sourcePath), stem, extension, taken);
}

/* <stem>+frame+<yymmddHHMMSS>.png.
 *
 * The name used to carry the capture's position in its source, as
 * +frame+1234ms+ — data encoded into a filename by an app that had nowhere else
 * to put it. The lineage note records that position exactly, and nothing ever
 * read it back out of the name. What the timestamp is for is a name that
 * collides with nothing without a lookup, and that sorts. */
function framePathFor(sourcePath, taken, date) {
  const stem = stemOf(sourcePath) + "+frame+" + timestampFor(date);
  return uniquePath(folderOf(sourcePath), stem, "png", taken);
}

/* Gone from here: sidecarCandidatesFor, sidecarPathFor and mediaStemForSidecar.
 *
 * They built and parsed the name of a note sitting beside its media, so that
 * one could be found from the other — the way a program with no index finds a
 * file, by guessing what it is called. Obsidian has an index: metadataCache
 * reaches every note's frontmatter, so MV-STORE finds a note by the `media:`
 * link it declares, wherever it lives and whatever it is named. A note the user
 * moves or renames by hand keeps working, because nothing depends on where it
 * is.
 */

/* ------------------------------------------------------------------------ *
 * Crop and transform geometry — MV-CROPMATH.
 *
 * The old app's crop bugs all lived here, so this block states the rule rather
 * than discovering it. Two coordinate spaces, and only two:
 *
 *   source    — the decoded file, before anything is done to it.
 *   oriented  — the source after `rotate → flipH → flipV`, which is the space
 *               the user sees, the space the selection is drawn in, and the
 *               space the crop rectangle is stored and recorded in.
 *
 * Everything below either moves a rectangle between those two, or moves one
 * within `oriented` when the transform under it changes. Nothing here knows
 * about the DOM, the canvas or the vault.
 * ------------------------------------------------------------------------ */

// A drag can end above and to the left of where it started, which is a
// perfectly ordinary way to select a region and an entirely negative
// rectangle. Everything downstream assumes non-negative extents, so this is
// where that becomes true.
function normaliseRect(rect) {
  const source = rect || {};
  const finite = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };
  const x = finite(source.x);
  const y = finite(source.y);
  const w = finite(source.w);
  const h = finite(source.h);
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

// Clamped to the box, not refused by it. A selection that overhangs the edge
// is a normal thing to draw — the user is saying "out to the corner" — and
// what they meant is the part that exists.
function clampRect(rect, width, height) {
  const box = normaliseRect(rect);
  const limitX = Math.max(0, Number(width) || 0);
  const limitY = Math.max(0, Number(height) || 0);
  const left = Math.min(Math.max(box.x, 0), limitX);
  const top = Math.min(Math.max(box.y, 0), limitY);
  const right = Math.min(Math.max(box.x + box.w, 0), limitX);
  const bottom = Math.min(Math.max(box.y + box.h, 0), limitY);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

// Only the four quarter turns exist. Anything else is a caller bug rather than
// a value to round toward, so it becomes 0 and the image is left alone.
/* A rectangle in a space that has been scaled by `factor`.
 *
 * Expanded outward on the way, by the same floor/ceil rule the crop mapping
 * uses: a crop drawn at full size and shown on a half-size proxy must not come
 * back a pixel short of what it covers.
 */
function scaleRect(rect, factor) {
  const value = Number(factor);
  const scale = Number.isFinite(value) && value > 0 ? value : 1;
  const box = normaliseRect(rect);
  const left = Math.floor(box.x * scale);
  const top = Math.floor(box.y * scale);
  const right = Math.ceil((box.x + box.w) * scale);
  const bottom = Math.ceil((box.y + box.h) * scale);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

function normaliseRotation(degrees) {
  const value = Number(degrees);
  if (!Number.isFinite(value)) return 0;
  const wrapped = ((Math.trunc(value) % 360) + 360) % 360;
  return wrapped === 90 || wrapped === 180 || wrapped === 270 ? wrapped : 0;
}

function orientedSize(width, height, rotate) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const turn = normaliseRotation(rotate);
  return turn === 90 || turn === 270 ? { width: h, height: w } : { width: w, height: h };
}

/* The rule, in one function.
 *
 * `scale` is how many CSS pixels one oriented-source pixel occupies — the zoom,
 * multiplied by the proxy factor when the image is too large to display at
 * full size. Dividing by it is the whole mapping; the rest is the rounding
 * decision the spec makes and the clamp that follows it.
 *
 * Floor the top-left and ceil the bottom-right, so the crop always contains
 * every pixel the user could see inside their selection. Rounding to nearest
 * would sometimes shave a row or column off an edge the user deliberately put
 * their pointer past, and "sometimes" is the worst possible frequency for that.
 *
 * Returns null rather than a degenerate rectangle when there is nothing to cut:
 * a selection off the image entirely, or one thinner than a source pixel.
 */
function cropFromSelection(selection, scale, orientedWidth, orientedHeight) {
  const factor = Number(scale);
  const z = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const box = normaliseRect(selection);
  const rect = clampRect(
    {
      x: Math.floor(box.x / z),
      y: Math.floor(box.y / z),
      w: Math.ceil((box.x + box.w) / z) - Math.floor(box.x / z),
      h: Math.ceil((box.y + box.h) / z) - Math.floor(box.y / z),
    },
    orientedWidth,
    orientedHeight
  );
  if (rect.w < 1 || rect.h < 1) return null;
  return rect;
}

// The inverse, for drawing a stored crop back onto the display. Not the exact
// inverse of cropFromSelection — that one deliberately loses the sub-pixel
// edges — but the rectangle the overlay should show for a crop that is set.
function selectionFromCrop(rect, scale) {
  const factor = Number(scale);
  const z = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const box = normaliseRect(rect);
  return { x: box.x * z, y: box.y * z, w: box.w * z, h: box.h * z };
}

/* A rectangle in a width x height box, after the box is turned `degrees`
 * clockwise. The box's own dimensions swap on a quarter turn, which is why
 * both are taken: the new x depends on the old height.
 */
function rotateRect(rect, width, height, degrees) {
  const box = normaliseRect(rect);
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  switch (normaliseRotation(degrees)) {
    case 90:
      return { x: h - box.y - box.h, y: box.x, w: box.h, h: box.w };
    case 180:
      return { x: w - box.x - box.w, y: h - box.y - box.h, w: box.w, h: box.h };
    case 270:
      return { x: box.y, y: w - box.x - box.w, w: box.h, h: box.w };
    default:
      return box;
  }
}

function flipRect(rect, width, height, axis) {
  const box = normaliseRect(rect);
  if (axis === "h") return { x: Math.max(0, Number(width) || 0) - box.x - box.w, y: box.y, w: box.w, h: box.h };
  if (axis === "v") return { x: box.x, y: Math.max(0, Number(height) || 0) - box.y - box.h, w: box.w, h: box.h };
  return box;
}

/* Where a stored crop moves to when the rotation changes under it.
 *
 * The crop is stored *after* the flips, so a flip conjugates the rotation: with
 * exactly one axis mirrored, turning the image clockwise turns the stored
 * rectangle anticlockwise. With both axes mirrored — which is a half turn
 * wearing a different name — or neither, the conjugation cancels and the
 * rectangle turns the same way the image does.
 *
 * Getting this wrong is invisible until someone rotates a cropped image and
 * finds a different part of it selected, which is exactly the class of bug the
 * fixed pipeline exists to make impossible.
 */
function cropAfterRotation(rect, width, height, delta, flipH, flipV) {
  const mirrored = Boolean(flipH) !== Boolean(flipV);
  const turn = normaliseRotation(delta);
  return rotateRect(rect, width, height, mirrored ? normaliseRotation(-turn) : turn);
}

// Toggling a flip mirrors the stored rectangle in oriented space, with no
// conjugation to think about: the flips commute with each other, so adding one
// is just that one mirror.
function cropAfterFlip(rect, width, height, axis) {
  return flipRect(rect, width, height, axis);
}

/* An oriented-space rectangle expressed in source pixels.
 *
 * Nothing in the pipeline needs this — the render works forwards, from source
 * to output. It exists so the tests can ask the only question that actually
 * matters about a carried crop: does it still name the same pixels of the file
 * on disk? Undo the flips in oriented space, then undo the turn.
 */
function sourceRectFor(rect, sourceWidth, sourceHeight, rotate, flipH, flipV) {
  const turn = normaliseRotation(rotate);
  const size = orientedSize(sourceWidth, sourceHeight, turn);
  let box = normaliseRect(rect);
  if (flipV) box = flipRect(box, size.width, size.height, "v");
  if (flipH) box = flipRect(box, size.width, size.height, "h");
  return rotateRect(box, size.width, size.height, normaliseRotation(-turn));
}

/* ------------------------------------------------------------------------ *
 * The transform pipeline — MV-SESSION.
 *
 *   decode → rotate → flipH → flipV → crop → resize → encode
 *
 * Fixed order, always. Without one, crop-then-rotate and rotate-then-crop
 * silently disagree, undo stops being definable, and the provenance written
 * into the lineage note stops describing what actually happened.
 *
 * The state below is the whole of an unsaved edit. It is plain data — no
 * canvas, no image, no `this` — so a session can be snapshotted for undo by
 * copying it, and so the maths that turns it into a draw call is testable
 * without a browser.
 * ------------------------------------------------------------------------ */

// How far back undo reaches. Deep enough that nobody arrives at the end of it
// by working, shallow enough that a long session is not also a memory leak:
// each entry is five fields of plain data, so the cost is the cap times almost
// nothing.
const EDIT_HISTORY_LIMIT = 64;

function emptyEditState() {
  return {
    rotate: 0,
    flipH: false,
    flipV: false,
    // null means "the whole oriented image", which is a different thing from a
    // crop that happens to cover it: clearing a crop and drawing one to the
    // edges should not be the same state, because a later rotation moves one
    // and leaves the other alone.
    crop: null,
    // null, { scale }, or { width, height }. The two forms are not
    // interchangeable — see resizedSize.
    resize: null,
  };
}

function normaliseEditState(state) {
  const source = state || {};
  const next = emptyEditState();
  next.rotate = normaliseRotation(source.rotate);
  next.flipH = Boolean(source.flipH);
  next.flipV = Boolean(source.flipV);
  if (source.crop) {
    const rect = normaliseRect(source.crop);
    next.crop = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }
  next.resize = normaliseResize(source.resize);
  return next;
}

/* Two shapes, because they behave differently and pretending otherwise is how
 * a resize survives a crop it no longer describes:
 *
 *   { scale: 0.5 }         — relative, so it still means something after the
 *                            crop changes underneath it.
 *   { width, height }      — absolute, and only meaningful for the crop it was
 *                            typed against.
 */
function normaliseResize(resize) {
  if (!resize) return null;
  const scale = Number(resize.scale);
  if (Number.isFinite(scale) && scale > 0) {
    return scale === 1 ? null : { scale };
  }
  const width = Math.round(Number(resize.width));
  const height = Math.round(Number(resize.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 1 || height < 1) return null;
  return { width, height };
}

// The crop, resolved. A null crop is the whole oriented image; a crop that has
// been clamped out of existence — by a rotation that shrank the axis it sat on
// — falls back to the same thing rather than producing a zero-pixel canvas.
function effectiveCrop(state, sourceWidth, sourceHeight) {
  const size = orientedSize(sourceWidth, sourceHeight, state && state.rotate);
  const full = { x: 0, y: 0, w: size.width, h: size.height };
  if (!state || !state.crop) return full;
  const rect = clampRect(state.crop, size.width, size.height);
  return rect.w >= 1 && rect.h >= 1 ? rect : full;
}

// What the saved file will measure. Rounded, and never below one pixel: a
// scale small enough to round an axis to zero would encode nothing.
function resizedSize(cropWidth, cropHeight, resize) {
  const w = Math.max(1, Math.round(Number(cropWidth) || 0));
  const h = Math.max(1, Math.round(Number(cropHeight) || 0));
  const spec = normaliseResize(resize);
  if (!spec) return { width: w, height: h };
  if (spec.scale !== undefined) {
    return {
      width: Math.max(1, Math.round(w * spec.scale)),
      height: Math.max(1, Math.round(h * spec.scale)),
    };
  }
  return { width: spec.width, height: spec.height };
}

function outputSize(state, sourceWidth, sourceHeight) {
  const crop = effectiveCrop(state, sourceWidth, sourceHeight);
  return resizedSize(crop.w, crop.h, state && state.resize);
}

/* Affine matrices, in the order canvas states them: [a, b, c, d, e, f], where
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * so that a plan can be handed straight to setTransform.
 */
const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

// m after n: the point goes through n first. Written this way round because
// that is how the pipeline reads — source, then orient, then crop and resize.
function multiplyMatrix(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyMatrix(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

// Source space to oriented space: the turn, then the two flips, each of which
// maps the image box onto the image box rather than off the canvas.
function orientMatrix(rotate, flipH, flipV, sourceWidth, sourceHeight) {
  const w = Math.max(0, Number(sourceWidth) || 0);
  const h = Math.max(0, Number(sourceHeight) || 0);
  const turn = normaliseRotation(rotate);
  let m;
  if (turn === 90) m = [0, 1, -1, 0, h, 0];
  else if (turn === 180) m = [-1, 0, 0, -1, w, h];
  else if (turn === 270) m = [0, -1, 1, 0, 0, w];
  else m = IDENTITY_MATRIX.slice();
  const size = orientedSize(w, h, turn);
  if (flipH) m = multiplyMatrix([-1, 0, 0, 1, size.width, 0], m);
  if (flipV) m = multiplyMatrix([1, 0, 0, -1, 0, size.height], m);
  return m;
}

/* Everything the renderer needs, computed without touching a canvas.
 *
 * One matrix rather than an intermediate bitmap: rotating into a full-size
 * canvas and then cropping out of it would cost two allocations of the source,
 * which at the 40-megapixel ceiling is most of a gigabyte for an operation
 * that is a change of coordinates.
 */
function renderPlan(state, sourceWidth, sourceHeight) {
  const shape = normaliseEditState(state);
  const oriented = orientedSize(sourceWidth, sourceHeight, shape.rotate);
  const crop = effectiveCrop(shape, sourceWidth, sourceHeight);
  const size = resizedSize(crop.w, crop.h, shape.resize);
  const scaleX = crop.w > 0 ? size.width / crop.w : 1;
  const scaleY = crop.h > 0 ? size.height / crop.h : 1;
  const place = [scaleX, 0, 0, scaleY, -scaleX * crop.x, -scaleY * crop.y];
  return {
    width: size.width,
    height: size.height,
    oriented,
    crop,
    scale: { x: scaleX, y: scaleY },
    matrix: multiplyMatrix(place, orientMatrix(shape.rotate, shape.flipH, shape.flipV, sourceWidth, sourceHeight)),
  };
}

// Whether a state would change the file at all. A save of an untouched image
// is a copy, which is a thing the user can ask for but not a thing to do by
// accident.
function isIdentityEdit(state, sourceWidth, sourceHeight) {
  const shape = normaliseEditState(state);
  if (shape.rotate !== 0 || shape.flipH || shape.flipV) return false;
  if (shape.resize) return false;
  const size = orientedSize(sourceWidth, sourceHeight, 0);
  const crop = effectiveCrop(shape, sourceWidth, sourceHeight);
  return crop.x === 0 && crop.y === 0 && crop.w === size.width && crop.h === size.height;
}

/* ------------------------------------------------------------------------ *
 * The decode budget — MV-BUDGET.
 *
 * Two limits, doing two different jobs.
 *
 * The ceiling is a refusal. A 12000 x 9000 PNG is 108 megapixels, which is
 * 432 MB of RGBA before anything is done to it and enough to take the pane
 * down with it. The old app carried MAX_IMAGE_DIMENSION and MAX_DECODE_SIZE_MB
 * for the same reason. Refusing is not a failure mode to hide: the message
 * names the dimensions, because "too big" without a number is something the
 * user cannot act on.
 *
 * The proxy is a display decision, and only a display decision. Above the edge
 * limit the pane shows a downscaled copy, while every measurement the edit
 * makes stays in full oriented-source coordinates — so a crop drawn on the
 * proxy is still cut at full resolution. Confusing those two is how an editor
 * quietly starts saving the preview.
 * ------------------------------------------------------------------------ */

const MAX_DECODE_MEGAPIXELS = 40;
const MAX_DISPLAY_EDGE = 4096;

function megapixelsOf(width, height) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  return (w * h) / 1e6;
}

function exceedsDecodeBudget(width, height, limit) {
  const cap = Number(limit);
  const ceiling = Number.isFinite(cap) && cap > 0 ? cap : MAX_DECODE_MEGAPIXELS;
  return megapixelsOf(width, height) > ceiling;
}

// Names the dimensions and the budget, in that order, because the first thing
// the user wants to know is what they just opened.
function decodeBudgetMessage(width, height, limit) {
  const cap = Number(limit);
  const ceiling = Number.isFinite(cap) && cap > 0 ? cap : MAX_DECODE_MEGAPIXELS;
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  const mp = megapixelsOf(w, h);
  return (
    w + " x " + h + " is " + (Math.round(mp * 10) / 10) + " MP, over the " + ceiling + " MP decode budget"
  );
}

// 1 means "show the file itself". Never above 1: a small image is not made
// bigger to fill a limit it was never near.
function proxyScaleFor(width, height, maxEdge) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const cap = Number(maxEdge);
  const edge = Number.isFinite(cap) && cap > 0 ? cap : MAX_DISPLAY_EDGE;
  const longest = Math.max(w, h);
  if (longest <= edge) return 1;
  return edge / longest;
}

function proxySize(width, height, maxEdge) {
  const scale = proxyScaleFor(width, height, maxEdge);
  if (scale === 1) return { width: Math.round(Number(width) || 0), height: Math.round(Number(height) || 0), scale };
  return {
    width: Math.max(1, Math.round((Number(width) || 0) * scale)),
    height: Math.max(1, Math.round((Number(height) || 0) * scale)),
    scale,
  };
}

/* How many CSS pixels one oriented-source pixel occupies on screen.
 *
 * Measured from what is actually laid out rather than accumulated from the
 * zoom and the proxy factor separately, because those two multiply and a
 * missed factor of 0.34 in a crop is not something a user can see until they
 * open the output. The rendered width is a number the browser already knows;
 * asking it is both simpler and harder to get wrong.
 */
function displayScaleFor(renderedWidth, orientedWidth) {
  const rendered = Number(renderedWidth);
  const oriented = Number(orientedWidth);
  if (!Number.isFinite(rendered) || !Number.isFinite(oriented) || oriented <= 0 || rendered <= 0) return 1;
  return rendered / oriented;
}

/* ------------------------------------------------------------------------ *
 * Adjusting a selection — MV-OVERLAY.
 *
 * The old app's crop selection could be drawn and not adjusted: getting it
 * wrong by four pixels meant drawing the whole thing again. Eight handles and
 * a move gesture are the fix, and this is the arithmetic behind them —
 * everything the pointer does to a rectangle, with no DOM in sight.
 *
 * The space is the same one the selection is drawn in: CSS pixels relative to
 * the top-left of what is on screen. `cropFromSelection` turns the result into
 * source pixels, and does it once, at the end.
 * ------------------------------------------------------------------------ */

const CROP_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

// Below this a selection is a mis-click rather than a crop. Applied in display
// pixels, where the user's hand is; the source-pixel floor is a separate rule
// that `cropFromSelection` already enforces.
const CROP_MIN_DISPLAY = 4;

/* The point a drag pivots around: the opposite corner, or the opposite edge,
 * or the centre of the axis the handle does not touch. Nothing else about the
 * rectangle is fixed, which is why every other decision below can be expressed
 * as a size and this point.
 */
function handleAnchor(rect, handle) {
  const box = normaliseRect(rect);
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const name = String(handle || "");
  const west = name.includes("w");
  const east = name.includes("e");
  const north = name.includes("n");
  const south = name.includes("s");
  return {
    x: west ? right : east ? box.x : box.x + box.w / 2,
    y: north ? bottom : south ? box.y : box.y + box.h / 2,
    west,
    east,
    north,
    south,
    // An edge handle leaves its perpendicular axis alone, so under an aspect
    // lock that axis grows from the middle rather than from one side.
    centredX: !west && !east,
    centredY: !north && !south,
  };
}

// Place a size against an anchor, in the direction the handle drags.
function rectFromAnchor(anchor, width, height) {
  const x = anchor.centredX ? anchor.x - width / 2 : anchor.west ? anchor.x - width : anchor.x;
  const y = anchor.centredY ? anchor.y - height / 2 : anchor.north ? anchor.y - height : anchor.y;
  return { x, y, w: width, h: height };
}

// How far the rectangle can grow from the anchor before it leaves the image.
// A centred axis is limited by the nearer side and grows both ways, hence the
// doubling.
function roomFromAnchor(anchor, bounds) {
  const width = Math.max(0, Number(bounds && bounds.width) || 0);
  const height = Math.max(0, Number(bounds && bounds.height) || 0);
  const x = anchor.centredX
    ? 2 * Math.min(anchor.x, width - anchor.x)
    : anchor.west
    ? anchor.x
    : width - anchor.x;
  const y = anchor.centredY
    ? 2 * Math.min(anchor.y, height - anchor.y)
    : anchor.north
    ? anchor.y
    : height - anchor.y;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

/* An aspect-locked rectangle that covers the drag.
 *
 * Growing to cover rather than shrinking to fit, because the pointer is the
 * statement of intent: a diagonal drag that ends past the corner should
 * produce a selection reaching at least that far. For an edge handle only one
 * axis is being dragged, so that axis drives and the other follows.
 */
function aspectSize(width, height, aspect, anchor) {
  const ratio = Number(aspect);
  if (!Number.isFinite(ratio) || ratio <= 0) return { width, height };
  if (anchor.centredX) return { width: height * ratio, height };
  if (anchor.centredY) return { width, height: width / ratio };
  const w = Math.max(width, height * ratio);
  return { width: w, height: w / ratio };
}

/* One pointer move applied to a selection.
 *
 * `handle` is one of the eight compass points, or "move". `dx`/`dy` are the
 * pointer's total offset from where the drag started, applied to the rectangle
 * the drag started from — deltas from the previous frame would accumulate
 * rounding, and would drift whenever a clamp ate part of a move.
 */
function resizeSelection(rect, handle, dx, dy, bounds, aspect) {
  const box = normaliseRect(rect);
  const width = Math.max(0, Number(bounds && bounds.width) || 0);
  const height = Math.max(0, Number(bounds && bounds.height) || 0);
  const moveX = Number(dx) || 0;
  const moveY = Number(dy) || 0;

  /* Moving slides, and is stopped by the edge rather than squashed by it: a
     selection dragged into a corner keeps its size, which is the whole reason
     someone sizes one and then moves it. */
  if (handle === "move") {
    const x = Math.min(Math.max(box.x + moveX, 0), Math.max(0, width - box.w));
    const y = Math.min(Math.max(box.y + moveY, 0), Math.max(0, height - box.h));
    return { x, y, w: box.w, h: box.h };
  }

  if (!CROP_HANDLES.includes(String(handle))) return box;

  const anchor = handleAnchor(box, handle);
  let left = box.x;
  let top = box.y;
  let right = box.x + box.w;
  let bottom = box.y + box.h;
  if (anchor.west) left += moveX;
  if (anchor.east) right += moveX;
  if (anchor.north) top += moveY;
  if (anchor.south) bottom += moveY;

  // Dragging an edge past its opposite flips the rectangle rather than
  // producing a negative one — the gesture every editor allows and the reason
  // normaliseRect exists.
  const dragged = normaliseRect({ x: left, y: top, w: right - left, h: bottom - top });

  const ratio = Number(aspect);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return clampRect(dragged, width, height);
  }

  const wanted = aspectSize(dragged.w, dragged.h, ratio, anchor);
  const room = roomFromAnchor(anchor, { width, height });
  // Shrunk toward the anchor rather than clipped, because clipping an
  // aspect-locked rectangle is how the lock silently stops holding.
  const fit = Math.min(
    1,
    wanted.width > 0 ? room.x / wanted.width : 1,
    wanted.height > 0 ? room.y / wanted.height : 1
  );
  const placed = rectFromAnchor(anchor, wanted.width * fit, wanted.height * fit);
  return clampRect(placed, width, height);
}

// A selection small enough to be a mis-click. Checked in display pixels,
// because that is where the hand is; the source-pixel floor is a separate rule
// and cropFromSelection already holds it.
function isNegligibleSelection(rect, minimum) {
  const box = normaliseRect(rect);
  const floor = Number(minimum);
  const limit = Number.isFinite(floor) && floor > 0 ? floor : CROP_MIN_DISPLAY;
  return box.w < limit || box.h < limit;
}

/* A crop drawn on a view that is itself already cropped.
 *
 * The preview canvas shows the current crop, so a selection on it is relative
 * to that crop, and the state stores an absolute rectangle in oriented space.
 * One addition — but the one nobody remembers, and the reason a second crop of
 * a crop used to land in the wrong place.
 */
function cropWithinCrop(current, rect) {
  const base = normaliseRect(current);
  const inner = normaliseRect(rect);
  return { x: base.x + inner.x, y: base.y + inner.y, w: inner.w, h: inner.h };
}

// The aspect ratios offered, as [label, ratio]. null is free-form. Kept here
// so the list is one thing rather than a dropdown and a parser.
const CROP_ASPECTS = [
  ["Free", null],
  ["1:1", 1],
  ["4:3", 4 / 3],
  ["3:2", 3 / 2],
  ["16:9", 16 / 9],
  ["3:4", 3 / 4],
  ["2:3", 2 / 3],
  ["9:16", 9 / 16],
];

/* The scale factors offered beside the dimension inputs. Both forms exist
   because both are asked for: "1920 wide" is a dimension and "half" is a
   factor, and turning one into the other before storing it loses which was
   meant — a scale still means something after the crop changes, and a typed
   size does not. */
const RESIZE_SCALES = [0.25, 0.5, 0.75, 1, 1.5, 2];

/* Encoding — MV-SAVE.
 *
 * The output format follows the source. The old app encoded everything to PNG,
 * which turns a 2 MB JPEG crop into a 15 MB file: lossless is the right default
 * for a format that was lossless and the wrong one for a format that was not,
 * because re-encoding a photograph as PNG preserves the compression artefacts
 * at eight times the size.
 *
 * Rotation, flipping and cropping never introduce transparency, so a JPEG
 * source stays safely a JPEG — which is the fact that makes following the
 * source safe rather than merely cheaper.
 */

// Undefined for PNG, and deliberately so: canvas.toBlob takes quality as an
// optional argument, and passing one for a lossless format is a value that
// looks meaningful and is not.
function encodeQualityFor(mime, quality) {
  if (mime !== "image/jpeg" && mime !== "image/webp") return undefined;
  const value = Number(quality);
  if (!Number.isFinite(value)) return DEFAULT_ENCODE_QUALITY;
  return Math.min(1, Math.max(0.1, value));
}

function clampQuality(quality) {
  const value = Number(quality);
  if (!Number.isFinite(value)) return DEFAULT_ENCODE_QUALITY;
  return Math.min(1, Math.max(0.1, value));
}

/* ------------------------------------------------------------------------ *
 * MediaInstance records — MV-STORE.
 *
 * A lineage note is a record in this vault's schema system, not a private
 * format beside the image. What is here is the reading and writing of one:
 * frontmatter in, frontmatter out, and the user's prose below the marker
 * carried across untouched.
 *
 * Nothing here builds or parses a note's *name*. That was the first draft's
 * mechanism — find `cover.instance.md` beside `cover.png` by matching stems —
 * and it was a program with no index guessing what a file is called. The
 * pairing is `media:`, and only `media:`.
 * ------------------------------------------------------------------------ */

const INSTANCE_SCHEMA = "MediaInstance";

/* Fields that describe *this file* rather than its subject, and are therefore
 * never inherited. A child's crop is its own; inheriting a parent's would
 * claim the file was cut from a rectangle it was not.
 *
 * Everything else walks the chain, including fields nobody has thought of yet,
 * which is what lets someone add one to the schema and have it inherit without
 * this list changing.
 */
const INTRINSIC_FIELDS = [
  "media",
  "source",
  "op",
  "crop",
  "transform",
  // Seconds into the source video, for a captured frame. Intrinsic for the
  // same reason a crop is: it says where *this* file was taken from, and a
  // child inheriting it would claim a moment it was not cut at.
  "sourceTime",
  "width",
  "height",
  "created",
];

// The order a note is written in. Fixed, so a rewrite of an unchanged record
// produces an unchanged file and a diff shows only what actually moved.
const INSTANCE_FIELD_ORDER = [
  "media",
  "source",
  "op",
  "crop",
  "transform",
  "sourceTime",
  "width",
  "height",
  "created",
  // The evidence fields. Nothing in this plugin reads them; they exist so that
  // Bases, Dataview and anything speaking to the vault from outside can answer
  // "what evidence do I have for this use case, and where did it come from".
  "useCase",
  "shows",
  "status",
  "labels",
];

const STATUS_EDITED = "edited";
const STATUS_REVIEWED = "reviewed";

// What a note says produced the file. A root has none.
const INSTANCE_OPS = ["crop", "transform", "capture", "paste"];

/* "[[folder/cover.png|alias]]" → "folder/cover.png".
 *
 * Aliases and headings are stripped because they are display, not identity.
 * A bare string is returned as itself: a user who typed a path without
 * brackets meant the path, and refusing it would be pedantry.
 */
function linkTargetOf(value) {
  if (value === null || value === undefined) return null;
  // Obsidian hands a frontmatter list back as an array when a field holds one.
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

/* When the record was written, in UTC and to the second.
 *
 * To the second because that is the resolution the question is ever asked at,
 * and UTC because a vault synced between machines in two time zones should not
 * disagree with itself about the order two edits happened in.
 */
function isoTimestamp(date) {
  const at = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Obsidian's YAML parser turns an unquoted timestamp into a Date, so a record
// read back does not hold the string that was written. Both shapes arrive
// here; one leaves.
function asIsoString(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : isoTimestamp(value);
  const text = String(value === null || value === undefined ? "" : value).trim();
  return text || null;
}

/* A YAML scalar, quoted only when it has to be.
 *
 * The "has to be" list is short because the values here are short: wikilinks
 * (which start with a bracket and would otherwise read as a flow sequence),
 * anything with a colon, and anything that would parse as some other type.
 */
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

// A flat mapping on one line. Used for `crop` and `transform`, which are three
// or four numbers each and read better as a rectangle than as a stack.
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
  // A timestamp is written unquoted, matching the schema note's example. It
  // comes back as a Date, which asIsoString puts right on the way in.
  if (key === "created") return String(value);
  return yamlScalar(value);
}

/* Everything below the notes marker, which is the user's and is never
 * rewritten — the convention Schema Sync already established in this vault.
 *
 * Returns "" when there is no marker yet, which is also what a brand new note
 * has, so the caller needs no special case for the first write.
 */
function notesBodyOf(raw) {
  const text = String(raw || "");
  const at = text.indexOf(NOTES_MARKER);
  if (at === -1) return "";
  return text.slice(at + NOTES_MARKER.length).replace(/^\r?\n/, "");
}

/* A MediaInstance note, rendered.
 *
 * `fields` is written in a fixed order and anything absent is omitted rather
 * than written empty — a record says what it declares, and a blank `source:`
 * on a root would be a claim that it has a parent nobody can find.
 *
 * Unknown fields are kept, and kept after the known ones. Someone who adds a
 * field to the schema, or writes one by hand, does not lose it the next time
 * the plugin touches the note.
 */
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

/* A record, read out of a note's frontmatter.
 *
 * `mediaLink` and `sourceLink` are the link text as written; resolving them to
 * paths needs the vault, so LineageStore does it. Keeping the raw text is what
 * lets a dangling `source:` be reported by name rather than as "missing".
 */
function instanceRecordFrom(frontmatter, notePath) {
  const front = frontmatter || {};
  const record = {
    notePath: notePath || null,
    mediaLink: linkTargetOf(front.media),
    sourceLink: linkTargetOf(front.source),
    op: front.op === undefined || front.op === null ? null : String(front.op),
    crop: normaliseCropField(front.crop),
    transform: normaliseTransformField(front.transform),
    width: Number.isFinite(Number(front.width)) ? Number(front.width) : null,
    height: Number.isFinite(Number(front.height)) ? Number(front.height) : null,
    sourceTime: Number.isFinite(Number(front.sourceTime)) && front.sourceTime !== null && front.sourceTime !== ""
      ? Number(front.sourceTime)
      : null,
    useCase: front.useCase === undefined || front.useCase === null ? null : String(front.useCase),
    shows: front.shows === undefined || front.shows === null ? null : String(front.shows),
    created: asIsoString(front.created),
    status: front.status === undefined || front.status === null ? null : String(front.status),
    labels: Array.isArray(front.labels) ? front.labels.slice() : [],
    frontmatter: front,
  };
  return record;
}

function normaliseCropField(value) {
  if (!value || typeof value !== "object") return null;
  const rect = normaliseRect(value);
  return rect.w >= 1 && rect.h >= 1 ? rect : null;
}

function normaliseTransformField(value) {
  if (!value || typeof value !== "object") return null;
  return {
    rotate: normaliseRotation(value.rotate),
    flipH: Boolean(value.flipH),
    flipV: Boolean(value.flipV),
  };
}

// Whether a frontmatter value counts as declared. Present but empty does not:
// Schema Sync fills a record's bound fields out with blanks, and a blank that
// stopped the chain walk would break inheritance for every record it touched.
function isDeclared(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function isIntrinsicField(name) {
  return INTRINSIC_FIELDS.includes(String(name));
}

// Where a new note goes, and what it is called. A convenience only: nothing
// ever reads this back, and a note moved out of the folder or renamed by hand
// keeps working because the pairing is `media:`.
function notePathFor(folder, mediaPath, taken) {
  return uniquePath(folder, stemOf(mediaPath), "md", taken);
}

/* ------------------------------------------------------------------------ *
 * Inheritance — MV-RESOLVE.
 *
 * A child declares only its own fields. Everything else is resolved by walking
 * up the `source:` chain at read time, stopping at the first ancestor that
 * declares it — which is the entire reason for tracking lineage: correcting a
 * value on the parent corrects it for every descendant, without touching one
 * of them.
 *
 * The walk is pure. It takes a `lookup` from media path to record, so the same
 * function serves the pane, the panel and the tests, and none of them needs a
 * vault to run it.
 *
 * Two failure modes, and neither is swallowed. A cycle is broken by a visited
 * set; a chain longer than the cap is abandoned. Both are reported back as the
 * reason the walk stopped, so the pane can say so rather than quietly showing
 * the wrong answer.
 * ------------------------------------------------------------------------ */

const CHAIN_HOP_LIMIT = 32;

// Why a walk ended. "end" is the ordinary one — a root, or a file with no note.
const CHAIN_END = "end";
const CHAIN_CYCLE = "cycle";
const CHAIN_LIMIT = "limit";
const CHAIN_MISSING = "missing";

/* Walk from a file to its furthest ancestor.
 *
 * `lookup(path)` returns a record — anything with `frontmatter`, `sourcePath`
 * and `sourceLink` — or null for a file with no note, which is a perfectly
 * ordinary end to a chain rather than a break.
 *
 * A `sourceLink` that resolved to nothing is a break, and it is where the walk
 * stops. The link text is carried out so the pane can name what is missing;
 * "the chain is broken" without saying which file is not something a user can
 * act on.
 */
function walkChain(startPath, lookup, limit) {
  const cap = Number(limit);
  const hops = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : CHAIN_HOP_LIMIT;
  const chain = [];
  const visited = new Set();
  let path = startPath || null;
  let stopped = CHAIN_END;
  let missing = null;

  while (path) {
    if (visited.has(path)) {
      stopped = CHAIN_CYCLE;
      break;
    }
    if (chain.length >= hops) {
      stopped = CHAIN_LIMIT;
      break;
    }
    visited.add(path);
    const record = lookup(path) || null;
    chain.push({ path, record });
    if (!record) break;
    if (!record.sourcePath) {
      if (record.sourceLink) {
        stopped = CHAIN_MISSING;
        missing = record.sourceLink;
      }
      break;
    }
    path = record.sourcePath;
  }

  return { chain, stopped, missing, ok: stopped === CHAIN_END };
}

/* One field, resolved.
 *
 * `from` is the file that actually declared the value, which is the half of
 * the answer that makes it checkable — a panel showing "16:9, inherited" is
 * useless next to one showing "16:9, from cover.png".
 *
 * Intrinsic fields never walk. A child's crop is its own; inheriting a
 * parent's would claim the file was cut from a rectangle it was not.
 */
function resolveField(field, startPath, lookup, limit) {
  const walk = walkChain(startPath, lookup, limit);
  const name = String(field);
  const intrinsic = isIntrinsicField(name);
  for (const step of walk.chain) {
    if (!step.record || !step.record.frontmatter) {
      if (intrinsic) break;
      continue;
    }
    const value = step.record.frontmatter[name];
    if (isDeclared(value)) {
      return {
        field: name,
        value,
        from: step.path,
        notePath: step.record.notePath || null,
        inherited: step.path !== startPath,
        walk,
      };
    }
    if (intrinsic) break;
  }
  return { field: name, value: undefined, from: null, notePath: null, inherited: false, walk };
}

/* Every field the chain has anything to say about.
 *
 * The set of names is the union of what is declared anywhere along it, so a
 * field someone adds to the schema — or writes into one note by hand —
 * inherits without anything here being taught about it.
 */
function resolveFields(startPath, lookup, limit) {
  const walk = walkChain(startPath, lookup, limit);
  const resolved = {};
  for (const step of walk.chain) {
    const front = step.record && step.record.frontmatter;
    if (!front) continue;
    for (const [name, value] of Object.entries(front)) {
      if (name === "implements") continue;
      if (resolved[name] !== undefined) continue;
      if (!isDeclared(value)) continue;
      // An intrinsic field is only ever the starting file's own, so one seen
      // further up the chain is somebody else's and is skipped.
      if (isIntrinsicField(name) && step.path !== startPath) continue;
      resolved[name] = {
        field: name,
        value,
        from: step.path,
        notePath: step.record.notePath || null,
        inherited: step.path !== startPath,
      };
    }
  }
  return { fields: resolved, walk };
}

// What went wrong with a walk, in a sentence, or null when nothing did.
function chainProblemMessage(walk, startPath) {
  if (!walk || walk.stopped === CHAIN_END) return null;
  const name = baseNameOf(startPath || "");
  if (walk.stopped === CHAIN_CYCLE) {
    return "The lineage of " + name + " loops back on itself; the walk was stopped.";
  }
  if (walk.stopped === CHAIN_LIMIT) {
    return "The lineage of " + name + " is more than " + CHAIN_HOP_LIMIT + " deep; the walk was stopped.";
  }
  if (walk.stopped === CHAIN_MISSING) {
    return "The chain breaks at " + (walk.missing || "a missing file") + ", which is not in the vault.";
  }
  return null;
}

/* A frontmatter value as one line of text, for the lineage panel.
 *
 * Compact rather than faithful: a crop reads as "120,40 800x600" because that
 * is a rectangle someone can check against what they see, where
 * {"x":120,...} is JSON someone has to parse in their head.
 */
function formatFieldValue(name, value) {
  if (value === null || value === undefined) return "";
  if (name === "crop" && value && typeof value === "object") {
    return value.x + "," + value.y + " " + value.w + "x" + value.h;
  }
  if (name === "transform" && value && typeof value === "object") {
    const parts = [];
    if (value.rotate) parts.push(value.rotate + "°");
    if (value.flipH) parts.push("flip H");
    if (value.flipV) parts.push("flip V");
    return parts.length ? parts.join(" · ") : "none";
  }
  if (name === "sourceTime") {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? formatTimecode(seconds) + " (" + seconds + "s)" : String(value);
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (value instanceof Date) return asIsoString(value) || "";
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => key + ": " + item)
      .join(", ");
  }
  return String(value);
}

// Numeric-aware and case-insensitive, so "shot2" sorts before "shot10" and the
// grid reads in the order the file explorer shows. Ties break on the full path,
// which is only reachable under a recursive scan and keeps the order total —
// a comparator that ever returns 0 for two distinct entries makes the binary
// search below ambiguous.
const PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareMediaPaths(a, b) {
  const byName = PATH_COLLATOR.compare(baseNameOf(a), baseNameOf(b));
  if (byName !== 0) return byName;
  const byPath = PATH_COLLATOR.compare(a, b);
  if (byPath !== 0) return byPath;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Non-recursive by default: the folder itself, not its descendants. The root
// folder is "", which every path is inside.
function isInFolder(path, folder, recursive) {
  const parent = folderOf(path);
  const target = normaliseSeparators(folder).replace(/\/+$/, "");
  if (parent === target) return true;
  if (!recursive) return false;
  if (target === "") return true;
  return parent.startsWith(target + "/");
}

// Where `path` belongs in an already-sorted list. Binary search, because
// insertion happens on every vault `create` event and rebuilding the folder to
// add one file is what a save should never cost.
function sortedInsertIndex(paths, path) {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareMediaPaths(paths[mid], path) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Which folder the pane should follow to, given the file the workspace just
// made active. Only media files move the pane: opening a markdown note should
// not swap a folder of images for an empty list.
function folderForActiveFile(path) {
  if (!path) return null;
  // A lineage note is markdown, so it is not media, so it does not move the
  // pane — the same rule that covers every other note, with no special case.
  if (!isMediaPath(path)) return null;
  return folderOf(path);
}

/* An LRU keyed by path, holding whatever a thumbnail costs to produce.
 *
 * The cap is on entries rather than bytes because the expensive part is not the
 * decoded pixels — the browser owns those — but the number of live <img>
 * elements and, once MV-VTHUMB lands, the number of blob URLs that have to be
 * revoked. Counting entries is a number the eviction path can act on;
 * estimating bytes is a number it can only guess at.
 *
 * `onEvict` is called for every entry that leaves, including on clear(), so a
 * blob URL always gets revoked exactly once.
 */
class LruCache {
  constructor(capacity, onEvict) {
    this.capacity = Math.max(1, Math.floor(Number(capacity) || 1));
    this.onEvict = typeof onEvict === "function" ? onEvict : null;
    // A Map iterates in insertion order, so the oldest key is the first one —
    // which is the whole trick, and the reason there is no linked list here.
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  has(key) {
    return this.entries.has(key);
  }

  // A hit is a use, so the entry moves to the young end. A get that did not
  // refresh recency would make this a FIFO queue wearing an LRU's name.
  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.entries.has(key)) {
      const previous = this.entries.get(key);
      this.entries.delete(key);
      // Replacing a key still retires whatever it held; the old value is as
      // dead as an evicted one.
      if (previous !== value) this.evicted(key, previous);
    }
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      const stale = this.entries.get(oldest);
      this.entries.delete(oldest);
      this.evicted(oldest, stale);
    }
    return value;
  }

  delete(key) {
    if (!this.entries.has(key)) return false;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.evicted(key, value);
    return true;
  }

  clear() {
    const entries = Array.from(this.entries.entries());
    this.entries.clear();
    for (const [key, value] of entries) this.evicted(key, value);
  }

  // Eviction runs during scrolling and during folder switches. One thumbnail
  // that fails to retire must not stop the rest from retiring.
  evicted(key, value) {
    if (!this.onEvict) return;
    try {
      this.onEvict(key, value);
    } catch (error) {
      reportFailure("plugin", "thumbnail eviction failed for " + key, error);
    }
  }

  // Oldest first. Testing an LRU without being able to see its order means
  // testing that it holds things, which is not the interesting half.
  keysOldestFirst() {
    return Array.from(this.entries.keys());
  }
}

// The pane header shows a folder's name, not its full path — but the vault root
// has neither, so it gets a word.
function folderLabelFor(folder) {
  if (folder === null || folder === undefined) return "";
  const clean = normaliseSeparators(folder).replace(/\/+$/, "");
  if (clean === "") return "Vault root";
  return baseNameOf(clean);
}

// When the displayed file disappears, selection moves to the entry that took
// its place — which at the end of the list is the one before it. Returns null
// only when nothing is left to select.
function selectionAfterRemoval(paths, removedIndex) {
  if (!paths.length) return null;
  const index = removedIndex >= paths.length ? paths.length - 1 : Math.max(0, removedIndex);
  return paths[index];
}

const core = {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  NOTES_MARKER,
  ZOOM_MIN,
  ZOOM_MAX,
  normaliseSeparators,
  baseNameOf,
  folderOf,
  extensionOf,
  stemOf,
  joinPath,
  classifyExtension,
  classifyPath,
  isMediaPath,
  matchesFilter,
  mimeForExtension,
  outputExtensionFor,
  EXTENSION_BY_MIME,
  clampZoom,
  stepZoom,
  fitZoom,
  panLimit,
  clampPan,
  panAfterZoom,
  siblingPath,
  normaliseRect,
  clampRect,
  normaliseRotation,
  orientedSize,
  cropFromSelection,
  selectionFromCrop,
  rotateRect,
  flipRect,
  cropAfterRotation,
  cropAfterFlip,
  sourceRectFor,
  CROP_HANDLES,
  CROP_MIN_DISPLAY,
  CROP_ASPECTS,
  handleAnchor,
  rectFromAnchor,
  roomFromAnchor,
  aspectSize,
  resizeSelection,
  isNegligibleSelection,
  cropWithinCrop,
  RESIZE_SCALES,
  DEFAULT_ENCODE_QUALITY,
  encodeQualityFor,
  clampQuality,
  INSTANCE_SCHEMA,
  DEFAULT_NOTE_FOLDER,
  INTRINSIC_FIELDS,
  INSTANCE_FIELD_ORDER,
  INSTANCE_OPS,
  STATUS_EDITED,
  STATUS_REVIEWED,
  linkTargetOf,
  wikilinkFor,
  isoTimestamp,
  asIsoString,
  yamlScalar,
  yamlValueFor,
  notesBodyOf,
  renderInstanceNote,
  instanceRecordFrom,
  isDeclared,
  isIntrinsicField,
  notePathFor,
  CHAIN_HOP_LIMIT,
  CHAIN_END,
  CHAIN_CYCLE,
  CHAIN_LIMIT,
  CHAIN_MISSING,
  walkChain,
  resolveField,
  resolveFields,
  chainProblemMessage,
  formatFieldValue,
  scaleRect,
  MAX_DECODE_MEGAPIXELS,
  MAX_DISPLAY_EDGE,
  megapixelsOf,
  exceedsDecodeBudget,
  decodeBudgetMessage,
  proxyScaleFor,
  proxySize,
  displayScaleFor,
  emptyEditState,
  normaliseEditState,
  normaliseResize,
  effectiveCrop,
  resizedSize,
  outputSize,
  IDENTITY_MATRIX,
  multiplyMatrix,
  applyMatrix,
  orientMatrix,
  renderPlan,
  isIdentityEdit,
  EDIT_HISTORY_LIMIT,
  ZOOM_WHEEL_RATIO,
  ZOOM_KEY_RATIO,
  VIDEO_SEEK_SECONDS,
  VIDEO_FRAME_SECONDS,
  SCRUB_RESOLUTION,
  SPEED_STEPS,
  SPEED_MIN,
  SPEED_MAX,
  VIDEO_THUMBNAIL_SECONDS,
  VIDEO_THUMBNAIL_MAX_EDGE,
  VIDEO_THUMBNAIL_CONCURRENCY,
  VIDEO_THUMBNAIL_TIMEOUT_MS,
  VIDEO_FRAME_CACHE_SIZE,
  thumbnailSeekTime,
  thumbnailCanvasSize,
  clampSpeed,
  nearestSpeed,
  stepSpeed,
  formatSpeed,
  clampTime,
  seekTime,
  frameStepTime,
  scrubPositionFor,
  timeFromScrub,
  formatTimecode,
  timestampFor,
  uniquePath,
  clonePathFor,
  framePathFor,
  logTimestamp,
  errorText,
  formatLogEntry,
  trimLogText,
  CRASH_LOG_PATH,
  CRASH_LOG_MAX_BYTES,
  CRASH_LOG_BUFFER,
  pastePathFor,
  extensionForMime,
  compareMediaPaths,
  isInFolder,
  sortedInsertIndex,
  selectionAfterRemoval,
  folderForActiveFile,
  folderLabelFor,
  LruCache,
  THUMBNAIL_CACHE_SIZE,
};

/* ------------------------------------------------------------------------ *
 * End of core. Everything below touches Obsidian.
 * ------------------------------------------------------------------------ */

/* The ordered media list for one vault folder.
 *
 * Held as a Map keyed by path plus a sorted array of those paths, because both
 * questions get asked constantly: "do I already have this file?" on every vault
 * event, and "what is at position n?" on every keyboard step.
 *
 * Insertion is idempotent by path. `vault.createBinary` fires a `create` event
 * that this index also listens for, so a save that inserts its own new file
 * would otherwise add it twice.
 *
 * The scan asks the vault for the folder and walks its own children — no disk
 * reads and no worker queue. Everything that is not image or video is excluded,
 * which is what keeps markdown out of the grid.
 *
 * It used to filter `vault.getFiles()`, reading every file in the vault to
 * answer a question about one folder: the habit of a program with no tree to
 * ask. Obsidian holds the tree, so a folder of 20 costs 20 rather than the size
 * of the vault, and a folder that does not exist costs nothing at all.
 */
class MediaIndex {
  constructor(vault) {
    this.vault = vault;
    this.folder = null;
    this.recursive = false;
    this.byPath = new Map();
    this.order = [];
    // Fired after any change, with a short reason so the view can decide
    // whether a full re-render is warranted or one tile will do.
    this.onChange = null;
  }

  get paths() {
    return this.order;
  }

  get size() {
    return this.order.length;
  }

  has(path) {
    return this.byPath.has(path);
  }

  fileFor(path) {
    return this.byPath.get(path) || null;
  }

  indexOf(path) {
    // Linear rather than a second map: the array is one folder's media, and
    // keeping a path->index map correct through every splice costs more than
    // the scan it saves.
    return this.order.indexOf(path);
  }

  at(index) {
    if (index < 0 || index >= this.order.length) return null;
    return this.order[index];
  }

  // Whether a vault file belongs in this index at all. Only image and video,
  // which is what keeps lineage notes out of the grid now that they are
  // ordinary markdown living elsewhere.
  accepts(file) {
    if (!file || typeof file.path !== "string") return false;
    if (this.folder === null) return false;
    if (!isMediaPath(file.path)) return false;
    return isInFolder(file.path, this.folder, this.recursive);
  }

  setFolder(folder, recursive) {
    this.folder = folder === null || folder === undefined ? null : normaliseSeparators(folder).replace(/\/+$/, "");
    if (recursive !== undefined) this.recursive = Boolean(recursive);
    this.scan();
  }

  setRecursive(recursive) {
    const next = Boolean(recursive);
    if (next === this.recursive) return;
    this.recursive = next;
    this.scan();
  }

  scan() {
    this.byPath.clear();
    this.order = [];
    if (this.folder === null) {
      this.emit("scan");
      return this.order;
    }
    for (const file of this.filesInFolder()) {
      if (!this.accepts(file)) continue;
      this.byPath.set(file.path, file);
      this.order.push(file.path);
    }
    this.order.sort(compareMediaPaths);
    this.emit("scan");
    return this.order;
  }

  /* The candidate files for the current folder.
   *
   * A folder's `children` holds files and folders together; a child with its
   * own `children` is a folder, which is all the discrimination needed here and
   * avoids importing TFolder into a class that otherwise touches one vault
   * method. Recursion is depth-first and iterative, since a vault can nest
   * further than a comfortable stack.
   *
   * Falls back to `getFiles()` when the vault cannot resolve the folder — an
   * older API, or a path that has just been deleted underneath the pane. The
   * fallback filters by folder exactly as the caller's `accepts` does, so the
   * result is the same list by a slower road. */
  filesInFolder() {
    return guarded("listing", this.folder, () => this.filesInFolderUnguarded(), []);
  }

  filesInFolderUnguarded() {
    const root = this.folderObject();
    if (!root) {
      if (!this.vault || typeof this.vault.getFiles !== "function") return [];
      return this.vault.getFiles();
    }
    const files = [];
    const pending = [root];
    while (pending.length) {
      const folder = pending.pop();
      const children = folder && Array.isArray(folder.children) ? folder.children : [];
      for (const child of children) {
        if (Array.isArray(child.children)) {
          if (this.recursive) pending.push(child);
          continue;
        }
        files.push(child);
      }
    }
    return files;
  }

  // The vault root is "", which getFolderByPath does not answer to on every
  // version — getRoot() is the one that does.
  folderObject() {
    const vault = this.vault;
    if (!vault) return null;
    if (this.folder === "") {
      return typeof vault.getRoot === "function" ? vault.getRoot() : null;
    }
    if (typeof vault.getFolderByPath === "function") {
      const folder = vault.getFolderByPath(this.folder);
      if (folder) return folder;
    }
    if (typeof vault.getAbstractFileByPath === "function") {
      const entry = vault.getAbstractFileByPath(this.folder);
      if (entry && Array.isArray(entry.children)) return entry;
    }
    return null;
  }

  // Idempotent by path: a file already present updates its handle — the vault
  // hands out a fresh TFile after a rename — and does not enter the order a
  // second time. Returns true only when the list actually grew.
  insert(file) {
    if (!this.accepts(file)) return false;
    if (this.byPath.has(file.path)) {
      this.byPath.set(file.path, file);
      return false;
    }
    this.byPath.set(file.path, file);
    this.order.splice(sortedInsertIndex(this.order, file.path), 0, file.path);
    return true;
  }

  remove(path) {
    if (!this.byPath.has(path)) return -1;
    this.byPath.delete(path);
    const index = this.order.indexOf(path);
    if (index !== -1) this.order.splice(index, 1);
    return index;
  }

  // What selection should move to once `path` is gone: the entry that took its
  // place, or the previous one at the end of the list. Ask before removing.
  successorFor(path) {
    const index = this.order.indexOf(path);
    if (index === -1) return null;
    const remaining = this.order.slice(0, index).concat(this.order.slice(index + 1));
    return selectionAfterRemoval(remaining, index);
  }

  /* Vault events. Each returns whether the index changed, so a caller can skip
   * a re-render for the overwhelmingly common case of an event about a file in
   * some other folder. */

  handleCreate(file) {
    if (!this.insert(file)) return false;
    this.emit("create", file.path);
    return true;
  }

  // `modify` never changes membership — it changes what the file looks like.
  // The view re-reads its resource path, which carries the mtime, so the URL
  // changes and the browser cache is bypassed.
  handleModify(file) {
    if (!file || !this.byPath.has(file.path)) return false;
    this.byPath.set(file.path, file);
    this.emit("modify", file.path);
    return true;
  }

  handleDelete(file) {
    if (!file || !this.byPath.has(file.path)) return false;
    // Asked before the removal, because afterwards the index no longer knows
    // where the file was. This is the only moment the answer exists.
    const successor = this.successorFor(file.path);
    this.remove(file.path);
    this.emit("delete", file.path, successor);
    return true;
  }

  // A rename can move a file in, out, or within the folder, and Obsidian
  // reports it as one event carrying the new file and the old path. Treating it
  // as a remove followed by an insert covers all three without special cases.
  handleRename(file, oldPath) {
    const had = this.byPath.has(oldPath);
    if (had) this.remove(oldPath);
    const added = this.insert(file);
    if (!had && !added) return false;
    this.emit("rename", file && file.path, oldPath);
    return true;
  }

  // The third argument depends on the reason: the previous path for a rename,
  // the path selection should fall back to for a delete, absent otherwise.
  emit(reason, path, detail) {
    if (typeof this.onChange === "function") this.onChange(reason, path, detail);
  }
}

/* ------------------------------------------------------------------------ *
 * EditSession — the unsaved state of one edit.
 *
 * Non-destructive: the source file is never written to, and every operation
 * amounts to editing the plain-data state that `renderPlan` turns into a draw
 * call. That is what makes undo a stack of snapshots rather than a stack of
 * inverse operations — the second of which is where an editor accumulates the
 * bugs that only appear four steps back.
 *
 * The session holds the decoded source at full resolution. A display proxy, if
 * the viewer is using one, belongs to the viewer: the maths here runs in full
 * oriented-source coordinates so that a crop of a large image is still cut at
 * full resolution.
 * ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ *
 * Getting a source into an edit session — MV-BUDGET.
 *
 * The <img> the viewer shows is the browser's business: it decodes lazily,
 * drops what it likes and never hands the pixels over. An edit needs the
 * pixels, which means a decode this plugin owns and therefore a size this
 * plugin has to have an opinion about.
 * ------------------------------------------------------------------------ */

/* A refusal, not a failure. Given a name so the caller can tell "this file is
   too large" from "this file is broken" without matching on a message. */
class DecodeBudgetError extends Error {
  constructor(width, height, limit) {
    super(decodeBudgetMessage(width, height, limit));
    this.name = "DecodeBudgetError";
    this.width = width;
    this.height = height;
  }
}

function decodeImageElement(url) {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined" || !document.createElement) {
      reject(new Error("no document to decode into"));
      return;
    }
    const image = document.createElement("img");
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("the image could not be decoded")));
    image.src = url;
  });
}

/* The downscaled display copy, or the image itself when it is small enough.
 *
 * Returned in the same shape either way — { image, width, height, scale } —
 * so that nothing downstream has to ask whether a proxy happened. `scale` is
 * how the preview relates to the source, and it is the only number that ever
 * needs to know.
 *
 * A canvas that will not give up a context is not worth failing over: the
 * fallback is the full-size image, which is slower to display and correct.
 */
function buildDisplayProxy(image, width, height, maxEdge) {
  const size = proxySize(width, height, maxEdge);
  if (size.scale === 1 || typeof document === "undefined") {
    return { image, width, height, scale: 1 };
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return { image, width, height, scale: 1 };
    if ("imageSmoothingEnabled" in context) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
    }
    context.drawImage(image, 0, 0, size.width, size.height);
    return { image: canvas, width: size.width, height: size.height, scale: size.scale };
  } catch (error) {
    reportFailure("plugin", "building a display proxy failed", error);
    return { image, width, height, scale: 1 };
  }
}

async function loadEditSource(url, options) {
  const settings = options || {};
  const image = await decodeImageElement(url);
  const width = Math.floor(Number(image.naturalWidth) || 0);
  const height = Math.floor(Number(image.naturalHeight) || 0);
  // A decode that "succeeded" with no dimensions is an SVG with no intrinsic
  // size, or a file the browser gave up on quietly. Either way there is
  // nothing to measure a crop against.
  if (width < 1 || height < 1) throw new Error("the image reported no dimensions");
  if (exceedsDecodeBudget(width, height, settings.maxMegapixels)) {
    throw new DecodeBudgetError(width, height, settings.maxMegapixels);
  }
  return {
    image,
    width,
    height,
    preview: buildDisplayProxy(image, width, height, settings.maxEdge),
  };
}

/* A canvas as bytes.
 *
 * toBlob is callback-shaped and hands back null rather than throwing when the
 * browser cannot encode — a WebP request on a build without the encoder, say —
 * so both of those become a rejected promise here, and every caller gets one
 * failure shape to handle.
 *
 * The toDataURL fallback exists for builds without toBlob. It is a base64
 * string, so it costs a third more memory and a parse; that is a fine price
 * for a fallback and a bad one for the normal path.
 */
function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === "function") {
      try {
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new Error("the browser could not encode " + mime));
          },
          mime,
          quality
        );
        return;
      } catch (error) {
        reject(error);
        return;
      }
    }
    if (typeof canvas.toDataURL !== "function") {
      reject(new Error("this canvas cannot be encoded"));
      return;
    }
    try {
      resolve(dataUrlToBlob(canvas.toDataURL(mime, quality)));
    } catch (error) {
      reject(error);
    }
  });
}

function dataUrlToBlob(url) {
  const comma = String(url).indexOf(",");
  if (comma === -1) throw new Error("not a data URL");
  const head = String(url).slice(0, comma);
  const body = String(url).slice(comma + 1);
  const mime = (head.match(/^data:([^;,]+)/) || [])[1] || "application/octet-stream";
  const binary = head.includes(";base64") ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

class EditSession {
  /* `source` is { path, image, width, height }: the decoded bitmap and the
     dimensions to trust. The dimensions are taken rather than read off the
     element because an <img> that failed to decode still reports zeroes, and a
     session built on zeroes fails later and further away. */
  constructor(source) {
    const shape = source || {};
    this.path = shape.path || null;
    this.image = shape.image || null;
    this.sourceWidth = Math.max(0, Math.floor(Number(shape.width) || 0));
    this.sourceHeight = Math.max(0, Math.floor(Number(shape.height) || 0));
    /* The display copy, when the source is too large to put on screen whole.
       Same shape whether or not a downscale happened, so nothing downstream
       has to ask — and never used for anything but the preview, which is the
       distinction MV-BUDGET exists to keep. */
    this.preview = shape.preview || { image: this.image, width: this.sourceWidth, height: this.sourceHeight, scale: 1 };
    this.state = emptyEditState();
    this.past = [];
    this.future = [];
    // Set by the pane. Called after every accepted change, including undo and
    // redo, so there is one place the UI has to re-read from.
    this.onChange = null;
  }

  get orientedSize() {
    return orientedSize(this.sourceWidth, this.sourceHeight, this.state.rotate);
  }

  get crop() {
    return effectiveCrop(this.state, this.sourceWidth, this.sourceHeight);
  }

  get outputSize() {
    return outputSize(this.state, this.sourceWidth, this.sourceHeight);
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  // Whether saving would produce anything but a copy. A session the user has
  // opened and not touched is not an edit, and the save button says so.
  get dirty() {
    return !isIdentityEdit(this.state, this.sourceWidth, this.sourceHeight);
  }

  plan() {
    return renderPlan(this.state, this.sourceWidth, this.sourceHeight);
  }

  /* Every state change funnels through here, so undo has exactly one thing to
     record and the no-op case is rejected in one place. A redo future is
     dropped on any new edit, which is the behaviour every editor has: the
     branch you did not take stops existing the moment you take another. */
  commit(next) {
    const shape = normaliseEditState(next);
    if (JSON.stringify(shape) === JSON.stringify(this.state)) return false;
    this.past.push(this.state);
    if (this.past.length > EDIT_HISTORY_LIMIT) this.past.shift();
    this.future.length = 0;
    this.state = shape;
    this.notify();
    return true;
  }

  notify() {
    if (typeof this.onChange === "function") this.onChange(this);
  }

  /* Rotation, with the crop carried.
   *
   * `cropAfterRotation` is the part that keeps the same region selected. An
   * absolute resize has its axes swapped on a quarter turn for the same
   * reason: 800x600 typed against a landscape crop means 600x800 once that
   * crop stands on its end. */
  rotateBy(delta) {
    const turn = normaliseRotation(delta);
    if (turn === 0) return false;
    const state = this.state;
    const size = this.orientedSize;
    const next = Object.assign({}, state, { rotate: normaliseRotation(state.rotate + turn) });
    if (state.crop) {
      next.crop = cropAfterRotation(state.crop, size.width, size.height, turn, state.flipH, state.flipV);
    }
    if (state.resize && state.resize.width !== undefined && (turn === 90 || turn === 270)) {
      next.resize = { width: state.resize.height, height: state.resize.width };
    }
    return this.commit(next);
  }

  setRotation(degrees) {
    return this.rotateBy(normaliseRotation(degrees) - this.state.rotate);
  }

  // The flips commute with each other, so toggling one is a plain mirror of
  // the stored rectangle in oriented space — no conjugation to think about.
  toggleFlip(axis) {
    if (axis !== "h" && axis !== "v") return false;
    const state = this.state;
    const size = this.orientedSize;
    const next = Object.assign({}, state);
    if (axis === "h") next.flipH = !state.flipH;
    else next.flipV = !state.flipV;
    if (state.crop) next.crop = cropAfterFlip(state.crop, size.width, size.height, axis);
    return this.commit(next);
  }

  /* A crop in oriented-source pixels — what `cropFromSelection` returns.
   *
   * Setting one drops an absolute resize, because "800 x 600" was typed
   * against the crop it replaced and means nothing against this one. A scale
   * factor survives, because it means the same thing whatever it is applied
   * to. */
  setCrop(rect) {
    const size = this.orientedSize;
    const crop = rect ? clampRect(rect, size.width, size.height) : null;
    if (crop && (crop.w < 1 || crop.h < 1)) return false;
    const next = Object.assign({}, this.state, {
      crop: crop ? { x: crop.x, y: crop.y, w: crop.w, h: crop.h } : null,
    });
    if (next.resize && next.resize.width !== undefined) next.resize = null;
    return this.commit(next);
  }

  clearCrop() {
    return this.setCrop(null);
  }

  setResize(width, height) {
    return this.commit(Object.assign({}, this.state, { resize: { width, height } }));
  }

  setScale(scale) {
    return this.commit(Object.assign({}, this.state, { resize: { scale } }));
  }

  clearResize() {
    return this.commit(Object.assign({}, this.state, { resize: null }));
  }

  undo() {
    if (!this.past.length) return false;
    this.future.push(this.state);
    this.state = this.past.pop();
    this.notify();
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push(this.state);
    this.state = this.future.pop();
    this.notify();
    return true;
  }

  // One undoable step back to nothing, rather than a wipe: someone who resets
  // by accident has lost their work otherwise.
  reset() {
    return this.commit(emptyEditState());
  }

  /* Render into a canvas.
   *
   * One drawImage under one matrix. The alternative — draw the rotation into a
   * full-size intermediate, then crop out of it — allocates the source twice,
   * which at the decode ceiling is most of a gigabyte to express a change of
   * coordinates.
   *
   * The transform is reset afterwards so the caller gets a canvas in a known
   * state, which matters because MV-SAVE draws nothing else onto it but a
   * later task might. */
  renderTo(canvas) {
    if (!canvas) throw new Error("EditSession.renderTo needs a canvas");
    if (!this.image) throw new Error("EditSession has no decoded source to draw");
    const plan = this.plan();
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("EditSession could not get a 2D context");
    if ("imageSmoothingEnabled" in context) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
    }
    context.setTransform(plan.matrix[0], plan.matrix[1], plan.matrix[2], plan.matrix[3], plan.matrix[4], plan.matrix[5]);
    // The explicit destination size rather than the three-argument form: a
    // proxy handed here by mistake would silently render at the wrong scale
    // otherwise, and this is the one place that would not be visible.
    context.drawImage(this.image, 0, 0, this.sourceWidth, this.sourceHeight);
    context.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  render() {
    if (typeof document === "undefined" || !document.createElement) {
      throw new Error("EditSession.render needs a document");
    }
    return this.renderTo(document.createElement("canvas"));
  }

  /* What the pane shows while the edit is being made.
   *
   * Drawn from the proxy when there is one, and capped again on the way out,
   * because a 3:1 crop of a 4096px proxy is still wider than any pane. The
   * resize is deliberately dropped: it changes the output's pixel count and
   * nothing the eye can check on screen, so it belongs in the readout rather
   * than in the preview, where honouring it would only cost a resample.
   *
   * The crop is scaled outward — floor the top-left, ceil the bottom-right,
   * the same rule as everywhere else — so the preview never shows less than
   * the crop will cut.
   */
  previewPlan(maxEdge) {
    const source = this.preview;
    const factor = this.sourceWidth > 0 ? source.width / this.sourceWidth : 1;
    const state = {
      rotate: this.state.rotate,
      flipH: this.state.flipH,
      flipV: this.state.flipV,
      crop: this.state.crop ? scaleRect(this.state.crop, factor) : null,
      resize: null,
    };
    const plan = renderPlan(state, source.width, source.height);
    const cap = Number(maxEdge);
    const limit = Number.isFinite(cap) && cap > 0 ? cap : MAX_DISPLAY_EDGE;
    const longest = Math.max(plan.width, plan.height);
    if (longest <= limit) return plan;
    state.resize = { scale: limit / longest };
    return renderPlan(state, source.width, source.height);
  }

  renderPreviewTo(canvas, maxEdge) {
    if (!canvas) throw new Error("EditSession.renderPreviewTo needs a canvas");
    const source = this.preview;
    if (!source.image) throw new Error("EditSession has no decoded source to draw");
    const plan = this.previewPlan(maxEdge);
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("EditSession could not get a 2D context");
    if ("imageSmoothingEnabled" in context) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
    }
    context.setTransform(plan.matrix[0], plan.matrix[1], plan.matrix[2], plan.matrix[3], plan.matrix[4], plan.matrix[5]);
    context.drawImage(source.image, 0, 0, source.width, source.height);
    context.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }


  /* Encode the edit to bytes, in the source's own format.
   *
   * toBlob rather than toDataURL: a data URL is base64, so it is a third
   * larger and has to be parsed back out of a string, and for a large image
   * that string is the largest single allocation in the operation. The
   * toDataURL path is kept only for the case where toBlob is missing.
   */
  async encode(options) {
    const settings = options || {};
    const mime = settings.mime || mimeForExtension(extensionOf(this.path || ""));
    const quality = encodeQualityFor(mime, settings.quality);
    const canvas = this.render();
    const blob = await canvasToBlob(canvas, mime, quality);
    if (!blob) throw new Error("the canvas produced no image data");
    return { bytes: await blob.arrayBuffer(), mime, quality, blob };
  }
  /* What the lineage note records. Oriented-source pixels for the crop, the
     three transform flags, and the output dimensions — enough to reproduce the
     derivation rather than merely describe it. */
  describe() {
    const size = this.outputSize;
    const crop = this.crop;
    const oriented = this.orientedSize;
    const whole =
      crop.x === 0 && crop.y === 0 && crop.w === oriented.width && crop.h === oriented.height;
    return {
      crop: whole ? null : { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
      transform: { rotate: this.state.rotate, flipH: this.state.flipH, flipV: this.state.flipV },
      width: size.width,
      height: size.height,
    };
  }
}

/* ------------------------------------------------------------------------ *
 * CropOverlay — the selection, on the viewer, in place.
 *
 * The old app's CropImageDialog drew a rectangle you could not touch again:
 * four pixels out meant starting over. This one is eight handles, a move
 * gesture and an aspect lock, sitting directly on the edit canvas rather than
 * in a second window with its own zoom.
 *
 * Everything it decides is `resizeSelection`. What it owns is the elements,
 * the pointer capture and the one rule the arithmetic cannot state: a drag
 * that ends where it started is a click, and clears the selection rather than
 * leaving a one-pixel crop behind.
 * ------------------------------------------------------------------------ */

class CropOverlay {
  /* `host` is the element the overlay fills — the frame wrapped tightly around
     the canvas, so that "inset: 0" and "the picture" are the same box and no
     offset arithmetic is needed anywhere.

     `options.bounds()` reports that box's CSS size, `options.label()` turns a
     selection into the source-pixel readout, and `options.onChange()` fires
     whenever the selection changes — including when it is cleared. */
  constructor(host, options) {
    const settings = options || {};
    this.options = settings;
    this.selection = null;
    this.aspect = null;
    this.drag = null;

    this.el = host.createDiv({ cls: "mv-crop-overlay" });
    this.rectEl = this.el.createDiv({ cls: "mv-crop-rect" });
    this.handleEls = new Map();
    for (const name of CROP_HANDLES) {
      const handle = this.rectEl.createDiv({ cls: "mv-crop-handle mv-crop-" + name });
      handle.dataset.handle = name;
      this.handleEls.set(name, handle);
    }
    this.readoutEl = this.rectEl.createDiv({ cls: "mv-crop-readout" });

    this.el.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    this.el.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    this.el.addEventListener("pointerup", (event) => this.handlePointerUp(event));
    this.el.addEventListener("pointercancel", (event) => this.handlePointerUp(event));

    this.paint();
  }

  get bounds() {
    const read = this.options.bounds;
    const size = typeof read === "function" ? read() : null;
    return { width: (size && size.width) || 0, height: (size && size.height) || 0 };
  }

  // Pointer position in the overlay's own coordinates. Read from the live
  // bounding box rather than cached at drag start, because a pane can be
  // resized mid-drag and a cached origin would silently offset the result.
  pointFrom(event) {
    const box =
      typeof this.el.getBoundingClientRect === "function"
        ? this.el.getBoundingClientRect()
        : { left: 0, top: 0 };
    return { x: (event.clientX || 0) - (box.left || 0), y: (event.clientY || 0) - (box.top || 0) };
  }

  handlePointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return false;
    const target = event.target;
    const handle = target && target.dataset ? target.dataset.handle : null;
    const point = this.pointFrom(event);

    let from;
    let grip;
    if (handle) {
      grip = handle;
      from = this.selection;
    } else if (this.selection && target && typeof target.closest === "function" && target.closest(".mv-crop-rect")) {
      grip = "move";
      from = this.selection;
    } else {
      // A fresh drag starts as a zero-size rectangle at the pointer, resized
      // by its south-east handle — so drawing and resizing are the same code
      // path, including under an aspect lock.
      grip = "se";
      from = { x: point.x, y: point.y, w: 0, h: 0 };
      this.selection = from;
    }
    if (!from) return false;

    this.drag = { handle: grip, origin: point, from: normaliseRect(from), pointerId: event.pointerId };
    if (typeof this.el.setPointerCapture === "function" && event.pointerId !== undefined) {
      this.el.setPointerCapture(event.pointerId);
    }
    if (typeof event.preventDefault === "function") event.preventDefault();
    this.el.addClass("is-dragging");
    this.paint();
    return true;
  }

  handlePointerMove(event) {
    const drag = this.drag;
    if (!drag) return false;
    if (event.pointerId !== undefined && event.pointerId !== drag.pointerId) return false;
    const point = this.pointFrom(event);
    // Measured from where the drag started, not from the previous frame: frame
    // deltas accumulate rounding, and drift every time a clamp eats part of a
    // move.
    this.selection = resizeSelection(
      drag.from,
      drag.handle,
      point.x - drag.origin.x,
      point.y - drag.origin.y,
      this.bounds,
      this.aspect
    );
    this.paint();
    this.notify();
    return true;
  }

  handlePointerUp(event) {
    const drag = this.drag;
    if (!drag) return false;
    if (event && event.pointerId !== undefined && event.pointerId !== drag.pointerId) return false;
    this.drag = null;
    this.el.removeClass("is-dragging");
    if (typeof this.el.releasePointerCapture === "function" && drag.pointerId !== undefined) {
      this.el.releasePointerCapture(drag.pointerId);
    }
    // A click is a drag that went nowhere, and it means "no selection" rather
    // than "a selection four pixels wide". Clearing here rather than during the
    // drag is what lets someone start a selection, change their mind and drag
    // back to nothing.
    if (isNegligibleSelection(this.selection)) this.selection = null;
    this.paint();
    this.notify();
    return true;
  }

  setAspect(ratio) {
    const value = Number(ratio);
    this.aspect = Number.isFinite(value) && value > 0 ? value : null;
    // Re-applied immediately, so choosing a ratio reshapes what is already
    // selected instead of waiting for the next drag to honour it.
    if (this.selection && this.aspect) {
      this.selection = resizeSelection(this.selection, "se", 0, 0, this.bounds, this.aspect);
      this.paint();
      this.notify();
    }
    return this.aspect;
  }

  set(rect) {
    this.selection = rect ? clampRect(rect, this.bounds.width, this.bounds.height) : null;
    if (this.selection && isNegligibleSelection(this.selection)) this.selection = null;
    this.paint();
    this.notify();
    return this.selection;
  }

  clear() {
    if (!this.selection) return false;
    this.selection = null;
    this.paint();
    this.notify();
    return true;
  }

  // The whole picture, as a selection. What "select all" means, and what a
  // fresh aspect ratio is applied to when there is nothing selected yet.
  selectAll() {
    const bounds = this.bounds;
    return this.set({ x: 0, y: 0, w: bounds.width, h: bounds.height });
  }

  notify() {
    if (typeof this.options.onChange === "function") this.options.onChange(this.selection);
  }

  paint() {
    const rect = this.selection;
    this.el.toggleClass("has-selection", Boolean(rect));
    if (!rect) {
      this.rectEl.style.display = "none";
      return;
    }
    this.rectEl.style.display = "";
    this.rectEl.style.left = rect.x + "px";
    this.rectEl.style.top = rect.y + "px";
    this.rectEl.style.width = rect.w + "px";
    this.rectEl.style.height = rect.h + "px";
    const label = this.options.label;
    this.readoutEl.setText(typeof label === "function" ? label(rect) || "" : "");
  }

  destroy() {
    this.drag = null;
    this.selection = null;
    if (this.el && typeof this.el.remove === "function") this.el.remove();
  }
}

/* ------------------------------------------------------------------------ *
 * LineageStore — where the notes are, without ever looking for them.
 *
 * Two maps, built once from `metadataCache` and kept current from its
 * `changed` event:
 *
 *   media path → the note that declares it
 *   media path → the notes naming it as `source:`
 *
 * No filename convention, no directory listing, no candidate paths tried in
 * order. The first draft had all three, because that is how a program with no
 * index finds a file. This vault has an index: a note declaring
 * `media: "[[cover.png]]"` is found by what it says, wherever it sits and
 * whatever it is called — so a note the user moves or renames by hand keeps
 * working, because nothing ever depended on where it was.
 * ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ *
 * Guarding — MV-ERRORS.
 *
 * One bad file must never take down the grid. The old app crash-logged
 * instead, into logs/app_crash.log, because a PyQt process that throws takes
 * everything with it; a plugin throws inside a render loop and leaves the pane
 * half-drawn, which is worse in a quieter way.
 *
 * So every boundary where one item is processed among many — a tile, a note, a
 * cache event — runs inside this. It reports through console.error with the
 * operation and the subject, which is the discipline the crash log existed for,
 * and returns the fallback so the loop goes on to the next one.
 *
 * Deliberately not a Notice. These are per-item failures in a loop that is
 * about to try ninety-nine more, and a modal per bad file is not a diagnosis,
 * it is a wall. A Notice belongs where the user asked for something and did not
 * get it.
 * ------------------------------------------------------------------------ */
/* The crash log.
 *
 * MV-LOG was retired for good reason — a ring buffer and a file writer
 * reproducing a worse devtools console. This is not that. It exists so that
 * someone using the plugin can hand over what broke without being asked to
 * open devtools and reproduce it, which is the difference between a bug report
 * and a shrug.
 *
 * So: only failures, never tracing. Writes are debounced because a loop that
 * throws on every file would otherwise turn one bad folder into a thousand
 * disk writes, and the file is trimmed from the front because the newest
 * failure is the one being asked about.
 */
class CrashLog {
  constructor(app, options) {
    const settings = options || {};
    this.app = app;
    this.path = settings.path || CRASH_LOG_PATH;
    this.maxBytes = settings.maxBytes || CRASH_LOG_MAX_BYTES;
    this.enabled = settings.enabled !== false;
    this.onNotice = typeof settings.onNotice === "function" ? settings.onNotice : null;
    // Held in memory as well as on disk, so "Copy crash log" answers even if
    // every write failed — which is exactly the situation worth reporting.
    this.entries = [];
    this.pending = [];
    this.timer = null;
    this.lastNoticeAt = 0;
    // A write that fails must not be retried on every entry forever; one
    // report is enough, and the memory buffer still holds everything.
    this.writeFailed = false;
  }

  record(scope, message, error) {
    if (!this.enabled) return null;
    const entry = { time: new Date(), level: "ERROR", scope, message, error };
    const line = formatLogEntry(entry);
    this.entries.push(line);
    while (this.entries.length > CRASH_LOG_BUFFER) this.entries.shift();
    this.pending.push(line);
    this.scheduleFlush();
    this.notice();
    return line;
  }

  // One notice per interval. A failure usually arrives with friends, and a
  // toast per file is worse than the failure.
  notice() {
    if (!this.onNotice) return;
    const now = Date.now();
    if (now - this.lastNoticeAt < CRASH_NOTICE_INTERVAL_MS) return;
    this.lastNoticeAt = now;
    this.onNotice();
  }

  scheduleFlush() {
    if (this.timer !== null) return;
    if (typeof window === "undefined" || !window.setTimeout) {
      // No timer to schedule against — flush inline rather than never.
      this.flush();
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
  }

  async flush() {
    if (!this.pending.length || this.writeFailed) return false;
    const text = this.pending.join("\n") + "\n";
    this.pending = [];
    const adapter = this.app && this.app.vault && this.app.vault.adapter;
    if (!adapter || typeof adapter.write !== "function") return false;
    try {
      let existing = "";
      if (typeof adapter.exists === "function" && (await adapter.exists(this.path))) {
        existing = typeof adapter.read === "function" ? await adapter.read(this.path) : "";
      }
      await adapter.write(this.path, trimLogText(existing + text, this.maxBytes));
      return true;
    } catch (error) {
      // Reported once, to the console rather than to itself — a log that
      // recurses on its own write failure helps nobody.
      this.writeFailed = true;
      console.error("Media Viewer: could not write the crash log", error);
      return false;
    }
  }

  text() {
    return this.entries.join("\n");
  }

  async clear() {
    this.entries = [];
    this.pending = [];
    this.writeFailed = false;
    const adapter = this.app && this.app.vault && this.app.vault.adapter;
    if (!adapter || typeof adapter.write !== "function") return false;
    try {
      await adapter.write(this.path, "");
      return true;
    } catch (error) {
      console.error("Media Viewer: could not clear the crash log", error);
      return false;
    }
  }

  dispose() {
    if (this.timer !== null && typeof window !== "undefined" && window.clearTimeout) {
      window.clearTimeout(this.timer);
    }
    this.timer = null;
    return this.flush();
  }
}

/* The log every guarded path reports to.
 *
 * Module-level rather than passed down, because guarded() is called from
 * places that hold no plugin reference — and threading one through forty call
 * sites to reach a logger would be a worse cost than this. Set on load,
 * cleared on unload, so a stale plugin instance cannot keep logging. */
let activeCrashLog = null;

function setCrashLog(log) {
  activeCrashLog = log;
  return activeCrashLog;
}

// Every failure in the plugin goes through here: the console keeps its message
// for whoever has devtools open, and the log keeps it for whoever does not.
function reportFailure(scope, message, error) {
  // The console line every call site used to print itself, unchanged — this
  // function widens where a failure goes, it does not reword it.
  console.error("Media Viewer: " + message, error);
  if (activeCrashLog) {
    try {
      activeCrashLog.record(scope, message, error);
    } catch (loggingError) {
      console.error("Media Viewer: the crash log itself failed", loggingError);
    }
  }
}

function guarded(operation, subject, action, fallback) {
  try {
    return action();
  } catch (error) {
    reportFailure("guard", operation + " failed for " + (subject || "an unnamed item"), error);
    return fallback;
  }
}

class LineageStore {
  constructor(app, options) {
    const settings = options || {};
    this.app = app;
    // Where new notes are written. Never used to find one.
    this.noteFolder = settings.noteFolder || DEFAULT_NOTE_FOLDER;
    // note path → record
    this.records = new Map();
    // media path → note path
    this.byMedia = new Map();
    // media path → Set of note paths naming it as source
    this.bySource = new Map();
    // Links that resolve to nothing, kept so a break can be reported by the
    // name the note actually holds rather than as an anonymous "missing".
    this.danglingSources = new Map();
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
  }

  /* Build from what the cache already holds.
   *
   * Every markdown file's frontmatter is already parsed and in memory by the
   * time this runs, so this is a walk over data rather than a scan of disk —
   * which is the difference between "cheap on a large vault" and "the reason
   * the pane takes a second to open".
   */
  build() {
    this.records.clear();
    this.byMedia.clear();
    this.bySource.clear();
    this.danglingSources.clear();
    const files = typeof this.app.vault.getMarkdownFiles === "function" ? this.app.vault.getMarkdownFiles() : [];
    for (const file of files) {
      guarded("reading lineage from", file && file.path, () => {
        const cache = this.app.metadataCache.getFileCache(file);
        this.absorb(file, cache && cache.frontmatter);
      });
    }
    this.notify();
    return this.records.size;
  }

  // One note's contribution to the maps. Called on build and on every
  // `changed`, so it has to be idempotent — which it is, because it retracts
  // the note's previous contribution first.
  absorb(file, frontmatter) {
    this.retract(file.path);
    if (!frontmatter || frontmatter.implements !== INSTANCE_SCHEMA) return null;
    const record = instanceRecordFrom(frontmatter, file.path);
    record.mediaPath = this.resolveLink(record.mediaLink, file.path);
    record.sourcePath = this.resolveLink(record.sourceLink, file.path);
    this.records.set(file.path, record);
    if (record.mediaPath) {
      /* Two notes claiming the same file is a conflict the plugin cannot
         resolve — both are equally valid declarations — so the first one wins
         and the second is reported rather than silently overwriting it. */
      const existing = this.byMedia.get(record.mediaPath);
      if (existing && existing !== file.path) {
        console.warn(
          "Media Viewer: " + record.mediaPath + " is claimed by two notes, " + existing + " and " + file.path
        );
      } else {
        this.byMedia.set(record.mediaPath, file.path);
      }
    }
    if (record.sourcePath) {
      if (!this.bySource.has(record.sourcePath)) this.bySource.set(record.sourcePath, new Set());
      this.bySource.get(record.sourcePath).add(file.path);
    } else if (record.sourceLink) {
      // A source that names something the vault does not hold. Reported, never
      // silently repaired: the file may simply not be here yet.
      this.danglingSources.set(file.path, record.sourceLink);
    }
    return record;
  }

  retract(notePath) {
    const previous = this.records.get(notePath);
    if (!previous) return false;
    this.records.delete(notePath);
    this.danglingSources.delete(notePath);
    if (previous.mediaPath && this.byMedia.get(previous.mediaPath) === notePath) {
      this.byMedia.delete(previous.mediaPath);
    }
    if (previous.sourcePath) {
      const children = this.bySource.get(previous.sourcePath);
      if (children) {
        children.delete(notePath);
        if (!children.size) this.bySource.delete(previous.sourcePath);
      }
    }
    return true;
  }

  /* A wikilink resolved against the vault.
   *
   * getFirstLinkpathDest is what Obsidian uses for its own links, so a note
   * holding `[[cover.png]]` finds the same file the editor would jump to —
   * including when two folders hold a file of that name and the nearer one
   * wins. Returning null is the dangling case, and it is a normal one.
   */
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

  /* Event handling. Three lines of work each, and for most of the vault the
     first line is a miss. */

  handleMetadataChange(file, data, cache) {
    if (!file || !file.path || !file.path.toLowerCase().endsWith(".md")) return false;
    const before = this.records.has(file.path);
    const after = guarded("reading lineage from", file.path, () =>
      this.absorb(file, cache && cache.frontmatter)
    , null);
    if (!before && !after) return false;
    this.notify();
    return true;
  }

  handleDelete(file) {
    if (!file || !file.path) return false;
    let changed = this.retract(file.path);
    /* A media file going away does not remove its note — the note is a record
       in data/ and it stays where it is. What changes is that its children's
       `source:` now dangles, which is reported rather than repaired: the file
       may be coming back from the other end of a sync. */
    if (this.byMedia.has(file.path) || this.bySource.has(file.path)) changed = true;
    if (changed) this.notify();
    return changed;
  }

  // A rename that Obsidian's own link updating has already handled arrives
  // here as a metadata change too, so this only has to move the keys; the
  // rewriting case is MV-RENAME's.
  handleRename(file, oldPath) {
    if (!file || !file.path) return false;
    let changed = false;
    if (this.records.has(oldPath)) {
      const record = this.records.get(oldPath);
      this.retract(oldPath);
      record.notePath = file.path;
      this.records.set(file.path, record);
      if (record.mediaPath) this.byMedia.set(record.mediaPath, file.path);
      if (record.sourcePath) {
        if (!this.bySource.has(record.sourcePath)) this.bySource.set(record.sourcePath, new Set());
        this.bySource.get(record.sourcePath).add(file.path);
      }
      changed = true;
    }
    if (this.byMedia.has(oldPath)) {
      this.byMedia.set(file.path, this.byMedia.get(oldPath));
      this.byMedia.delete(oldPath);
      changed = true;
    }
    if (this.bySource.has(oldPath)) {
      this.bySource.set(file.path, this.bySource.get(oldPath));
      this.bySource.delete(oldPath);
      changed = true;
    }
    if (changed) this.notify();
    return changed;
  }

  notify() {
    if (this.onChange) this.onChange(this);
  }

  /* Reading. */

  isTracked(mediaPath) {
    return this.byMedia.has(mediaPath);
  }

  noteFileFor(mediaPath) {
    const notePath = this.byMedia.get(mediaPath);
    if (!notePath) return null;
    const file = this.app.vault.getAbstractFileByPath(notePath);
    return file || null;
  }

  recordFor(mediaPath) {
    const notePath = this.byMedia.get(mediaPath);
    return notePath ? this.records.get(notePath) || null : null;
  }

  recordAt(notePath) {
    return this.records.get(notePath) || null;
  }

  parentOf(mediaPath) {
    const record = this.recordFor(mediaPath);
    return record ? record.sourcePath : null;
  }

  // The media files derived from this one, in a stable order so the panel does
  // not reshuffle itself between renders.
  childrenOf(mediaPath) {
    const notes = this.bySource.get(mediaPath);
    if (!notes) return [];
    const children = [];
    for (const notePath of notes) {
      const record = this.records.get(notePath);
      if (record && record.mediaPath) children.push(record.mediaPath);
    }
    return children.sort(compareMediaPaths);
  }

  // Every note whose `source:` names something the vault does not hold, as
  // { notePath, link }. The vault-wide break report MV-REPAIR builds is this
  // plus the notes whose `media:` has gone.
  breaks() {
    const found = [];
    for (const [notePath, link] of this.danglingSources) {
      found.push({ notePath, link, kind: "source" });
    }
    for (const [notePath, record] of this.records) {
      if (record.mediaLink && !record.mediaPath) {
        found.push({ notePath, link: record.mediaLink, kind: "media" });
      }
    }
    return found.sort((a, b) => (a.notePath < b.notePath ? -1 : a.notePath > b.notePath ? 1 : 0));
  }

  /* Writing.
   *
   * One method, because creating and updating differ only in whether there is
   * a file already — and the thing that must not differ is that the user's
   * prose below the marker survives either way.
   */
  async write(mediaPath, fields) {
    const existing = this.noteFileFor(mediaPath);
    const values = Object.assign({}, fields, { media: wikilinkFor(mediaPath) });
    if (existing) {
      const raw = await this.app.vault.read(existing);
      // Unknown frontmatter is carried across as well as the body: a field
      // someone added by hand is theirs, not ours to drop.
      const record = this.records.get(existing.path);
      const carried = record ? this.carriedFields(record.frontmatter, values) : {};
      const text = renderInstanceNote(Object.assign(carried, values), notesBodyOf(raw));
      await this.app.vault.modify(existing, text);
      return existing;
    }
    const folder = this.noteFolder;
    await this.ensureFolder(folder);
    const path = notePathFor(folder, mediaPath, (candidate) => this.exists(candidate));
    const file = await this.app.vault.create(path, renderInstanceNote(values, ""));
    // The cache's `changed` event arrives later; inserting here means the note
    // is findable the moment it exists, which is what the save path needs when
    // it writes a root note and a child note in the same breath.
    if (file) this.absorb(file, Object.assign({ implements: INSTANCE_SCHEMA }, values));
    this.notify();
    return file;
  }

  /* Everything the caller did not name, carried across untouched.
   *
   * Known fields as well as unknown ones: a rewrite says what it is changing,
   * and a rename that has to move one link must not drop the crop rectangle
   * beside it. `implements` is the one exclusion, because it is re-emitted.
   */
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
      // Already there, most likely — createFolder throws rather than
      // returning, and a race with another plugin is not worth failing over.
      return false;
    }
  }
}

/* ------------------------------------------------------------------------ *
 * MetadataResolver — the chain walk, against a live store.
 *
 * Thin on purpose: everything it decides is a `core` function, and what it
 * adds is the store to look records up in and the reporting the design asks
 * for — a cycle or an over-deep chain is logged as well as surfaced, because
 * the one thing neither should ever do is quietly produce a plausible answer.
 * ------------------------------------------------------------------------ */

class MetadataResolver {
  constructor(store, options) {
    const settings = options || {};
    this.store = store;
    this.limit = settings.limit || CHAIN_HOP_LIMIT;
    // Reported once per file rather than once per lookup: the panel resolves
    // every field on every render, and a loop that logged each time would fill
    // the console faster than it could be read.
    this.reported = new Set();
  }

  lookup() {
    return (path) => this.store.recordFor(path);
  }

  walk(mediaPath) {
    const walk = walkChain(mediaPath, this.lookup(), this.limit);
    this.report(mediaPath, walk);
    return walk;
  }

  resolve(field, mediaPath) {
    const answer = resolveField(field, mediaPath, this.lookup(), this.limit);
    this.report(mediaPath, answer.walk);
    return answer;
  }

  resolveAll(mediaPath) {
    const answer = resolveFields(mediaPath, this.lookup(), this.limit);
    this.report(mediaPath, answer.walk);
    return answer;
  }

  // The chain as media paths, nearest first. What the panel walks to draw
  // itself, and what a break report needs to name the file it stopped at.
  ancestry(mediaPath) {
    return this.walk(mediaPath).chain.map((step) => step.path);
  }

  report(mediaPath, walk) {
    if (!walk || walk.stopped === CHAIN_END) {
      this.reported.delete(mediaPath);
      return false;
    }
    if (this.reported.has(mediaPath)) return false;
    this.reported.add(mediaPath);
    console.warn("Media Viewer: " + chainProblemMessage(walk, mediaPath));
    return true;
  }
}

/* The break report, on screen.
 *
 * A list rather than a fixer. Every row names the note and what is wrong with
 * it, and offers to open the note — because every break here is something only
 * a person can decide about: a file that has moved, a file that is genuinely
 * gone, a `source:` typed by hand. The console gets the same list, so it
 * survives the modal being closed.
 */
class LineageBreakModal extends Modal {
  constructor(app, plugin, breaks) {
    super(app);
    this.plugin = plugin;
    this.breaks = breaks || [];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mv-breaks");
    contentEl.createEl("h3", {
      text: this.breaks.length === 1 ? "1 lineage break" : this.breaks.length + " lineage breaks",
    });
    contentEl.createEl("p", {
      cls: "mv-breaks-intro",
      text:
        "Nothing here has been changed. A source naming a file that is not in the vault may be a file that has moved, one that is genuinely gone, or one that has not synced yet — and only you can tell which.",
    });
    const list = contentEl.createDiv({ cls: "mv-breaks-list" });
    for (const entry of this.breaks) {
      const row = list.createDiv({ cls: "mv-breaks-row" });
      const name = entry.notePath || entry.mediaPath || "";
      const link = row.createEl("button", {
        cls: "mv-breaks-link",
        text: baseNameOf(name),
        attr: { type: "button", title: name },
      });
      link.addEventListener("click", () => this.openNote(entry));
      row.createSpan({ cls: "mv-breaks-message", text: entry.message });
    }
  }

  openNote(entry) {
    const path = entry.notePath || entry.mediaPath;
    if (!path) return false;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return false;
    this.close();
    void this.app.workspace.getLeaf(false).openFile(file);
    return true;
  }

  onClose() {
    this.contentEl.empty();
  }
}

class MediaViewerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.headerEl = null;
    this.folderEl = null;
    this.gridEl = null;
    this.emptyEl = null;
    this.observer = null;
    // path -> tile element, for every tile currently in the DOM.
    this.tiles = new Map();
    // Paths whose tile is inside the preload margin right now. The LRU consults
    // this before it lets a thumbnail go.
    this.visible = new Set();
    // path -> tile, capped. Membership means "this tile has its thumbnail".
    this.thumbnails = new LruCache(THUMBNAIL_CACHE_SIZE, (path, tile) =>
      this.unloadThumbnail(path, tile)
    );

    /* Video frames, path -> blob URL, capped separately.
     *
     * Two caches rather than one because the two costs are nothing alike. An
     * image thumbnail is a URL the browser decodes and can drop at will; a
     * video frame is a disk seek, a decode and an encode, and throwing one
     * away means paying all three again. So the tile cache may strip a video
     * tile's <img> while the frame it was showing survives here, and scrolling
     * back is instant rather than another trip to the drive.
     *
     * The eviction callback is where every blob URL is revoked, exactly once —
     * which is the reason the LRU calls it on replace and on clear() as well
     * as on eviction. */
    this.frames = new LruCache(VIDEO_FRAME_CACHE_SIZE, (path, url) => this.revokeFrame(path, url));
    // Paths waiting for a decoder slot, and the jobs holding one. Both keyed
    // by path, so a tile that scrolls away can withdraw whichever it is in.
    this.frameQueue = [];
    this.frameJobs = new Map();
    // Paths that have already failed. Retrying a file the browser cannot
    // decode on every scroll past it is a stall with no possible outcome.
    this.frameFailures = new Set();

    // Viewer state. Zoom is a factor, pan is the image centre offset from the
    // stage centre in CSS pixels, and both are meaningless until an image has
    // reported its natural size.
    this.viewerPath = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.imageEl = null;
    this.dragging = null;

    // Video state. The element owns the position — asking it is always right,
    // where a copy kept here would drift every time playback advanced — so
    // what is held is only what the element cannot answer: the duration last
    // seen, whether a drag is in progress, and a seek waiting for metadata.
    this.videoEl = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.videoDuration = 0;
    this.scrubbing = false;
    this.pendingSeek = null;
    // Speed belongs to the pane rather than to the file: someone reviewing a
    // folder at 2x wants the next clip at 2x too, and re-choosing it for every
    // file is the kind of small friction that stops the control being used. It
    // is not persisted — a speed that survived a restart would be a surprise
    // with no visible cause.
    this.playbackRate = 1;
    // Set when the pointer paused a video that was playing, and cleared the
    // moment the user does anything deliberate. It is the difference between
    // "held for a look" and "stopped here on purpose".
    this.hoverPaused = false;

    /* Edit state. Null until the user asks for it, because a session owns a
       full-resolution decode of the file and opening one for every image
       browsed past would be the decode budget spent on looking. Cleared
       whenever selection moves: an edit belongs to the file it was started
       on. */
    this.session = null;
    this.overlay = null;
    this.editCanvasEl = null;
    this.editFrameEl = null;
    this.editStatusEl = null;
    // Set while a decode is in flight, so a second click on Edit does not
    // start a second one and so a decode that finishes after the user has
    // moved on can tell that it has.
    this.editLoading = null;
    // The panel is open by default: it is the part of this plugin that is not
    // a media browser, and one nobody would find if it started folded away.
    this.lineageOpen = true;
    this.lineageEl = null;
    // Set while an encode and write are in flight, so a second Save does not
    // produce a second file from the same click.
    this.saving = null;
  }

  getViewType() {
    return VIEW_TYPE_MEDIA_VIEWER;
  }

  getDisplayText() {
    const folder = this.plugin.index.folder;
    return folder === null ? "Media Viewer" : "Media Viewer: " + folderLabelFor(folder);
  }

  getIcon() {
    return "image";
  }

  get index() {
    return this.plugin.index;
  }

  get settings() {
    return this.plugin.settings;
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("media-viewer");
    this.buildChrome(root);
    this.ensureObserver();
    this.render();
  }

  async onClose() {
    // A detached <video> keeps its stream: closing the pane on a playing file
    // and still hearing it is the bug this exists to prevent.
    this.releaseVideo();
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    // clear() runs the eviction callback for every entry, which is how a blob
    // URL gets revoked exactly once. The tiles are about to go anyway; the
    // point is that nothing leaks past them.
    this.cancelAllFrameJobs();
    this.frames.clear();
    this.frameFailures.clear();
    this.thumbnails.clear();
    this.tiles.clear();
    this.visible.clear();
    this.contentEl.empty();
  }

  buildChrome(root) {
    const header = root.createDiv({ cls: "mv-header" });
    this.headerEl = header;

    this.folderEl = header.createDiv({ cls: "mv-folder", text: "No folder" });

    const controls = header.createDiv({ cls: "mv-controls" });

    const filter = controls.createEl("select", { cls: "dropdown mv-filter" });
    for (const [value, label] of [["both", "All media"], ["image", "Images"], ["video", "Videos"]]) {
      filter.createEl("option", { value, text: label });
    }
    filter.value = this.settings.filter;
    filter.addEventListener("change", () => {
      this.plugin.setFilter(filter.value);
    });
    this.filterEl = filter;

    this.recursiveEl = this.toggleButton(controls, "Include subfolders", () => {
      this.plugin.setRecursive(!this.settings.recursive);
    });

    this.followEl = this.toggleButton(controls, "Follow the active file", () => {
      this.plugin.setFollowActiveFile(!this.settings.followActiveFile);
    });

    // The body holds the viewer and the grid side by side or stacked; which of
    // those it is depends on the pane's own width, and MV-LAYOUT decides it.
    const body = root.createDiv({ cls: "mv-body" });
    this.bodyEl = body;

    this.buildViewer(body);

    this.gridEl = body.createDiv({ cls: "mv-grid" });
    this.emptyEl = body.createDiv({ cls: "mv-empty" });

    this.buildLineage(body);

    // Delegated, so a folder of 500 files installs one listener rather than
    // 500 — and so tiles can be added and removed without touching listeners.
    this.gridEl.addEventListener("click", (event) => {
      const tile = event.target.closest(".mv-tile");
      if (tile && tile.dataset.path) this.plugin.select(tile.dataset.path);
    });

    // Keyboard handling is bound to the pane, not the document: W, A, S and D
    // are ordinary letters everywhere else in Obsidian, and a plugin that
    // swallowed them globally would break typing.
    root.setAttribute("tabindex", "0");
    root.addEventListener("keydown", (event) => this.handleKey(event));

    // Bound to the pane, not the document: Obsidian's own paste puts an image
    // in the attachment folder and a link in the note, which is right for a
    // note being written. This one only applies where the pane is what has
    // focus, and where "the current folder" is a thing that exists.
    root.addEventListener("paste", (event) => this.handlePaste(event));
  }

  buildViewer(parent) {
    const viewer = parent.createDiv({ cls: "mv-viewer" });
    this.viewerEl = viewer;

    const stage = viewer.createDiv({ cls: "mv-stage" });
    this.stageEl = stage;
    stage.addEventListener("wheel", (event) => this.handleWheel(event));
    // Enter and leave rather than over and out: these do not fire again as the
    // pointer crosses between the stage and the video inside it.
    stage.addEventListener("pointerenter", () => this.handlePointerEnter());
    stage.addEventListener("pointerleave", () => this.handlePointerLeave());
    stage.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    stage.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    stage.addEventListener("pointerup", (event) => this.handlePointerUp(event));
    stage.addEventListener("pointercancel", (event) => this.handlePointerUp(event));
    // A double-click toggles between fitting the pane and full size, which is
    // the gesture every image viewer has and the fastest way back from a deep
    // zoom.
    stage.addEventListener("dblclick", () => this.toggleFit());

    this.buildVideoBar(viewer);
    this.buildEditBar(viewer);

    const bar = viewer.createDiv({ cls: "mv-viewer-bar" });
    this.viewerBarEl = bar;

    this.prevEl = this.barButton(bar, "Previous", () => this.plugin.selectSibling(-1));
    this.nextEl = this.barButton(bar, "Next", () => this.plugin.selectSibling(1));
    this.zoomEl = bar.createDiv({ cls: "mv-zoom" });
    this.fitEl = this.barButton(bar, "Fit", () => this.fitToPane());
    this.fitEl.addClass("mv-zoom-control");
    this.fullEl = this.barButton(bar, "100%", () => this.zoomToActualSize());
    this.fullEl.addClass("mv-zoom-control");

    // One button, two states. Editing is a mode the pane is in rather than a
    // window it opens — the old app's crop dialog was a second copy of the
    // viewer, and this is the whole point of not having one.
    this.editEl = this.barButton(bar, "Edit", () => this.toggleEdit());
    this.editEl.addClass("mv-edit-toggle");

    this.viewerNameEl = bar.createDiv({ cls: "mv-viewer-name" });

    // showInViewer short-circuits when the path has not changed, and it starts
    // as null — so the empty stage has to be drawn once here rather than
    // waiting for a selection that may never come.
    this.renderViewer();
  }

  /* The transport. Built once and hidden by class rather than created when a
     video opens, so stepping video → image → video does not rebuild it, and so
     the scrub element's identity survives — which is what makes a drag in
     progress something the pane can track at all. */
  buildVideoBar(parent) {
    const bar = parent.createDiv({ cls: "mv-video-bar" });
    this.videoBarEl = bar;

    this.playEl = this.barButton(bar, "Play", () => this.togglePlayback());
    this.playEl.addClass("mv-play");

    this.stepBackEl = this.barButton(bar, "◀|", () => this.stepFrame(-1));
    this.stepBackEl.addClass("mv-step");
    this.stepBackEl.setAttribute("aria-label", "Step back one frame");
    this.stepBackEl.title = "Step back one frame (,)";

    this.stepForwardEl = this.barButton(bar, "|▶", () => this.stepFrame(1));
    this.stepForwardEl.addClass("mv-step");
    this.stepForwardEl.setAttribute("aria-label", "Step forward one frame");
    this.stepForwardEl.title = "Step forward one frame (.)";

    const scrub = bar.createEl("input", {
      cls: "mv-scrub",
      attr: {
        type: "range",
        min: "0",
        max: String(SCRUB_RESOLUTION),
        step: "1",
        value: "0",
        "aria-label": "Playback position",
      },
    });
    // "input" fires throughout a drag, so seeking follows the thumb rather
    // than waiting for release. The flag stops the element's own timeupdate
    // from writing the thumb back underneath the pointer holding it.
    scrub.addEventListener("input", () => {
      this.scrubbing = true;
      this.seekToScrub(scrub.value);
    });
    scrub.addEventListener("change", () => {
      this.scrubbing = false;
      this.seekToScrub(scrub.value);
    });
    // A drag that ends outside the bar still ends the drag; without these the
    // thumb would stay frozen for the rest of the file.
    scrub.addEventListener("pointerup", () => {
      this.scrubbing = false;
    });
    scrub.addEventListener("pointercancel", () => {
      this.scrubbing = false;
    });
    scrub.addEventListener("blur", () => {
      this.scrubbing = false;
    });
    this.scrubEl = scrub;

    this.timeEl = bar.createDiv({ cls: "mv-time", text: "--:-- / --:--" });

    const speed = bar.createEl("select", {
      cls: "dropdown mv-speed",
      attr: { "aria-label": "Playback speed" },
    });
    for (const rate of SPEED_STEPS) {
      speed.createEl("option", { value: String(rate), text: formatSpeed(rate) });
    }
    speed.value = String(this.playbackRate);
    speed.addEventListener("change", () => this.setPlaybackRate(speed.value));
    this.speedEl = speed;

    this.updateVideoBar();
  }

  barButton(parent, label, onClick) {
    const button = parent.createEl("button", {
      cls: "mv-viewer-button",
      text: label,
      attr: { type: "button" },
    });
    button.addEventListener("click", onClick);
    return button;
  }

  toggleButton(parent, label, onClick) {
    const button = parent.createEl("button", { cls: "mv-toggle", text: label, attr: { type: "button" } });
    button.addEventListener("click", onClick);
    return button;
  }

  /* Lazy loading.
   *
   * One observer for the pane, rooted on the scrolling grid, watching every
   * tile. A tile that scrolls into range loads; a tile that scrolls out stays
   * loaded until the LRU decides otherwise, because scrolling back is the
   * common case and reloading on every pass would make that feel worse than
   * not caching at all. */
  ensureObserver() {
    if (this.observer || !this.gridEl) return;
    if (typeof IntersectionObserver !== "function") return;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = entry.target.dataset.path;
          if (!path) continue;
          guarded("handling visibility of", path, () => {
          if (entry.isIntersecting) {
            this.visible.add(path);
            this.watchFirstThumbs(path);
            this.loadThumbnail(entry.target, path);
          } else {
            this.visible.delete(path);
            // A frame still queued for a tile that has scrolled away is work
            // for a screen nobody is looking at. One already decoding is left
            // to finish: it has paid for its slot, and cancelling mid-seek
            // wastes what it spent.
            this.withdrawQueuedFrame(path);
          }
          });
        }
      },
      { root: this.gridEl, rootMargin: THUMBNAIL_PRELOAD_MARGIN }
    );
  }

  // Reconcile rather than rebuild. A save inserts one file into a folder of
  // 500, and rebuilding the grid for it would throw away scroll position, the
  // selection highlight and every loaded thumbnail — the three complaints the
  // path-keyed design exists to answer.
  render() {
    if (!this.gridEl) return;
    const folder = this.index.folder;

    if (this.folderEl) {
      this.folderEl.setText(folder === null ? "No folder" : folderLabelFor(folder));
      this.folderEl.title = folder === null ? "" : folder;
    }
    if (this.recursiveEl) this.recursiveEl.toggleClass("is-active", this.settings.recursive);
    if (this.followEl) this.followEl.toggleClass("is-active", this.settings.followActiveFile);
    if (this.filterEl && this.filterEl.value !== this.settings.filter) {
      this.filterEl.value = this.settings.filter;
    }

    const paths = folder === null ? [] : this.plugin.visiblePaths();
    /* The clock for first-visible-thumbs. Started when the grid is drawn and
       stopped when the first batch the observer reports has finished loading,
       which is the number M6's performance pass is actually about: how long
       until there is something to look at. */
    this.gridDrawnAt = Date.now();
    this.firstThumbs = null;
    this.syncTiles(paths);
    this.showInViewer(this.plugin.selectedPath);
    this.updateViewerBar();
    // The panel is about the selected file, so it is redrawn with everything
    // else that follows the selection. Its other trigger is the store
    // changing, which reaches it through refreshLineageViews.
    this.renderLineage();

    const message =
      folder === null
        ? "Open a media file, or choose Open in Media Viewer on a folder."
        : paths.length
        ? ""
        : this.settings.filter === "both"
        ? "No media in this folder."
        : "No " + (this.settings.filter === "image" ? "images" : "videos") + " in this folder.";
    this.emptyEl.setText(message);
    this.emptyEl.toggleClass("is-shown", Boolean(message));
    this.gridEl.toggleClass("is-hidden", Boolean(message));
  }

  syncTiles(paths) {
    const wanted = new Set(paths);

    for (const [path, tile] of Array.from(this.tiles.entries())) {
      if (wanted.has(path)) continue;
      guarded("releasing the tile for", path, () => this.releaseTile(path, tile));
    }

    // Walk the desired order against the DOM in one pass, inserting what is
    // missing and moving only what is genuinely out of place. An unchanged
    // list touches nothing.
    let cursor = this.gridEl.firstElementChild;
    for (const path of paths) {
      let tile = this.tiles.get(path);
      if (!tile) {
        tile = guarded("building a tile for", path, () => this.createTile(path), null);
        if (!tile) continue;
        this.tiles.set(path, tile);
        this.gridEl.insertBefore(tile, cursor);
        if (this.observer) this.observer.observe(tile);
      } else if (tile !== cursor) {
        this.gridEl.insertBefore(tile, cursor);
      } else {
        cursor = cursor.nextElementSibling;
        this.applySelection(tile, path);
        continue;
      }
      this.applySelection(tile, path);
    }
  }

  createTile(path) {
    const tile = document.createElement("div");
    tile.className = "mv-tile";
    tile.dataset.path = path;
    tile.title = path;
    tile.setAttribute("role", "option");

    const frame = document.createElement("div");
    frame.className = "mv-tile-frame";
    frame.dataset.kind = classifyPath(path);
    tile.appendChild(frame);

    const caption = document.createElement("div");
    caption.className = "mv-tile-name";
    caption.textContent = baseNameOf(path);
    tile.appendChild(caption);

    return tile;
  }

  applySelection(tile, path) {
    tile.toggleClass("is-selected", path === this.plugin.selectedPath);
  }

  releaseTile(path, tile) {
    if (this.observer) this.observer.unobserve(tile);
    this.cancelFrameJob(path);
    this.visible.delete(path);
    this.thumbnails.delete(path);
    this.tiles.delete(path);
    tile.remove();
  }

  /* Thumbnails.
   *
   * Images load through an <img> pointed at the vault's resource path. Videos
   * get a placeholder here; MV-VTHUMB replaces it with a real frame, and this
   * is the seam it plugs into.
   *
   * The LRU holds the path of every loaded tile. Its eviction callback strips
   * the image, which is what actually releases the decoded pixels. */
  /* First-visible-thumbnails, measured — MV-TIMING.
   *
   * The number the performance pass is about is not "how long did the scan
   * take" but "how long until there was something to look at", and those are
   * different by however long the first decodes take. So the clock starts when
   * the grid is drawn and stops when every tile in the first batch the observer
   * reported has either loaded or failed.
   *
   * Only the first batch. Everything after it is scrolling, which is a
   * different question and would turn one measurement into a stream.
   */
  watchFirstThumbs(path) {
    if (!this.gridDrawnAt) return false;
    if (!this.firstThumbs) this.firstThumbs = { pending: new Set(), done: false };
    if (this.firstThumbs.done) return false;
    this.firstThumbs.pending.add(path);
    return true;
  }

  // Called by whatever finishes a tile: a decoded image, a failed one, or a
  // video frame. A tile that never resolves simply leaves the measurement
  // unreported, which is better than reporting a number that is not one.
  settleFirstThumb(path) {
    const watch = this.firstThumbs;
    if (!watch || watch.done) return false;
    watch.pending.delete(path);
    if (watch.pending.size) return false;
    watch.done = true;
    this.plugin.logTiming(
      "first-visible-thumbs",
      this.index.folder,
      this.gridDrawnAt,
      "tiles=" + this.visible.size
    );
    return true;
  }

  loadThumbnail(tile, path) {
    return guarded("loading a thumbnail for", path, () => this.loadThumbnailUnguarded(tile, path));
  }

  loadThumbnailUnguarded(tile, path) {
    // get(), not has(): a hit is a use, and the tile should age from now
    // rather than from whenever it first loaded.
    // Already loaded: nothing to wait for, so it settles immediately rather
    // than holding the measurement open for a tile that is already on screen.
    if (this.thumbnails.get(path)) {
      this.settleFirstThumb(path);
      return;
    }
    const file = this.index.fileFor(path);
    if (!file) {
      this.settleFirstThumb(path);
      return;
    }

    const frame = tile.querySelector(".mv-tile-frame");
    if (!frame) return;

    this.thumbnails.set(path, tile);

    if (classifyPath(path) === "video") {
      this.loadVideoThumbnail(tile, frame, path, file);
      return;
    }

    if (classifyPath(path) !== "image") {
      frame.addClass("is-placeholder");
      this.settleFirstThumb(path);
      return;
    }

    const img = document.createElement("img");
    img.className = "mv-thumb";
    img.decoding = "async";
    img.alt = "";
    // One bad file must not take down the grid: a decode failure marks the
    // tile and browsing continues.
    img.addEventListener("error", () => {
      tile.addClass("is-broken");
      img.remove();
      frame.addClass("is-placeholder");
      this.settleFirstThumb(path);
    });
    img.addEventListener("load", () => {
      tile.removeClass("is-broken");
      this.settleFirstThumb(path);
    });
    // getResourcePath carries the mtime, so a modified file yields a different
    // URL and the browser cache is bypassed rather than serving the old pixels.
    img.src = this.plugin.app.vault.getResourcePath(file);
    frame.empty();
    frame.removeClass("is-placeholder");
    frame.appendChild(img);
  }

  // Called by the LRU when a path ages out. If the tile is still on screen the
  // cap has been reached by visible tiles alone, which the cap is sized to
  // prevent — reload it rather than leaving a hole, on a later turn so the
  // reload cannot re-enter the eviction it came from.
  unloadThumbnail(path, tile) {
    if (!tile || !tile.isConnected) return;
    const frame = tile.querySelector(".mv-tile-frame");
    if (frame) {
      frame.empty();
      frame.addClass("is-placeholder");
    }
    tile.removeClass("is-broken");
    if (this.visible.has(path)) {
      window.setTimeout(() => {
        if (this.visible.has(path) && this.tiles.get(path) === tile) this.loadThumbnail(tile, path);
      }, 0);
    }
  }

  // A modified file needs its thumbnail re-read, because the resource path
  // changed with the mtime. Dropping it from the cache is enough — the next
  // observer callback, or this immediate reload, puts it back.
  reloadThumbnail(path) {
    const tile = this.tiles.get(path);
    if (!tile) return;
    // The frame was drawn from the old contents, and unlike an <img> it does
    // not carry an mtime that would make the browser fetch again.
    this.frames.delete(path);
    this.frameFailures.delete(path);
    this.cancelFrameJob(path);
    this.thumbnails.delete(path);
    if (this.visible.has(path)) this.loadThumbnail(tile, path);
  }

  /* Video thumbnails.
   *
   * A frame is produced by loading the file into an offscreen <video>, seeking
   * a second in and drawing that frame to a canvas — the only way to get a
   * real frame out of a video in a browser, and expensive enough that
   * everything around it exists to do it as few times as possible: the frame
   * cache above, the queue below, and a failure set so an undecodable file is
   * attempted once rather than on every scroll past it.
   */
  loadVideoThumbnail(tile, frame, path, file) {
    const cached = this.frames.get(path);
    if (cached) {
      this.showFrame(tile, frame, path, cached);
      return;
    }
    // The placeholder stands until a frame arrives. is-pending says the
    // difference between "working on it" and "this is all there is".
    frame.empty();
    frame.addClass("is-placeholder");
    if (this.frameFailures.has(path)) {
      tile.addClass("is-broken");
      return;
    }
    frame.addClass("is-pending");
    this.enqueueFrame(path, file);
  }

  showFrame(tile, frame, path, url) {
    const img = document.createElement("img");
    img.className = "mv-thumb";
    img.decoding = "async";
    img.alt = "";
    img.src = url;
    frame.empty();
    frame.removeClass("is-placeholder");
    frame.removeClass("is-pending");
    tile.removeClass("is-broken");
    frame.appendChild(img);
  }

  withdrawQueuedFrame(path) {
    this.frameQueue = this.frameQueue.filter((entry) => entry.path !== path);
  }

  enqueueFrame(path, file) {
    if (this.frameJobs.has(path) || this.frameQueue.some((entry) => entry.path === path)) return;
    this.frameQueue.push({ path, file });
    this.pumpFrameQueue();
  }

  // Newest request first. The queue is worked while the user scrolls, and the
  // tiles they are looking at now were asked for after the ones they have
  // already scrolled past — serving those first would fill the screen behind
  // them.
  pumpFrameQueue() {
    while (this.frameJobs.size < VIDEO_THUMBNAIL_CONCURRENCY && this.frameQueue.length) {
      const next = this.frameQueue.pop();
      if (!next) return;
      this.startFrameJob(next.path, next.file);
    }
  }

  startFrameJob(path, file) {
    if (typeof document === "undefined" || !document.createElement) return;
    const video = document.createElement("video");
    const job = { path, video, timer: null, done: false };
    this.frameJobs.set(path, job);

    const finish = (url) => {
      if (job.done) return;
      job.done = true;
      this.endFrameJob(job);
      if (url) {
        this.frames.set(path, url);
        this.applyFrame(path, url);
      } else {
        this.failFrame(path);
      }
      this.pumpFrameQueue();
    };
    job.finish = finish;

    // Muted and inline: a thumbnailer that makes a sound, or that a mobile
    // build decides to present fullscreen, is not a thumbnailer.
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("loadeddata", () => {
      // loadeddata rather than loadedmetadata: metadata gives the duration but
      // not a decoded frame, and seeking before there is one is what produces
      // a blank canvas on some builds.
      try {
        video.currentTime = thumbnailSeekTime(video.duration, VIDEO_THUMBNAIL_SECONDS);
      } catch (error) {
        finish(null);
      }
    });
    video.addEventListener("seeked", () => finish(this.drawFrame(video)));
    video.addEventListener("error", () => finish(null));

    // A file that never fires either event would hold its slot for the rest of
    // the session, and two such files would stop the queue entirely.
    if (typeof window !== "undefined" && window.setTimeout) {
      job.timer = window.setTimeout(() => finish(null), VIDEO_THUMBNAIL_TIMEOUT_MS);
    }

    try {
      video.src = this.plugin.app.vault.getResourcePath(file);
      if (typeof video.load === "function") video.load();
    } catch (error) {
      finish(null);
    }
  }

  // The draw itself. Returns a URL for the frame, or null for anything that
  // did not work — a tainted canvas, a zero-sized video, a build without
  // toDataURL. One video that will not draw must not take down the folder.
  drawFrame(video) {
    try {
      const size = thumbnailCanvasSize(video.videoWidth, video.videoHeight, VIDEO_THUMBNAIL_MAX_EDGE);
      if (!size) return null;
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
      if (!context) return null;
      context.drawImage(video, 0, 0, size.width, size.height);
      // A data URL rather than a blob: toBlob is asynchronous and would need
      // the job to stay open across another turn, and at this size — a JPEG
      // 320px on its long edge — the string is a few tens of kilobytes. It
      // also needs no revoking, which removes the whole class of leak the
      // blob version would have to be careful about.
      return canvas.toDataURL("image/jpeg", 0.8);
    } catch (error) {
      reportFailure("plugin", "could not draw a frame for the grid", error);
      return null;
    }
  }

  // Put a finished frame into whatever tile is now showing that path. The tile
  // may have been recycled or scrolled away since the job started, which is
  // why nothing here assumes the tile it began with still exists.
  applyFrame(path, url) {
    this.settleFirstThumb(path);
    const tile = this.tiles.get(path);
    if (!tile) return;
    const frame = tile.querySelector(".mv-tile-frame");
    if (!frame) return;
    this.showFrame(tile, frame, path, url);
  }

  failFrame(path) {
    this.settleFirstThumb(path);
    this.frameFailures.add(path);
    const tile = this.tiles.get(path);
    if (!tile) return;
    tile.addClass("is-broken");
    const frame = tile.querySelector(".mv-tile-frame");
    if (frame) frame.removeClass("is-pending");
  }

  // Releasing the element is what stops the decode. Without it a cancelled job
  // carries on reading the file it was asked about and nothing is listening.
  endFrameJob(job) {
    this.frameJobs.delete(job.path);
    if (job.timer !== null && typeof window !== "undefined" && window.clearTimeout) {
      window.clearTimeout(job.timer);
      job.timer = null;
    }
    const video = job.video;
    if (!video) return;
    try {
      if (typeof video.pause === "function") video.pause();
      if (typeof video.removeAttribute === "function") video.removeAttribute("src");
      video.src = "";
      if (typeof video.load === "function") video.load();
    } catch (error) {
      reportFailure("plugin", "releasing a thumbnail decoder failed", error);
    }
  }

  // A tile that has gone withdraws its request. On a fast scroll through a
  // folder of videos most requests never start, which is the point.
  cancelFrameJob(path) {
    this.frameQueue = this.frameQueue.filter((entry) => entry.path !== path);
    const job = this.frameJobs.get(path);
    if (!job || job.done) return;
    job.done = true;
    this.endFrameJob(job);
    this.pumpFrameQueue();
  }

  cancelAllFrameJobs() {
    this.frameQueue = [];
    for (const job of Array.from(this.frameJobs.values())) {
      if (job.done) continue;
      job.done = true;
      this.endFrameJob(job);
    }
  }

  revokeFrame(path, url) {
    // Data URLs need no revoking; the branch is here so that swapping the
    // encode back to a blob is a one-line change rather than a leak.
    if (typeof url === "string" && url.startsWith("blob:") && typeof URL !== "undefined" && URL.revokeObjectURL) {
      URL.revokeObjectURL(url);
    }
  }

  revealSelection() {
    const tile = this.tiles.get(this.plugin.selectedPath);
    if (tile && typeof tile.scrollIntoView === "function") {
      tile.scrollIntoView({ block: "nearest" });
    }
  }

  /* ---------------------------------------------------------------------- *
   * The viewer surface.
   *
   * Zoom and pan live here rather than in `core` because they are state, but
   * every decision they make is a core function — which is what keeps the
   * geometry testable while the DOM stays thin.
   * ---------------------------------------------------------------------- */

  get stageSize() {
    const stage = this.stageEl;
    if (!stage) return { width: 0, height: 0 };
    return { width: stage.clientWidth || 0, height: stage.clientHeight || 0 };
  }

  // The displayed size of the image at the current zoom. Zero until something
  // has loaded, which every caller has to tolerate anyway — the pane can be
  // resized before the first decode finishes.
  get contentSize() {
    return {
      width: this.naturalWidth * this.zoom,
      height: this.naturalHeight * this.zoom,
    };
  }

  // Called whenever selection changes. Reloading the same path would throw
  // away the zoom and pan the user just set, so it is checked for.
  showInViewer(path) {
    if (path === this.viewerPath) return;
    // An unsaved edit belongs to the file it was started on. Selection moving
    // ends it — the alternative is a session quietly pointing at pixels that
    // are no longer on screen.
    this.discardSession();
    this.viewerPath = path;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.dragging = null;
    this.renderViewer();
  }

  renderViewer() {
    if (!this.stageEl) return;
    const path = this.viewerPath;

    // Before the stage is emptied: an element that has left the document can
    // no longer be paused through it.
    this.releaseVideo();
    this.stageEl.empty();
    this.stageEl.removeClass("is-broken");
    this.imageEl = null;
    this.editCanvasEl = null;
    this.editFrameEl = null;
    this.editStatusEl = null;
    if (this.overlay) {
      this.overlay.destroy();
      this.overlay = null;
    }

    if (this.viewerNameEl) this.viewerNameEl.setText(path ? baseNameOf(path) : "");

    if (!path) {
      this.stageEl.createDiv({ cls: "mv-stage-message", text: "Select a file to view it." });
      this.updateViewerBar();
      return;
    }

    const file = this.index.fileFor(path);
    if (!file) {
      this.stageEl.createDiv({ cls: "mv-stage-message", text: "This file is no longer in the folder." });
      this.updateViewerBar();
      return;
    }

    if (classifyPath(path) === "video") {
      this.renderVideo(path, file);
      return;
    }

    // An open session replaces the <img> with what the edit currently looks
    // like. Same stage, same pane, no second viewer.
    if (this.session && this.session.path === path) {
      this.renderEditSurface();
      return;
    }

    const img = document.createElement("img");
    img.className = "mv-image";
    img.alt = "";
    img.draggable = false;
    img.addEventListener("load", () => {
      this.naturalWidth = img.naturalWidth || 0;
      this.naturalHeight = img.naturalHeight || 0;
      // Open at fit, which for anything smaller than the pane is 100% —
      // fitZoom never magnifies.
      this.fitToPane();
    });
    img.addEventListener("error", () => {
      this.stageEl.empty();
      this.stageEl.addClass("is-broken");
      this.stageEl.createDiv({ cls: "mv-stage-message", text: "This image could not be decoded." });
      this.imageEl = null;
      this.updateViewerBar();
    });
    img.src = this.plugin.app.vault.getResourcePath(file);
    this.stageEl.appendChild(img);
    this.imageEl = img;
    this.applyTransform();
  }

  /* Video mode.
   *
   * The video is fitted by CSS rather than by the zoom maths: it has no decode
   * budget to work around and nothing to inspect at 400%, and pointing the pan
   * machinery at an element whose size the browser controls would mean two
   * things owning one layout. So naturalWidth stays zero here — which is also
   * what leaves wheel-zoom, panning and double-click-to-fit inert on a video
   * without any of them needing to know videos exist.
   */
  renderVideo(path, file) {
    const video = document.createElement("video");
    video.className = "mv-video";
    // No native controls: the transport below is the one that carries the
    // keyboard, the frame step and the readout, and two scrub bars disagreeing
    // about the position is worse than either alone.
    video.controls = false;
    video.preload = "metadata";
    video.playsInline = true;

    video.addEventListener("loadedmetadata", () => {
      if (this.videoEl !== video) return;
      this.videoWidth = video.videoWidth || 0;
      this.videoHeight = video.videoHeight || 0;
      // Again here: a rate set before the source loaded is reset by some
      // builds when it does.
      video.playbackRate = this.playbackRate;
      // A reload after a vault modify wants its position back; a fresh open
      // has nothing pending and starts at zero.
      if (this.pendingSeek !== null) {
        const at = this.pendingSeek;
        this.pendingSeek = null;
        video.currentTime = clampTime(at, video.duration);
      }
      this.updateVideoBar();
    });
    for (const type of ["durationchange", "timeupdate", "seeked", "play", "pause", "ended"]) {
      video.addEventListener(type, () => {
        if (this.videoEl === video) this.updateVideoBar();
      });
    }
    video.addEventListener("error", () => {
      if (this.videoEl !== video) return;
      this.showVideoError(path);
    });

    video.playbackRate = this.playbackRate;
    video.src = this.plugin.app.vault.getResourcePath(file);
    this.stageEl.appendChild(video);
    this.videoEl = video;
    this.setViewerMode("video");
    this.updateVideoBar();
    this.updateViewerBar();
  }

  // The element's error codes say almost nothing a user can act on, so the
  // message names the container instead — the part they can check. MV-ERRORS
  // refines this once the whole error table is built.
  showVideoError(path) {
    this.releaseVideo();
    this.stageEl.empty();
    this.stageEl.addClass("is-broken");
    const extension = extensionOf(path);
    this.stageEl.createDiv({
      cls: "mv-stage-message",
      text: extension
        ? "This video could not be played. The " + extension.toUpperCase() + " codec may be unsupported."
        : "This video could not be played.",
    });
    this.updateVideoBar();
    this.updateViewerBar();
  }

  // Which bar the viewer shows. Driven by class, so the layout stays in the
  // stylesheet and a test can ask which mode the pane is in.
  setViewerMode(mode) {
    if (!this.viewerEl) return;
    this.viewerEl.toggleClass("is-video", mode === "video");
    this.viewerEl.toggleClass("is-editing", mode === "edit");
  }

  // Detach the stream. Emptying the stage removes the element from the
  // document but leaves it decoding and, with audio, audible.
  // Note what this does not reset: playbackRate is the pane's, not the
  // element's, and outlives every video opened in it.
  releaseVideo() {
    const video = this.videoEl;
    this.videoEl = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.videoDuration = 0;
    this.scrubbing = false;
    this.pendingSeek = null;
    this.hoverPaused = false;
    this.setViewerMode("empty");
    if (!video) return;
    try {
      if (typeof video.pause === "function") video.pause();
      // Clearing src alone leaves the fetch running in some builds; load()
      // after it is what actually abandons the request.
      if (typeof video.removeAttribute === "function") video.removeAttribute("src");
      video.src = "";
      if (typeof video.load === "function") video.load();
    } catch (error) {
      reportFailure("plugin", "releasing the video failed", error);
    }
  }

  togglePlayback() {
    const video = this.videoEl;
    if (!video) return false;
    this.hoverPaused = false;
    if (video.paused) {
      const started = typeof video.play === "function" ? video.play() : null;
      // play() rejects when the browser refuses — a codec it turns out not to
      // decode, or an autoplay policy. Unhandled, that is an error in the
      // console and no visible change in the pane.
      if (started && typeof started.catch === "function") {
        started.catch((error) => {
          reportFailure("plugin", "playback failed", error);
          this.updateVideoBar();
        });
      }
    } else if (typeof video.pause === "function") {
      video.pause();
    }
    this.updateVideoBar();
    return true;
  }

  seekBy(seconds) {
    const video = this.videoEl;
    if (!video) return false;
    this.hoverPaused = false;
    video.currentTime = seekTime(video.currentTime, seconds, video.duration);
    this.updateVideoBar();
    return true;
  }

  // Stepping while playing would be overtaken by playback before the frame
  // could be looked at, so a step pauses first — which is also what every
  // editor's frame step does.
  stepFrame(frames) {
    const video = this.videoEl;
    if (!video) return false;
    if (!video.paused && typeof video.pause === "function") video.pause();
    video.currentTime = frameStepTime(video.currentTime, frames, video.duration, VIDEO_FRAME_SECONDS);
    this.updateVideoBar();
    return true;
  }

  // Set on the element, not just remembered: the element is what plays, and
  // the two disagreeing is a speed control that appears to do nothing.
  setPlaybackRate(rate) {
    this.playbackRate = nearestSpeed(rate);
    if (this.videoEl) this.videoEl.playbackRate = this.playbackRate;
    this.updateVideoBar();
    return this.playbackRate;
  }

  stepPlaybackRate(steps) {
    if (!this.videoEl) return false;
    this.setPlaybackRate(stepSpeed(this.playbackRate, steps));
    return true;
  }

  seekToScrub(position) {
    const video = this.videoEl;
    if (!video) return false;
    this.hoverPaused = false;
    const duration = Number(video.duration);
    // Dragging a bar that cannot know where it is would seek to zero on every
    // move; the bar is disabled in that state, and this is the second guard.
    if (!Number.isFinite(duration) || duration <= 0) return false;
    video.currentTime = timeFromScrub(position, duration, SCRUB_RESOLUTION);
    this.updateVideoBar();
    return true;
  }

  updateVideoBar() {
    if (!this.videoBarEl) return;
    const video = this.videoEl;
    const reported = video ? Number(video.duration) : NaN;
    const duration = Number.isFinite(reported) && reported > 0 ? reported : 0;
    this.videoDuration = duration;
    const time = video ? clampTime(video.currentTime, duration) : 0;
    const seekable = Boolean(video) && duration > 0;

    if (this.playEl) {
      this.playEl.setText(video && !video.paused ? "Pause" : "Play");
      this.playEl.disabled = !video;
    }
    if (this.stepBackEl) this.stepBackEl.disabled = !seekable;
    if (this.stepForwardEl) this.stepForwardEl.disabled = !seekable;
    if (this.scrubEl) {
      this.scrubEl.disabled = !seekable;
      // Not while a drag is in progress: writing the thumb back from the
      // element's position would fight the pointer holding it.
      if (!this.scrubbing) {
        this.scrubEl.value = String(scrubPositionFor(time, duration, SCRUB_RESOLUTION));
      }
    }
    if (this.timeEl) {
      const position = video ? formatTimecode(time) : "--:--";
      this.timeEl.setText(position + " / " + formatTimecode(duration > 0 ? duration : NaN));
    }
    if (this.speedEl) {
      this.speedEl.value = String(this.playbackRate);
      this.speedEl.disabled = !video;
    }
  }

  applyTransform() {
    if (this.imageEl && this.imageEl.style) {
      this.imageEl.style.width = this.naturalWidth ? this.naturalWidth * this.zoom + "px" : "";
      this.imageEl.style.height = this.naturalHeight ? this.naturalHeight * this.zoom + "px" : "";
      this.imageEl.style.transform = "translate(" + this.panX + "px, " + this.panY + "px)";
    }
    this.updateViewerBar();
  }

  updateViewerBar() {
    const video = Boolean(this.videoEl);
    if (this.zoomEl) {
      this.zoomEl.setText(!video && this.naturalWidth ? Math.round(this.zoom * 100) + "%" : "");
    }
    // Hidden by the stylesheet in video mode, and disabled as well: a control
    // still reachable by Tab that silently does nothing is worse than one that
    // says it cannot.
    if (this.fitEl) this.fitEl.disabled = video || Boolean(this.session);
    if (this.fullEl) this.fullEl.disabled = video || Boolean(this.session);
    if (this.prevEl) this.prevEl.disabled = !this.plugin.siblingOf(-1);
    if (this.nextEl) this.nextEl.disabled = !this.plugin.siblingOf(1);
    if (this.editEl) {
      const editable = !video && Boolean(this.viewerPath) && classifyPath(this.viewerPath) === "image";
      this.editEl.disabled = !editable || Boolean(this.editLoading);
      this.editEl.setText(this.session ? "Done" : "Edit");
      this.editEl.toggleClass("is-active", Boolean(this.session));
    }
    // The two bars describe one state, so they are refreshed together. Every
    // path that changes what the viewer holds already comes through here.
    this.updateEditBar();
  }

  // Every zoom goes through here, so the clamp and the pan correction are
  // applied in exactly one place. `cursor` is measured from the stage centre;
  // omitting it zooms about the centre, which is what the keyboard wants.
  setZoom(nextZoom, cursor) {
    const previous = this.zoom;
    const zoom = clampZoom(nextZoom);
    if (zoom === previous) return false;
    const at = cursor || { x: 0, y: 0 };
    this.zoom = zoom;
    this.panX = panAfterZoom(this.panX, at.x, previous, zoom);
    this.panY = panAfterZoom(this.panY, at.y, previous, zoom);
    this.clampPanToBounds();
    this.applyTransform();
    return true;
  }

  clampPanToBounds() {
    const stage = this.stageSize;
    const content = this.contentSize;
    this.panX = clampPan(this.panX, content.width, stage.width);
    this.panY = clampPan(this.panY, content.height, stage.height);
  }

  fitToPane() {
    const stage = this.stageSize;
    this.zoom = fitZoom(this.naturalWidth, this.naturalHeight, stage.width, stage.height);
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
  }

  zoomToActualSize() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
  }

  // Fit and 100% are the same thing for an image that already fits, so the
  // toggle would do nothing; going to 200% instead keeps the gesture useful.
  toggleFit() {
    if (!this.naturalWidth) return;
    const stage = this.stageSize;
    const fit = fitZoom(this.naturalWidth, this.naturalHeight, stage.width, stage.height);
    if (Math.abs(this.zoom - fit) < 1e-6) {
      this.setZoom(fit < 1 ? 1 : 2);
      return;
    }
    this.fitToPane();
  }

  handleWheel(event) {
    // On a video the wheel is a jog wheel, not a zoom: scrolling down runs
    // forward through the file, the direction a timeline reads. Stepping is
    // deliberate, so it ends the peek and the frame stays put when the pointer
    // leaves.
    if (this.videoEl) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      this.hoverPaused = false;
      this.stepFrame(event.deltaY > 0 ? 1 : -1);
      return;
    }
    if (!this.imageEl || !this.naturalWidth) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    this.setZoom(stepZoom(this.zoom, direction, ZOOM_WHEEL_RATIO), this.cursorFrom(event));
  }

  // Pointer coordinates arrive relative to the viewport; the pan maths works
  // from the stage centre, so this is where the two meet.
  cursorFrom(event) {
    const stage = this.stageEl;
    if (!stage || typeof stage.getBoundingClientRect !== "function") return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    return {
      x: (event.clientX || 0) - (rect.left + rect.width / 2),
      y: (event.clientY || 0) - (rect.top + rect.height / 2),
    };
  }

  /* Hover to hold, scroll to step.
   *
   * Moving the pointer onto a playing video pauses it, and moving away starts
   * it again: a peek, not a stop. That reversal is what makes pausing on hover
   * safe — without it, crossing the pane on the way to something else would
   * silently halt playback and leave the user to work out why.
   *
   * Anything deliberate cancels the peek, so the video stays where it was put:
   * the wheel, the transport, Space, a seek. The rule is that the pointer may
   * only undo what the pointer did. */
  handlePointerEnter() {
    const video = this.videoEl;
    if (!video || video.paused) return;
    if (typeof video.pause === "function") video.pause();
    this.hoverPaused = true;
    this.updateVideoBar();
  }

  handlePointerLeave() {
    if (!this.hoverPaused) return;
    this.hoverPaused = false;
    const video = this.videoEl;
    if (!video || !video.paused) return;
    const started = typeof video.play === "function" ? video.play() : null;
    if (started && typeof started.catch === "function") {
      started.catch((error) => {
        reportFailure("plugin", "resuming after a hover failed", error);
        this.updateVideoBar();
      });
    }
    this.updateVideoBar();
  }

  handlePointerDown(event) {
    if (!this.imageEl || !this.naturalWidth) return;
    const stage = this.stageSize;
    const content = this.contentSize;
    // Nothing to pan when the whole image already fits: starting a drag that
    // cannot move anything just puts the cursor in the wrong shape.
    if (panLimit(content.width, stage.width) === 0 && panLimit(content.height, stage.height) === 0) {
      return;
    }
    this.dragging = {
      pointerId: event.pointerId,
      startX: event.clientX || 0,
      startY: event.clientY || 0,
      panX: this.panX,
      panY: this.panY,
    };
    this.stageEl.addClass("is-panning");
    if (typeof this.stageEl.setPointerCapture === "function" && event.pointerId !== undefined) {
      // Capture, so a drag that leaves the pane still ends on this element
      // rather than sticking in the panning state.
      this.stageEl.setPointerCapture(event.pointerId);
    }
  }

  handlePointerMove(event) {
    const drag = this.dragging;
    if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    this.panX = drag.panX + ((event.clientX || 0) - drag.startX);
    this.panY = drag.panY + ((event.clientY || 0) - drag.startY);
    this.clampPanToBounds();
    this.applyTransform();
  }

  handlePointerUp(event) {
    const drag = this.dragging;
    if (!drag) return;
    if (event && event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    this.dragging = null;
    this.stageEl.removeClass("is-panning");
    if (this.stageEl && typeof this.stageEl.releasePointerCapture === "function" && drag.pointerId !== undefined) {
      this.stageEl.releasePointerCapture(drag.pointerId);
    }
  }

  // W/S zoom, A/D step siblings. Modified presses are left alone so the pane
  // does not eat Ctrl+S or a Cmd+A the user meant for something else.
  handleKey(event) {
    /* Edit mode is asked first, and before the modifier guard, because Ctrl+Z
       there means this edit: the pane has focus and holds nothing else that
       could be undone. Everything it does not claim falls through to the
       ordinary keys, so A and D still step siblings while a session is open. */
    if (this.session && this.handleEditKey(event)) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      return true;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const key = String(event.key || "").toLowerCase();
    // The video keys are asked first and fall through to the shared ones, so
    // A and D still step siblings in both modes.
    if (this.videoEl && this.handleVideoKey(key)) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      return true;
    }
    let handled = true;
    if (key === "w") this.setZoom(stepZoom(this.zoom, 1, ZOOM_KEY_RATIO));
    else if (key === "s") this.setZoom(stepZoom(this.zoom, -1, ZOOM_KEY_RATIO));
    else if (key === "a") this.plugin.selectSibling(-1);
    else if (key === "d") this.plugin.selectSibling(1);
    else if (key === "0") this.zoomToActualSize();
    else if (key === "f") this.fitToPane();
    else handled = false;
    if (handled && typeof event.preventDefault === "function") event.preventDefault();
    return handled;
  }

  /* In video mode W and S seek rather than zoom: it is the same gesture doing
     the same job — move through the thing being looked at — which is why the
     pair is reused instead of a second set of keys being invented. Space plays
     and pauses, comma and full stop step a frame, the pair every editor uses.

     Returning false rather than swallowing an unknown key is what lets Space
     scroll normally when the viewer holds an image. */
  handleVideoKey(key) {
    if (key === " " || key === "spacebar") return this.togglePlayback();
    if (key === "w") return this.seekBy(VIDEO_SEEK_SECONDS);
    if (key === "s") return this.seekBy(-VIDEO_SEEK_SECONDS);
    if (key === ",") return this.stepFrame(-1);
    if (key === ".") return this.stepFrame(1);
    // The same two physical keys with shift, which is where every video site
    // puts speed — and it reads correctly: a frame is a small step, a speed
    // change is the large one on the same lever.
    if (key === "<") return this.stepPlaybackRate(-1);
    if (key === ">") return this.stepPlaybackRate(1);
    return false;
  }

  /* Paste an image into the folder the pane is showing.
   *
   * Only images are claimed. A paste carrying text, or nothing this plugin can
   * name, is left alone entirely — no preventDefault — so pasting a path or a
   * link into the pane still does whatever it would have done.
   */
  handlePaste(event) {
    const items = this.imagesFrom(event);
    if (!items.length) return false;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (this.index.folder === null) {
      new Notice("Media Viewer: open a folder before pasting into it");
      return false;
    }
    // Deliberately not awaited: a paste handler that returns a promise still
    // has to have called preventDefault synchronously, and the writes report
    // themselves.
    this.plugin.writePastedImages(items);
    return true;
  }

  // Images on a clipboard event, as {blob, mime}. Both shapes are read because
  // Electron populates `items` and `files` differently depending on where the
  // copy came from, and a screenshot tool is exactly the case that only fills
  // one of them.
  imagesFrom(event) {
    const data = event && event.clipboardData;
    if (!data) return [];
    const found = [];
    const seen = new Set();
    const consider = (blob, type) => {
      const mime = type || (blob && blob.type) || "";
      if (!blob || !extensionForMime(mime)) return;
      // The same image can appear in both collections; a paste must not write
      // it twice.
      const key = mime + ":" + (blob.size === undefined ? "" : blob.size);
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ blob, mime });
    };
    const items = data.items || [];
    for (const item of items) {
      if (!item || item.kind !== "file") continue;
      consider(typeof item.getAsFile === "function" ? item.getAsFile() : null, item.type);
    }
    const files = data.files || [];
    for (const entry of files) consider(entry, entry && entry.type);
    return found;
  }

  // The displayed file was written to underneath the viewer. Re-read it, but
  // keep the zoom and pan: the user is looking at a particular part of a
  // particular image, and an edit saved elsewhere should not move their view.
  reloadViewer(path) {
    if (!path || path !== this.viewerPath) return;
    const file = this.index.fileFor(path);
    if (!file) return;
    if (this.videoEl) {
      // Re-reading a video restarts it at zero, so the position is carried
      // across and re-applied when the new metadata arrives — the same reason
      // the image path keeps its zoom.
      this.pendingSeek = clampTime(this.videoEl.currentTime, this.videoEl.duration);
      this.videoEl.src = this.plugin.app.vault.getResourcePath(file);
      if (typeof this.videoEl.load === "function") this.videoEl.load();
      return;
    }
    if (!this.imageEl) return;
    this.imageEl.src = this.plugin.app.vault.getResourcePath(file);
  }

  /* ---------------------------------------------------------------------- *
   * Edit mode.
   *
   * Cropping happens on the viewer in place. The old app opened a
   * CropImageDialog — a second copy of the viewer with its own scroll area and
   * its own zoom controls, about 260 lines of duplication, whose selection
   * could not be adjusted once drawn. What replaces it is a mode this pane is
   * in: the same stage, showing a canvas instead of an <img>.
   * ---------------------------------------------------------------------- */

  toggleEdit() {
    if (this.session) {
      this.endEdit();
      return Promise.resolve(false);
    }
    return this.startEdit();
  }

  /* Open a session on the displayed image.
   *
   * This is where the decode budget is spent and, for a large enough file,
   * refused. Refusing names the dimensions: "too big" with no number is
   * something the user cannot act on, and freezing the pane instead is what
   * the budget exists to prevent.
   */
  async startEdit() {
    const path = this.viewerPath;
    if (!path || classifyPath(path) !== "image") return false;
    if (this.session) return true;
    // A second click while the first decode is in flight joins it rather than
    // starting another. Two full-resolution decodes of the same file is
    // exactly the shape of stall this task is about.
    if (this.editLoading) return this.editLoading;
    const file = this.index.fileFor(path);
    if (!file) return false;

    this.editLoading = this.openSession(path, file).finally(() => {
      this.editLoading = null;
      // The bar was drawn while the decode was in flight, which is what
      // disabled the button. A refusal has to give it back, or one oversized
      // file leaves Edit dead for the rest of the session.
      this.updateViewerBar();
    });
    this.updateViewerBar();
    return this.editLoading;
  }

  async openSession(path, file) {
    const started = Date.now();
    let source;
    try {
      source = await loadEditSource(this.plugin.app.vault.getResourcePath(file), {
        maxMegapixels: MAX_DECODE_MEGAPIXELS,
        maxEdge: MAX_DISPLAY_EDGE,
      });
    } catch (error) {
      if (error && error.name === "DecodeBudgetError") {
        new Notice("Media Viewer: " + baseNameOf(path) + " is " + error.message.replace(/^\d+ x \d+ is /, ""));
        console.warn("Media Viewer: refused to decode " + path + " — " + error.message);
      } else {
        reportFailure("plugin", "could not decode " + path + " for editing", error);
        new Notice("Media Viewer: " + baseNameOf(path) + " could not be decoded for editing");
      }
      this.updateViewerBar();
      return false;
    }
    // The user can step to another file while a large decode is running. The
    // pixels are still correct, but they are no longer the pixels on screen.
    if (this.viewerPath !== path) return false;

    this.session = new EditSession({
      path,
      image: source.image,
      width: source.width,
      height: source.height,
      preview: source.preview,
    });
    this.session.onChange = () => this.refreshEdit();
    this.plugin.logTiming("decode", path, started);
    this.renderViewer();
    return true;
  }

  endEdit() {
    if (!this.session) return false;
    this.discardSession();
    this.renderViewer();
    return true;
  }

  // Drops the session without redrawing, for the callers that are about to
  // redraw anyway. Held apart so that "forget the edit" and "show something
  // else" stay two decisions rather than one tangled one.
  discardSession() {
    if (!this.session) return false;
    this.session.onChange = null;
    this.session = null;
    this.editCanvasEl = null;
    this.editFrameEl = null;
    this.editStatusEl = null;
    if (this.overlay) {
      this.overlay.destroy();
      this.overlay = null;
    }
    return true;
  }

  /* The edit surface: a frame wrapped tightly around the canvas, with the
     selection overlay filling it.

     The frame exists so that "the overlay" and "the picture" are the same box.
     Without it the canvas is a centred flex item and the overlay would have to
     compute its offset from the stage — arithmetic that is correct until the
     pane is resized. */
  renderEditSurface() {
    const session = this.session;
    if (!session || !this.stageEl) return;
    this.setViewerMode("edit");
    const frame = this.stageEl.createDiv({ cls: "mv-edit-frame" });
    this.editFrameEl = frame;
    const canvas = document.createElement("canvas");
    canvas.className = "mv-edit-canvas";
    frame.appendChild(canvas);
    this.editCanvasEl = canvas;
    this.buildOverlay(frame);
    this.editStatusEl = this.stageEl.createDiv({ cls: "mv-edit-status" });
    this.paintEdit();
    this.updateViewerBar();
  }

  // Re-draw after a state change. Separate from renderEditSurface so that
  // undo, a rotation or a new crop costs one repaint rather than a rebuilt
  // stage — and so the overlay MV-OVERLAY hangs off the canvas survives.
  refreshEdit() {
    this.paintEdit();
    this.updateViewerBar();
  }

  paintEdit() {
    const session = this.session;
    if (!session || !this.editCanvasEl) return;
    try {
      session.renderPreviewTo(this.editCanvasEl, MAX_DISPLAY_EDGE);
    } catch (error) {
      reportFailure("plugin", "drawing the edit preview failed", error);
      return;
    }
    if (this.editStatusEl) this.editStatusEl.setText(this.editSummary());
  }

  // What the edit currently amounts to, in one line: the output dimensions,
  // and the transform if there is one. The dimensions are the number a crop is
  // actually judged by.
  editSummary() {
    const session = this.session;
    if (!session) return "";
    const size = session.outputSize;
    const parts = [size.width + " x " + size.height];
    if (session.state.rotate) parts.push(session.state.rotate + "°");
    if (session.state.flipH) parts.push("flip H");
    if (session.state.flipV) parts.push("flip V");
    if (session.preview.scale !== 1) {
      parts.push("preview at " + Math.round(session.preview.scale * 100) + "%");
    }
    return parts.join(" · ");
  }

  // CSS pixels per oriented-source pixel, measured off what was actually laid
  // out. The zoom and the proxy factor multiply, and a missed factor in a crop
  // is invisible until the output is opened.
  get editDisplayScale() {
    const session = this.session;
    const canvas = this.editCanvasEl;
    if (!session || !canvas) return 1;
    const crop = session.crop;
    const rendered = canvas.clientWidth || 0;
    // The canvas holds the crop, not the whole oriented image, so the scale is
    // measured against what it is actually showing.
    return displayScaleFor(rendered, crop.w);
  }

  /* The edit toolbar.
   *
   * Built once and hidden by class, the same way the transport is: a bar
   * created when a session opens would lose the aspect ratio the user chose
   * every time they stepped to the next file, and rebuilding controls is how a
   * dropdown loses its value without anyone deciding it should.
   */
  buildEditBar(parent) {
    const bar = parent.createDiv({ cls: "mv-edit-bar" });
    this.editBarEl = bar;

    this.cropEl = this.barButton(bar, "Crop", () => this.applyCrop());
    this.cropEl.title = "Crop to the selection (Enter)";

    const aspect = bar.createEl("select", {
      cls: "dropdown mv-aspect",
      attr: { "aria-label": "Crop aspect ratio" },
    });
    for (const [label, ratio] of CROP_ASPECTS) {
      aspect.createEl("option", { value: ratio === null ? "" : String(ratio), text: label });
    }
    aspect.addEventListener("change", () => this.setAspect(aspect.value));
    this.aspectEl = aspect;

    bar.createDiv({ cls: "mv-edit-sep" });

    this.rotateLeftEl = this.barButton(bar, "⟲", () => this.rotateEdit(-90));
    this.rotateLeftEl.setAttribute("aria-label", "Rotate anticlockwise");
    this.rotateLeftEl.title = "Rotate 90° anticlockwise ([)";
    this.rotateRightEl = this.barButton(bar, "⟳", () => this.rotateEdit(90));
    this.rotateRightEl.setAttribute("aria-label", "Rotate clockwise");
    this.rotateRightEl.title = "Rotate 90° clockwise (] or R)";
    this.flipHEl = this.barButton(bar, "Flip H", () => this.flipEdit("h"));
    this.flipHEl.title = "Flip horizontally (H)";
    this.flipVEl = this.barButton(bar, "Flip V", () => this.flipEdit("v"));
    this.flipVEl.title = "Flip vertically (V)";

    bar.createDiv({ cls: "mv-edit-sep" });

    /* Size. Two linked inputs and a scale, because the two are asked for in
       different ways: "1920 wide" is a dimension and "half" is a factor, and
       turning one into the other before it is stored loses which was meant. */
    this.widthEl = this.sizeInput(bar, "Output width");
    bar.createDiv({ cls: "mv-edit-times", text: "×" });
    this.heightEl = this.sizeInput(bar, "Output height");
    this.widthEl.addEventListener("change", () => this.resizeEdit("width"));
    this.heightEl.addEventListener("change", () => this.resizeEdit("height"));
    this.sizeLinked = true;
    this.linkEl = this.barButton(bar, "🔗", () => this.toggleSizeLink());
    this.linkEl.setAttribute("aria-label", "Keep the aspect ratio");
    this.linkEl.title = "Keep the aspect ratio when resizing";

    const scale = bar.createEl("select", {
      cls: "dropdown mv-scale",
      attr: { "aria-label": "Resize by scale" },
    });
    for (const factor of RESIZE_SCALES) {
      scale.createEl("option", { value: String(factor), text: Math.round(factor * 100) + "%" });
    }
    scale.value = "1";
    scale.addEventListener("change", () => this.scaleEdit(scale.value));
    this.scaleEl = scale;

    bar.createDiv({ cls: "mv-edit-sep" });

    this.undoEl = this.barButton(bar, "Undo", () => this.undoEdit());
    this.undoEl.title = "Undo (Ctrl+Z)";
    this.redoEl = this.barButton(bar, "Redo", () => this.redoEdit());
    this.redoEl.title = "Redo (Ctrl+Shift+Z)";
    this.saveEl = this.barButton(bar, "Save", () => this.saveEdit());
    this.saveEl.addClass("mv-save");
    this.saveEl.title = "Write the edit to a new file beside the source (Ctrl+S)";

    this.resetEl = this.barButton(bar, "Reset", () => this.resetEdit());
    this.resetEl.title = "Undo every change in this session, in one undoable step";

    this.updateEditBar();
  }

  /* Where the selection lives.
   *
   * The overlay is created with the surface and destroyed with it, because it
   * is positioned against a canvas whose size changes with every crop and
   * rotation. What survives a rebuild is the aspect ratio, which belongs to
   * the user rather than to the picture.
   */
  buildOverlay(frame) {
    this.overlay = new CropOverlay(frame, {
      bounds: () => this.editSurfaceSize,
      label: (rect) => this.selectionLabel(rect),
      onChange: () => this.updateEditBar(),
    });
    if (this.aspectEl) this.overlay.setAspect(this.aspectEl.value);
  }

  // The canvas's laid-out box, which is what the selection is drawn in. Falls
  // back to the canvas's own pixel size before the first layout, so a
  // selection made in that window is at worst mis-scaled rather than NaN.
  get editSurfaceSize() {
    const canvas = this.editCanvasEl;
    if (!canvas) return { width: 0, height: 0 };
    return {
      width: canvas.clientWidth || canvas.width || 0,
      height: canvas.clientHeight || canvas.height || 0,
    };
  }

  /* The live readout, in source pixels — which is the only unit a crop is
     actually judged in. Shown as it would be cut, floor/ceil and all, so the
     number on screen is the number in the file. */
  selectionLabel(rect) {
    const crop = this.selectionCrop(rect);
    if (!crop) return "";
    return crop.w + " x " + crop.h;
  }

  /* A selection, as an absolute rectangle in oriented-source pixels.
   *
   * Two conversions, and both are easy to forget. The canvas shows the current
   * crop rather than the whole image, so the display scale is measured against
   * the crop; and the result is relative to that crop, so it is offset by it.
   * Returns null when the selection resolves to nothing worth cutting.
   */
  selectionCrop(rect) {
    const session = this.session;
    const selection = rect === undefined ? this.overlay && this.overlay.selection : rect;
    if (!session || !selection) return null;
    const crop = session.crop;
    const size = this.editSurfaceSize;
    const scale = displayScaleFor(size.width, crop.w);
    const within = cropFromSelection(selection, scale, crop.w, crop.h);
    if (!within) return null;
    return cropWithinCrop(crop, within);
  }

  applyCrop() {
    const session = this.session;
    if (!session) return false;
    const crop = this.selectionCrop();
    if (!crop) {
      new Notice("Media Viewer: drag a selection first");
      return false;
    }
    if (!session.setCrop(crop)) return false;
    // The canvas now shows the crop, so the selection that produced it would
    // be a rectangle over the whole picture. Clearing it is what makes a
    // second crop of the crop start from nothing.
    if (this.overlay) this.overlay.clear();
    return true;
  }

  /* The chosen ratio lives on the dropdown, which is also where the overlay
     reads it from when it is rebuilt — so this writes back to the control even
     when it was the control that called. A ratio held in two places is a ratio
     that will disagree with itself the first time an overlay is rebuilt. */
  setAspect(value) {
    const ratio = Number(value);
    const locked = Number.isFinite(ratio) && ratio > 0 ? ratio : null;
    if (this.aspectEl) this.aspectEl.value = locked === null ? "" : String(locked);
    if (this.overlay) this.overlay.setAspect(locked);
    this.updateEditBar();
    return true;
  }

  undoEdit() {
    if (!this.session || !this.session.undo()) return false;
    if (this.overlay) this.overlay.clear();
    return true;
  }

  redoEdit() {
    if (!this.session || !this.session.redo()) return false;
    if (this.overlay) this.overlay.clear();
    return true;
  }

  resetEdit() {
    if (!this.session || !this.session.reset()) return false;
    if (this.overlay) this.overlay.clear();
    return true;
  }

  sizeInput(parent, label) {
    return parent.createEl("input", {
      cls: "mv-size-input",
      attr: { type: "number", min: "1", step: "1", "aria-label": label },
    });
  }

  /* Rotation and flips.
   *
   * Every one of these is one call into the session, because the session is
   * where the crop gets carried through the change. A button that rotated the
   * canvas and left the stored rectangle behind is the bug MV-CROPMATH's
   * conjugation rule exists to prevent, and the way to keep it prevented is to
   * have exactly one place that knows about it.
   */
  rotateEdit(delta) {
    if (!this.session || !this.session.rotateBy(delta)) return false;
    // The picture has turned, so a selection drawn on the old orientation now
    // covers something else. Clearing is the honest answer; carrying it would
    // mean a second rectangle to keep correct for no gain.
    if (this.overlay) this.overlay.clear();
    return true;
  }

  flipEdit(axis) {
    if (!this.session || !this.session.toggleFlip(axis)) return false;
    if (this.overlay) this.overlay.clear();
    return true;
  }

  /* Resize by dimensions.
   *
   * The two inputs are linked by default, because a resize that quietly
   * changes the aspect ratio is almost never what was meant — and unlinking is
   * one click for the times it is. The ratio is the crop's, not the input's,
   * so it stays stable while the user types.
   */
  resizeEdit(axis) {
    const session = this.session;
    if (!session) return false;
    const crop = session.crop;
    const ratio = crop.h > 0 ? crop.w / crop.h : 1;
    let width = Math.round(Number(this.widthEl && this.widthEl.value));
    let height = Math.round(Number(this.heightEl && this.heightEl.value));
    if (this.sizeLinked) {
      if (axis === "width") height = Math.max(1, Math.round(width / ratio));
      else width = Math.max(1, Math.round(height * ratio));
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      // Put the numbers back rather than leaving a half-typed value that the
      // readout disagrees with.
      this.updateEditBar();
      return false;
    }
    const size = session.outputSize;
    if (width === size.width && height === size.height) {
      this.updateEditBar();
      return false;
    }
    session.setResize(width, height);
    return true;
  }

  // A scale is relative to the crop, so it keeps meaning something after the
  // crop changes — which is why it is stored as a factor rather than being
  // multiplied out into dimensions the moment it is chosen.
  scaleEdit(value) {
    const session = this.session;
    if (!session) return false;
    const factor = Number(value);
    if (!Number.isFinite(factor) || factor <= 0) return false;
    if (factor === 1) return session.clearResize();
    return session.setScale(factor);
  }

  toggleSizeLink() {
    this.sizeLinked = !this.sizeLinked;
    this.updateEditBar();
    return this.sizeLinked;
  }

  /* Save the edit as a new file beside the source.
   *
   * The source is never written to, which is what makes every edit in this
   * plugin non-destructive in the only sense that matters: the file you
   * started from is still there afterwards.
   *
   * Nothing here rescans. The index inserts by path and the selection is a
   * path, so the grid keeps its scroll position and the new file simply
   * appears in it — which is the whole reason selection was never an index.
   *
   * Both failure paths leave the session open. A crop that took a minute to
   * place and cannot be written is not work to throw away because the disk was
   * full.
   */
  async saveEdit() {
    const session = this.session;
    if (!session) return null;
    if (this.saving) return this.saving;
    this.saving = this.writeEdit(session).finally(() => {
      this.saving = null;
      this.updateViewerBar();
    });
    this.updateViewerBar();
    return this.saving;
  }

  async writeEdit(session) {
    const started = Date.now();
    let encoded;
    try {
      encoded = await session.encode({ quality: this.settings.encodeQuality });
    } catch (error) {
      reportFailure("plugin", "encoding " + session.path + " failed", error);
      new Notice("Media Viewer: this edit could not be encoded — the session is still open");
      return null;
    }
    this.plugin.logTiming("encode", session.path, started, "bytes=" + encoded.bytes.byteLength);

    const written = Date.now();
    const path = clonePathFor(session.path, (candidate) => this.plugin.pathExists(candidate));
    let created;
    try {
      created = await this.plugin.app.vault.createBinary(path, encoded.bytes);
    } catch (error) {
      reportFailure("plugin", "could not write " + path, error);
      new Notice("Media Viewer: could not write " + baseNameOf(path) + " — the session is still open");
      return null;
    }
    this.plugin.logTiming("save", path, written);

    /* Inserted here rather than left to the vault's create event, because the
       order of that event against createBinary's promise is not something to
       depend on — and selecting a path the index has not heard of does
       nothing. Insertion is idempotent by path, which is what makes doing it
       in both places safe. */
    if (created) this.index.handleCreate(created);
    await this.plugin.afterEditSaved(session, path, created);

    new Notice("Saved " + baseNameOf(path));
    /* Selection follows to the new file, and a fresh session opens on it. The
       previous history is discarded deliberately: undo applies to unsaved
       state, and an undo that could step back past a file already written
       would be an undo that has to decide whether to delete it. */
    this.plugin.select(path);
    await this.startEdit();
    return path;
  }

  updateEditBar() {
    const session = this.session;
    if (this.cropEl) this.cropEl.disabled = !session || !this.selectionCrop();
    if (this.undoEl) this.undoEl.disabled = !session || !session.canUndo;
    if (this.redoEl) this.redoEl.disabled = !session || !session.canRedo;
    if (this.resetEl) this.resetEl.disabled = !session || !session.dirty;
    // Offered only for an edit that would change something: saving an
    // untouched image is a copy, which is a thing to ask for rather than a
    // thing to do by pressing the obvious button.
    if (this.saveEl) this.saveEl.disabled = !session || !session.dirty || Boolean(this.saving);
    for (const button of [this.rotateLeftEl, this.rotateRightEl, this.flipHEl, this.flipVEl]) {
      if (button) button.disabled = !session;
    }
    if (this.flipHEl) this.flipHEl.toggleClass("is-active", Boolean(session && session.state.flipH));
    if (this.flipVEl) this.flipVEl.toggleClass("is-active", Boolean(session && session.state.flipV));
    if (this.linkEl) {
      this.linkEl.disabled = !session;
      this.linkEl.toggleClass("is-active", Boolean(this.sizeLinked));
    }
    // The inputs are a readout as much as a control: they show what the file
    // will measure, which changes with every crop and quarter turn as well as
    // with typing into them.
    const size = session ? session.outputSize : { width: "", height: "" };
    for (const [input, value] of [[this.widthEl, size.width], [this.heightEl, size.height]]) {
      if (!input) continue;
      input.disabled = !session;
      input.value = String(value);
    }
    if (this.scaleEl) {
      this.scaleEl.disabled = !session;
      const resize = session && session.state.resize;
      // An absolute resize is not one of the offered factors, so the dropdown
      // shows 100% rather than pretending the typed size was a percentage.
      this.scaleEl.value = resize && resize.scale !== undefined ? String(resize.scale) : "1";
    }
  }

  /* Edit-mode keys.
   *
   * Asked before the shared ones and before the modifier guard, because Ctrl+Z
   * in edit mode means this edit — the pane has focus and there is nothing
   * else in it to undo. Escape steps back one level at a time: the selection
   * first, the session second, which is what makes it safe to press.
   */
  handleEditKey(event) {
    const key = String(event.key || "").toLowerCase();
    if (event.ctrlKey || event.metaKey) {
      if (key === "z") return event.shiftKey ? this.redoEdit() : this.undoEdit();
      if (key === "y") return this.redoEdit();
      // Claimed only in edit mode, where the pane has focus and there is
      // something unsaved in it. Everywhere else Ctrl+S is Obsidian's.
      if (key === "s") {
        void this.saveEdit();
        return true;
      }
      return false;
    }
    if (event.altKey) return false;
    if (key === "escape") {
      if (this.overlay && this.overlay.clear()) return true;
      return this.endEdit();
    }
    if (key === "enter") return this.applyCrop();
    /* The transform keys. Brackets turn, because that is where every editor
       puts rotation; R is the same thing under the finger that is already
       thinking the word. H and V are claimed only in edit mode, so they mean
       nothing to the browsing pane. */
    if (key === "[") return this.rotateEdit(-90);
    if (key === "]" || key === "r") return this.rotateEdit(90);
    if (key === "h") return this.flipEdit("h");
    if (key === "v") return this.flipEdit("v");
    return false;
  }

  /* ---------------------------------------------------------------------- *
   * The lineage panel — MV-PANEL.
   *
   * Three questions, answered in one place: where did this come from, what
   * came from it, and which of the values shown are actually this file's.
   *
   * That third one is the reason the panel exists at all. Resolved values are
   * never written to disk — a child note read on its own is deliberately not
   * self-describing — so without somewhere that says "16:9, from cover.png",
   * inheritance is a mechanism nobody can check.
   * ---------------------------------------------------------------------- */

  buildLineage(parent) {
    const panel = parent.createDiv({ cls: "mv-lineage" });
    this.lineageEl = panel;

    const header = panel.createDiv({ cls: "mv-lineage-header" });
    this.lineageToggleEl = header.createEl("button", {
      cls: "mv-lineage-toggle",
      text: "Lineage",
      attr: { type: "button", "aria-expanded": "true" },
    });
    this.lineageToggleEl.addEventListener("click", () => this.toggleLineage());

    this.lineageBodyEl = panel.createDiv({ cls: "mv-lineage-body" });
    this.renderLineage();
  }

  toggleLineage() {
    this.lineageOpen = this.lineageOpen === false;
    if (this.lineageEl) this.lineageEl.toggleClass("is-collapsed", !this.lineageOpen);
    if (this.lineageToggleEl) {
      this.lineageToggleEl.setAttribute("aria-expanded", this.lineageOpen ? "true" : "false");
    }
    return this.lineageOpen;
  }

  renderLineage() {
    return guarded("drawing the lineage panel for", this.plugin.selectedPath, () =>
      this.renderLineageUnguarded()
    );
  }

  renderLineageUnguarded() {
    const body = this.lineageBodyEl;
    if (!body) return;
    body.empty();
    const path = this.plugin.selectedPath;
    if (!path) {
      body.createDiv({ cls: "mv-lineage-empty", text: "Select a file to see its lineage." });
      return;
    }

    const store = this.plugin.lineage;
    const record = store.recordFor(path);

    if (!record) {
      /* Untracked is a normal state, not a fault: most of a vault has never
         been edited. The panel says what the file is missing and offers the
         one action that would give it one. */
      const empty = body.createDiv({ cls: "mv-lineage-empty" });
      empty.setText("No lineage note. Nothing has been done to this file yet.");
      const actions = body.createDiv({ cls: "mv-lineage-actions" });
      const mark = actions.createEl("button", {
        cls: "mv-lineage-action",
        text: "Mark as reviewed",
        attr: { type: "button" },
      });
      mark.addEventListener("click", () => this.plugin.markReviewed(path));
      /* The other reason a file can be sitting here: a save whose binary was
         written and whose note was not. The pane cannot tell that case from an
         untouched file — both are "no note" — so it offers the repair rather
         than guessing which one this is. */
      const repair = actions.createEl("button", {
        cls: "mv-lineage-action",
        text: "Repair lineage",
        attr: { type: "button", title: "Use this if the file was saved but its note was not written" },
      });
      repair.addEventListener("click", () => this.plugin.repairLineage(path));
      return;
    }

    const walk = this.plugin.resolver.walk(path);
    const problem = chainProblemMessage(walk, path);
    if (problem) {
      // Surfaced as well as logged. A cycle that only reached the console is a
      // cycle nobody knows about.
      body.createDiv({ cls: "mv-lineage-problem", text: problem });
    }

    this.lineageChain(body, path, record, walk);
    this.lineageChildren(body, path);
    this.lineageFields(body, path);
  }

  /* The chain above this file, nearest first. Every entry is a jump, because a
     lineage you can see and not follow is half a feature. */
  lineageChain(body, path, record, walk) {
    const section = body.createDiv({ cls: "mv-lineage-section" });
    section.createDiv({ cls: "mv-lineage-label", text: "From" });
    const chain = walk.chain.slice(1);
    if (!chain.length) {
      const line = section.createDiv({ cls: "mv-lineage-row is-root" });
      line.setText(record.sourceLink ? "Missing: " + record.sourceLink : "Nothing — this is a root.");
      if (record.sourceLink) line.addClass("is-broken");
      return;
    }
    for (const step of chain) {
      this.lineageLink(section, step.path, step.record ? null : "untracked");
    }
  }

  lineageChildren(body, path) {
    const children = this.plugin.lineage.childrenOf(path);
    const section = body.createDiv({ cls: "mv-lineage-section" });
    section.createDiv({
      cls: "mv-lineage-label",
      text: children.length === 1 ? "1 derived file" : children.length + " derived files",
    });
    if (!children.length) {
      section.createDiv({ cls: "mv-lineage-row is-root", text: "Nothing has been made from this yet." });
      return;
    }
    for (const child of children) this.lineageLink(section, child, null);
  }

  // One navigable entry. Named by its file rather than its path, with the path
  // in the tooltip: the grid is a folder of files and the name is what the
  // user is looking at.
  lineageLink(section, path, note) {
    const row = section.createDiv({ cls: "mv-lineage-row" });
    const link = row.createEl("button", {
      cls: "mv-lineage-link",
      text: baseNameOf(path),
      attr: { type: "button", title: path },
    });
    link.addEventListener("click", () => this.plugin.revealMedia(path));
    if (note) row.createSpan({ cls: "mv-lineage-note", text: note });
    return row;
  }

  /* What this file's metadata resolves to, and from where.
   *
   * "own" against a value means this note declares it; anything else names the
   * ancestor it came from, which is what makes an inherited value checkable
   * rather than merely present.
   */
  lineageFields(body, path) {
    const started = Date.now();
    const { fields } = this.plugin.resolver.resolveAll(path);
    this.plugin.logTiming("resolution", path, started, "fields=" + Object.keys(fields).length);
    const names = Object.keys(fields).sort((a, b) => {
      const order = INSTANCE_FIELD_ORDER.indexOf(a) - INSTANCE_FIELD_ORDER.indexOf(b);
      if (INSTANCE_FIELD_ORDER.includes(a) && INSTANCE_FIELD_ORDER.includes(b)) return order;
      if (INSTANCE_FIELD_ORDER.includes(a)) return -1;
      if (INSTANCE_FIELD_ORDER.includes(b)) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const section = body.createDiv({ cls: "mv-lineage-section" });
    section.createDiv({ cls: "mv-lineage-label", text: "Metadata" });
    if (!names.length) {
      section.createDiv({ cls: "mv-lineage-row is-root", text: "This note declares nothing." });
      return;
    }
    const table = section.createDiv({ cls: "mv-lineage-fields" });
    for (const name of names) {
      const entry = fields[name];
      const row = table.createDiv({ cls: "mv-lineage-field" });
      row.toggleClass("is-inherited", entry.inherited);
      row.createSpan({ cls: "mv-lineage-key", text: name });
      row.createSpan({ cls: "mv-lineage-value", text: formatFieldValue(name, entry.value) });
      const from = row.createSpan({
        cls: "mv-lineage-from",
        text: entry.inherited ? baseNameOf(entry.from) : "own",
      });
      if (entry.inherited) from.title = "Inherited from " + entry.from;
    }
  }

  // The pane can be resized while an image is open, which changes what "fit"
  // means and can leave the pan outside its new bounds.
  handleResize() {
    if (!this.naturalWidth) return;
    this.clampPanToBounds();
    this.applyTransform();
  }
}

/* ------------------------------------------------------------------------ *
 * Settings — MV-SETTINGS.
 *
 * Four things worth a setting and no more. Everything the pane's own header
 * already controls — the folder, the filter, the recursion toggle — lives
 * there because that is where it is used; repeating it here would be two
 * places to change one thing.
 *
 * What is left is what the header has nowhere to put: a number that only
 * matters at save time, a switch that decides whether this plugin writes to
 * the vault at all, where it writes when it does, and the diagnostics toggle.
 * ------------------------------------------------------------------------ */

class MediaViewerSettingTab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Browsing").setHeading();

    new Setting(containerEl)
      .setName("Include subfolders")
      .setDesc(
        "Scan the whole subtree rather than one folder. The pane's own toggle changes this too; it is here so it survives being set once and forgotten."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.recursive).onChange((value) => {
          this.plugin.setRecursive(value);
        })
      );

    new Setting(containerEl)
      .setName("Follow the active file")
      .setDesc(
        "Show the folder of whatever media file is open. Choosing a folder from its context menu turns this off, because otherwise the next click would silently undo the choice."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.followActiveFile).onChange((value) => {
          this.plugin.setFollowActiveFile(value);
        })
      );

    new Setting(containerEl).setName("Saving").setHeading();

    new Setting(containerEl)
      .setName("JPEG and WebP quality")
      .setDesc(
        "What a lossy output is encoded at. PNG ignores it. The output format follows the source, so this only ever applies to a file that was already lossy."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 1, 0.01)
          .setValue(clampQuality(this.plugin.settings.encodeQuality))
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.encodeQuality = clampQuality(value);
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Lineage").setHeading();

    new Setting(containerEl)
      .setName("Write lineage notes")
      .setDesc(
        "Record where each saved file came from, as a MediaInstance note. Turning this off leaves the plugin browsing and editing as before, and writing nothing but the files you save."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.writeLineage).onChange((value) => {
          this.plugin.settings.writeLineage = Boolean(value);
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Folder for new lineage notes")
      .setDesc(
        "Where a new note is written. Only ever that: notes are found by the media: link they declare, so one moved out of this folder afterwards keeps working."
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_NOTE_FOLDER)
          .setValue(this.plugin.settings.noteFolder)
          .onChange((value) => {
            /* Trimmed, and repeated separators collapsed: a path typed with a
               stray space, a doubled slash or a trailing one names the same
               folder, and storing three spellings of it would eventually put
               three folders in the vault. */
            const folder = normaliseSeparators(String(value || "").trim())
              .replace(/\/{2,}/g, "/")
              .replace(/^\/+|\/+$/g, "");
            this.plugin.settings.noteFolder = folder || DEFAULT_NOTE_FOLDER;
            this.plugin.lineage.noteFolder = this.plugin.settings.noteFolder;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Report lineage breaks")
      .setDesc(
        "List every note whose media: or source: names a file the vault does not hold, and every chain that loops or runs too deep. It changes nothing."
      )
      .addButton((button) =>
        button.setButtonText("Check the vault").onClick(() => {
          this.plugin.showLineageBreaks();
        })
      );

    new Setting(containerEl).setName("Diagnostics").setHeading();

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc(
        "Write ms= timings to the developer console for scans, thumbnails, decodes, encodes, saves and lineage resolution. Nothing is written to disk: the console already filters, persists and survives the failure."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLogging).onChange((value) => {
          this.plugin.settings.debugLogging = Boolean(value);
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Crash log")
      .setDesc(
        "Record failures to .obsidian/plugins/media-viewer/crash.log so they can be handed over without reproducing them in the developer console. Only failures, never tracing — this is the one that stays on."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.crashLog !== false).onChange((value) => {
          this.plugin.settings.crashLog = Boolean(value);
          if (this.plugin.crashLog) this.plugin.crashLog.enabled = Boolean(value);
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Crash log actions")
      .setDesc("Copy what has been recorded this session, or start it over.")
      .addButton((button) =>
        button.setButtonText("Copy").onClick(() => {
          void this.plugin.copyCrashLog();
        })
      )
      .addButton((button) =>
        button.setButtonText("Clear").onClick(() => {
          void this.plugin.clearCrashLog();
        })
      );
  }
}

class MediaViewerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    /* First, so that anything failing during the rest of load is recorded
       rather than lost. A plugin that cannot report its own startup failure is
       the hardest kind to get a bug report about. */
    this.crashLog = new CrashLog(this.app, {
      enabled: this.settings.crashLog !== false,
      onNotice: () => new Notice("Media Viewer hit an error — see the crash log"),
    });
    setCrashLog(this.crashLog);
    this.registerCrashHandlers();

    // Selection is a path, never an index. This is the decision that lets a
    // save keep the scroll position and the highlight it started with.
    this.selectedPath = null;

    /* Lineage. Built once the vault has finished indexing — before then
       metadataCache holds a fraction of the notes and the maps would be
       quietly wrong rather than visibly empty. */
    this.lineage = new LineageStore(this.app, {
      noteFolder: this.settings.noteFolder || DEFAULT_NOTE_FOLDER,
      onChange: () => this.refreshLineageViews(),
    });

    this.resolver = new MetadataResolver(this.lineage);

    this.index = new MediaIndex(this.app.vault);
    this.index.recursive = this.settings.recursive;
    this.index.onChange = (reason, path, oldPath) => this.handleIndexChange(reason, path, oldPath);

    this.registerView(VIEW_TYPE_MEDIA_VIEWER, (leaf) => new MediaViewerView(leaf, this));

    this.addSettingTab(new MediaViewerSettingTab(this.app, this));

    this.addRibbonIcon("image", "Open Media Viewer", () => this.activateView());

    this.addCommand({
      id: "open-media-viewer",
      name: "Open Media Viewer",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "repair-lineage",
      name: "Repair lineage",
      callback: () => this.repairLineage(),
    });

    this.addCommand({
      id: "lineage-breaks",
      name: "Report lineage breaks",
      callback: () => this.showLineageBreaks(),
    });

    this.addCommand({
      id: "mark-reviewed",
      name: "Mark as reviewed",
      callback: () => this.markReviewed(),
    });

    this.addCommand({
      id: "paste-image-into-folder",
      name: "Paste image into the current folder",
      callback: () => this.pasteFromClipboard(),
    });

    this.addCommand({
      id: "copy-crash-log",
      name: "Copy crash log",
      callback: () => this.copyCrashLog(),
    });

    this.addCommand({
      id: "clear-crash-log",
      name: "Clear crash log",
      callback: () => this.clearCrashLog(),
    });

    // Registered on the vault rather than inside the view, so the index stays
    // correct while the pane is closed and does not need a rescan on reopen.
    // Each handler is a map lookup that misses for most of the vault.
    /* Guarded, because these run inside Obsidian's own event dispatch: a
       throw here does not just lose this plugin's handling, it can stop the
       handlers registered after it from being called at all. */
    this.registerEvent(
      this.app.vault.on("create", (file) =>
        guarded("handling create of", file && file.path, () => this.index.handleCreate(file))
      )
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) =>
        guarded("handling modify of", file && file.path, () => this.index.handleModify(file))
      )
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) =>
        guarded("handling delete of", file && file.path, () => this.index.handleDelete(file))
      )
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        guarded("handling rename of", oldPath, () => this.index.handleRename(file, oldPath))
      )
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.followActiveFile(file))
    );

    // Obsidian's file explorer already is the folder tree the desktop app
    // hand-built, so the plugin adds one item to it rather than a widget.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, target) => {
        const folder = this.folderPathForMenuTarget(target);
        if (folder === null) return;
        menu.addItem((item) => {
          item
            .setTitle("Open in Media Viewer")
            .setIcon("image")
            .onClick(async () => {
              await this.activateView();
              this.pinFolder(folder);
            });
        });
      })
    );

    // The last folder is restored, but only once the vault has finished
    // indexing: scanning before then finds a fraction of the files and the
    // pane opens looking empty.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, data, cache) =>
        guarded("handling metadata for", file && file.path, () =>
          this.lineage.handleMetadataChange(file, data, cache)
        )
      )
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) =>
        guarded("handling lineage delete of", file && file.path, () => this.lineage.handleDelete(file))
      )
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.handleLineageRename(file, oldPath))
    );

    this.app.workspace.onLayoutReady(() => {
      const started = Date.now();
      const found = this.lineage.build();
      this.logTiming("lineage-build", found + " notes", started);
      if (this.settings.lastFolder !== null) {
        const scanned = Date.now();
        this.index.setFolder(this.settings.lastFolder, this.settings.recursive);
        this.logTiming("scan", this.index.folder, scanned, "files=" + this.index.size);
      }
      this.followActiveFile(this.app.workspace.getActiveFile());
    });
  }

  /* ---------------------------------------------------------------------- *
   * Renames — MV-RENAME.
   *
   * The first act is a map lookup, and for most of a vault it misses. Renaming
   * or moving a media file with no note does nothing at all: no scan, no
   * rewrite, no work. Handling is proportional to what has actually been
   * edited, not to vault size.
   *
   * Beyond that there is one case to handle, and it is not the obvious one.
   * Because `media:` and `source:` are wikilinks in frontmatter, Obsidian's own
   * link updating rewrites them when a media file moves and the notes stay
   * correct with no work from this plugin at all. What is left is the user who
   * has turned that setting off — the only case where a rename makes this
   * plugin write.
   *
   * Children are never renamed. Rename cover.png to hero.png and
   * cover+clone+260908110422.png keeps its name; only the links change.
   * Cascading would turn one operation into many that can each fail partway,
   * and would break every inbound link to a child.
   * ---------------------------------------------------------------------- */

  async handleLineageRename(file, oldPath) {
    if (!file || !file.path) return false;
    // The lookup that misses. Three map reads, no I/O, and for an untracked
    // file this is the whole of the handling.
    const tracked =
      this.lineage.isTracked(oldPath) ||
      this.lineage.bySource.has(oldPath) ||
      this.lineage.records.has(oldPath);
    // The maps move either way: a note renamed by hand is not a tracked media
    // file, and still has to keep working.
    this.lineage.handleRename(file, oldPath);
    if (!tracked) return false;
    if (!isMediaPath(file.path)) return false;
    if (this.linkUpdatingEnabled()) {
      // Obsidian has already rewritten both links. Re-reading the maps is the
      // whole response; writing again would be a second, redundant edit to
      // every note in the cascade.
      this.debug("rename: " + oldPath + " → " + file.path + ", link updating on, nothing to write");
      return false;
    }
    return this.rewriteLineageLinks(file.path, oldPath);
  }

  /* Obsidian's own "Automatically update internal links".
   *
   * Read rather than assumed, and read as `=== true`, because the platform's
   * default when the key has never been set is off — assuming it on would mean
   * silently doing nothing in exactly the vault that needs the work.
   */
  linkUpdatingEnabled() {
    const vault = this.app.vault;
    if (!vault || typeof vault.getConfig !== "function") return false;
    try {
      return vault.getConfig("alwaysUpdateLinks") === true;
    } catch (error) {
      reportFailure("plugin", "could not read the link-updating setting", error);
      return false;
    }
  }

  /* Rewrite `media:` on the file's own note and `source:` on every child.
   *
   * Every rewrite is logged. This is the operation with the widest blast
   * radius and the least visible failure mode — a cascade that fails partway
   * leaves lineage half-rewritten, and the vault API offers no way to make it
   * atomic — so the mitigation is that the console says exactly what was
   * touched, and Repair lineage exists for what was not.
   */
  async rewriteLineageLinks(newPath, oldPath) {
    const started = Date.now();
    const rewritten = [];
    const failed = [];

    const own = this.lineage.recordFor(newPath);
    if (own) {
      try {
        await this.lineage.write(newPath, {});
        rewritten.push(own.notePath);
        console.log("Media Viewer: rewrote media: in " + own.notePath + " → " + newPath);
      } catch (error) {
        failed.push(own.notePath);
        reportFailure("plugin", "could not rewrite media: in " + own.notePath, error);
      }
    }

    for (const childPath of this.lineage.childrenOf(newPath)) {
      const child = this.lineage.recordFor(childPath);
      if (!child) continue;
      try {
        await this.lineage.write(childPath, { source: wikilinkFor(newPath) });
        rewritten.push(child.notePath);
        console.log("Media Viewer: rewrote source: in " + child.notePath + " → " + newPath);
      } catch (error) {
        failed.push(child.notePath);
        reportFailure("plugin", "could not rewrite source: in " + child.notePath, error);
      }
    }

    this.logTiming("rename-cascade", oldPath + " → " + newPath, started, "links=" + rewritten.length);
    if (failed.length) {
      new Notice(
        "Media Viewer: " +
          failed.length +
          " lineage note" +
          (failed.length === 1 ? "" : "s") +
          " could not be updated — use Repair lineage"
      );
    }
    return rewritten;
  }

  refreshLineageViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_VIEWER)) {
      const view = leaf.view;
      if (!(view instanceof MediaViewerView)) continue;
      guarded("refreshing a lineage panel", this.selectedPath, () => view.renderLineage());
    }
  }

  /* The buffered entries are the ones most worth keeping — a plugin being
     disabled right after a failure is a plugin someone is disabling because of
     it. dispose() flushes rather than dropping the timer. */
  async onunload() {
    if (this.crashLog) await this.crashLog.dispose();
    setCrashLog(null);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  /* Timings, behind the debug setting — MV-TIMING.
   *
   * Called with the millisecond the operation started, because the alternative
   * — a start/stop pair — is two calls that can get separated by an early
   * return and then report a number that is not a duration at all.
   *
   * Guarded by the setting rather than by a level, so that reverse playback
   * logging every animation frame costs one boolean read when it is off.
   */
  logTiming(operation, subject, startedAt, extra) {
    if (!this.settings || !this.settings.debugLogging) return false;
    const elapsed = Math.round(Date.now() - Number(startedAt));
    const tail = extra ? " " + extra : "";
    console.log("Media Viewer: " + operation + " ms=" + elapsed + " " + (subject || "") + tail);
    return true;
  }

  debug(message) {
    if (!this.settings || !this.settings.debugLogging) return false;
    console.log("Media Viewer: " + message);
    return true;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // A file-menu target is a TFile or a TFolder. A media file offers its own
  // folder, so the item is reachable from a file as well as from the folder
  // itself; anything else offers nothing.
  folderPathForMenuTarget(target) {
    if (target instanceof TFolder) return target.path === "/" ? "" : target.path;
    if (target instanceof TFile) return folderForActiveFile(target.path);
    return null;
  }

  followActiveFile(file) {
    if (!this.settings.followActiveFile) return;
    const folder = folderForActiveFile(file && file.path);
    if (folder === null) return;
    this.showFolder(folder);
  }

  // Choosing a folder explicitly pins the pane to it. Without this the next
  // click in the file explorer would silently undo the choice, which makes the
  // context-menu item feel broken rather than merely overridden.
  pinFolder(folder) {
    if (this.settings.followActiveFile) {
      this.settings.followActiveFile = false;
      void this.saveSettings();
    }
    this.showFolder(folder);
  }

  showFolder(folder) {
    if (this.index.folder === folder) return;
    this.selectedPath = null;
    const started = Date.now();
    this.index.setFolder(folder, this.settings.recursive);
    this.logTiming("scan", this.index.folder, started, "files=" + this.index.size);
    this.settings.lastFolder = this.index.folder;
    void this.saveSettings();
    this.refreshViews();
  }

  /* Jump to a media file that may not be in the folder the pane is showing.
   *
   * The lineage panel links across folders — a crop lives beside its source,
   * but a source may not live beside its own parent — so following one has to
   * be able to change what the grid is looking at. Selection is a path, so it
   * survives that change rather than being invalidated by it. */
  revealMedia(path) {
    if (!path) return false;
    if (!this.index.has(path)) {
      const folder = folderOf(path);
      this.index.setFolder(folder, this.settings.recursive);
      this.settings.lastFolder = this.index.folder;
      void this.saveSettings();
    }
    if (!this.index.has(path)) {
      new Notice("Media Viewer: " + baseNameOf(path) + " is not in the vault any more");
      return false;
    }
    this.selectedPath = path;
    this.refreshViews();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_VIEWER)) {
      if (leaf.view instanceof MediaViewerView) leaf.view.revealSelection();
    }
    return true;
  }

  select(path) {
    if (path !== null && !this.index.has(path)) return false;
    if (this.selectedPath === path) return false;
    this.selectedPath = path;
    this.refreshViews();
    return true;
  }

  // What A and D would land on, without moving. The viewer bar uses it to
  // disable its buttons at the ends of the list.
  siblingOf(delta) {
    return siblingPath(this.visiblePaths(), this.selectedPath, delta);
  }

  // Stepping walks the filtered list, not the whole index: with the grid
  // showing images only, D should reach the next image rather than stopping
  // on a video the user cannot see.
  selectSibling(delta) {
    const next = this.siblingOf(delta);
    if (next === null) return false;
    if (!this.select(next)) return false;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_VIEWER)) {
      if (leaf.view instanceof MediaViewerView) leaf.view.revealSelection();
    }
    return true;
  }

  /* Index changes reach selection here rather than in the view, so the answer
   * is the same however many panes are open. */
  handleIndexChange(reason, path, detail) {
    if (reason === "scan") {
      // A rescan can drop the selected file — a recursion toggle, say.
      if (this.selectedPath !== null && !this.index.has(this.selectedPath)) this.selectedPath = null;
    } else if (reason === "delete" && path === this.selectedPath) {
      // The file went out from under the viewer, so selection moves to the
      // neighbour the index picked out before it dropped the entry.
      this.selectedPath = detail;
    } else if (reason === "rename" && detail === this.selectedPath) {
      // Selection follows the file, not the name. A rename through Asset
      // Renamer should not clear the highlight.
      this.selectedPath = this.index.has(path) ? path : null;
    }
    this.refreshViews(reason, path);
  }

  setRecursive(recursive) {
    this.settings.recursive = Boolean(recursive);
    void this.saveSettings();
    const started = Date.now();
    this.index.setRecursive(this.settings.recursive);
    this.logTiming("scan", this.index.folder, started, "files=" + this.index.size);
    this.refreshViews();
  }

  setFilter(filter) {
    this.settings.filter = filter === "image" || filter === "video" ? filter : "both";
    void this.saveSettings();
    this.refreshViews();
  }

  setFollowActiveFile(follow) {
    this.settings.followActiveFile = Boolean(follow);
    void this.saveSettings();
    if (this.settings.followActiveFile) this.followActiveFile(this.app.workspace.getActiveFile());
    this.refreshViews();
  }

  // The filter is a view concern, not an index one: switching between images
  // and videos should not cost a rescan of the folder.
  visiblePaths() {
    const filter = this.settings.filter;
    if (filter === "both") return this.index.paths;
    return this.index.paths.filter((path) => matchesFilter(path, filter));
  }

  refreshViews(reason, path) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA_VIEWER)) {
      const view = leaf.view;
      if (!(view instanceof MediaViewerView)) continue;
      // A modify changes no membership, only pixels, so the grid is left alone
      // and one thumbnail is re-read.
      guarded("refreshing a pane for", path, () => {
        if (reason === "modify") {
          view.reloadThumbnail(path);
          view.reloadViewer(path);
        } else {
          view.render();
        }
      });
    }
  }

  // Reuse an existing pane rather than stacking duplicates; a second ribbon
  // click should reveal the pane already open, not open another.
  /* Write pasted images into the pane's folder.
   *
   * Each becomes its own file, because a clipboard carrying two images is two
   * images. Failures are per-file: one that will not write must not stop the
   * next, which is the same rule the grid follows for one bad file.
   */
  async writePastedImages(items) {
    const folder = this.index.folder;
    if (folder === null) return [];
    const written = [];
    for (const item of items) {
      const path = await this.writePastedImage(folder, item);
      if (path) written.push(path);
    }
    if (written.length === 1) new Notice("Pasted " + baseNameOf(written[0]));
    else if (written.length > 1) new Notice("Pasted " + written.length + " images into " + folderLabelFor(folder));
    return written;
  }

  async writePastedImage(folder, item) {
    const extension = extensionForMime(item && item.mime);
    if (!extension || !item.blob) return null;
    const path = pastePathFor(folder, extension, (candidate) => this.pathExists(candidate));
let created = null;
    try {
      const bytes = await item.blob.arrayBuffer();
      created = await this.app.vault.createBinary(path, bytes);
    } catch (error) {
      reportFailure("plugin", "could not write a pasted image to " + path, error);
      new Notice("Media Viewer: could not write the pasted image");
      return null;
    }
    // Inserted here rather than left to the vault's create event, because the
    // order of that event against createBinary's promise is not something to
    // depend on — and selecting a path the index has not heard of yet does
    // nothing. Insertion is idempotent by path, which is exactly what makes
    // doing it in both places safe.
    if (created) this.index.handleCreate(created);
    // Moving the selection is what makes the paste visible rather than merely
    // successful.
    this.select(path);
    return path;
  }

  /* ---------------------------------------------------------------------- *
   * Writing lineage — MV-TRACK.
   *
   * Notes are created when you **act** on a file, never when you merely look
   * at one. That is what makes the presence of a note the signal that a file
   * has been dealt with, and the absence of one the mark of everything still
   * untouched — a set difference over data already in memory, needing no index
   * of its own.
   *
   * So: opening, viewing, zooming and playing write nothing at all. A save
   * writes two notes, because a crop is a derivation and a derivation has two
   * ends.
   * ---------------------------------------------------------------------- */

  /* Called by the save path once the derived file exists.
   *
   * One crop produces two notes: the child, with its full provenance, and a
   * root note for the source — because you did open that file and act on it,
   * so it has been reviewed, and because the root is what gives the child
   * something to inherit from.
   *
   * Failures here do not undo the save. The binary is on disk and is the
   * user's work; a note that could not be written is what **Repair lineage**
   * is for, and the pane says so rather than pretending the save failed.
   */
  async afterEditSaved(session, path, file) {
    if (!this.settings.writeLineage) return null;
    const started = Date.now();
    const sourcePath = session.path;
    try {
      await this.ensureRootNote(sourcePath, {
        width: session.sourceWidth,
        height: session.sourceHeight,
      });
    } catch (error) {
      reportFailure("plugin", "could not write the root note for " + sourcePath, error);
      new Notice("Media Viewer: " + baseNameOf(sourcePath) + " could not be tracked");
    }
    const shape = session.describe();
    try {
      const written = await this.lineage.write(path, {
        source: wikilinkFor(sourcePath),
        op: shape.crop ? "crop" : "transform",
        crop: shape.crop,
        transform: shape.transform,
        width: shape.width,
        height: shape.height,
        created: isoTimestamp(new Date()),
        status: STATUS_EDITED,
        labels: [],
      });
      this.logTiming("lineage-write", path, started);
      return written;
    } catch (error) {
      reportFailure("plugin", "could not write the lineage note for " + path, error);
      new Notice(
        "Media Viewer: " + baseNameOf(path) + " was saved but not tracked — use Repair lineage"
      );
      return null;
    }
  }

  /* A root note: `media:`, no `source:`, and nothing claimed about how it was
     made. Written only when there is not one already — a file that already has
     a note has already been dealt with, and overwriting its status would
     silently undo whatever the user set it to. */
  async ensureRootNote(mediaPath, extra) {
    if (!mediaPath) return null;
    if (this.lineage.isTracked(mediaPath)) return this.lineage.noteFileFor(mediaPath);
    const fields = Object.assign(
      {
        created: isoTimestamp(new Date()),
        status: STATUS_REVIEWED,
        labels: [],
      },
      extra || {}
    );
    return this.lineage.write(mediaPath, fields);
  }

  /* Mark as reviewed.
   *
   * This exists because otherwise a file that is already correct could never
   * leave the unreviewed list: the list would shrink only by editing files
   * that needed no editing.
   *
   * "Reviewed" here means exactly one thing — this plugin has written
   * something about the file. It cannot tell a considered decision from an
   * accidental crop, and does not pretend to; `status:` is where any finer
   * meaning lives.
   */
  async markReviewed(path) {
    const target = path || this.selectedPath || this.activeMediaPath();
    if (!target) {
      new Notice("Media Viewer: select a media file to mark it reviewed");
      return null;
    }
    if (!isMediaPath(target)) {
      new Notice("Media Viewer: " + baseNameOf(target) + " is not a media file");
      return null;
    }
    if (this.lineage.isTracked(target)) {
      new Notice("Media Viewer: " + baseNameOf(target) + " already has a lineage note");
      return this.lineage.noteFileFor(target);
    }
    try {
      const file = await this.ensureRootNote(target, {});
      new Notice("Marked " + baseNameOf(target) + " reviewed");
      return file;
    } catch (error) {
      reportFailure("plugin", "could not mark " + target + " reviewed", error);
      new Notice("Media Viewer: could not write a note for " + baseNameOf(target));
      return null;
    }
  }

  /* ---------------------------------------------------------------------- *
   * Repair and reporting — MV-REPAIR.
   *
   * Two operations that look alike and are not. Repair writes; the report only
   * ever reads. The line between them is the design's rule: a dangling
   * `source:` is reported and never silently fixed, because the file it names
   * may simply be arriving from the other end of a sync, and a guess written
   * into a record is indistinguishable from a fact.
   * ---------------------------------------------------------------------- */

  /* Repair the lineage of one file.
   *
   * The case this exists for is a save whose binary was written and whose note
   * was not — the file survives, untracked, and needs a record. What it writes
   * is a root note, and it says so: by the time anyone asks, the session that
   * knew what the file was cut from is gone, and the only other place that
   * information could come from is the filename, which is precisely the
   * mechanism this design retired.
   */
  async repairLineage(path) {
    const target = path || this.selectedPath || this.activeMediaPath();
    if (!target) {
      new Notice("Media Viewer: select a media file to repair its lineage");
      return null;
    }
    if (!isMediaPath(target)) {
      new Notice("Media Viewer: " + baseNameOf(target) + " is not a media file");
      return null;
    }

    const record = this.lineage.recordFor(target);
    if (record) {
      const walk = this.resolver.walk(target);
      const problem = chainProblemMessage(walk, target);
      if (!problem) {
        new Notice("Media Viewer: " + baseNameOf(target) + " is tracked and its chain is whole");
        return this.lineage.noteFileFor(target);
      }
      // Reported, not repaired. Guessing at a parent writes a claim nobody can
      // tell from a fact.
      new Notice("Media Viewer: " + problem + " Nothing was changed.");
      console.warn("Media Viewer: repair found a break at " + target + " — " + problem);
      return null;
    }

    try {
      const file = await this.ensureRootNote(target, {});
      new Notice(
        "Media Viewer: wrote a root note for " +
          baseNameOf(target) +
          ". What it was derived from could not be recovered."
      );
      return file;
    } catch (error) {
      reportFailure("plugin", "could not repair the lineage of " + target, error);
      new Notice("Media Viewer: could not write a note for " + baseNameOf(target));
      return null;
    }
  }

  /* Every break in the vault, as data.
   *
   * Two kinds from the store — a `media:` or a `source:` naming a file that is
   * not here — plus the two the walk finds, which need a walk to find: a cycle
   * and a chain past the hop cap. Sorted so the report reads the same twice.
   */
  lineageBreakReport() {
    const started = Date.now();
    const found = this.lineage.breaks().map((entry) =>
      Object.assign({}, entry, {
        message:
          entry.kind === "media"
            ? "media: names " + entry.link + ", which is not in the vault"
            : "source: names " + entry.link + ", which is not in the vault",
      })
    );

    // A cycle is a property of the walk rather than of any one note, so it is
    // reported once against the file it was found from.
    const seen = new Set();
    for (const mediaPath of this.lineage.byMedia.keys()) {
      const walk = walkChain(mediaPath, (path) => this.lineage.recordFor(path), CHAIN_HOP_LIMIT);
      if (walk.stopped === CHAIN_END || walk.stopped === CHAIN_MISSING) continue;
      const key = walk.chain.map((step) => step.path).sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        kind: walk.stopped,
        notePath: this.lineage.byMedia.get(mediaPath),
        mediaPath,
        link: null,
        message: chainProblemMessage(walk, mediaPath),
      });
    }

    this.logTiming("lineage-report", found.length + " breaks", started);
    return found;
  }

  showLineageBreaks() {
    const breaks = this.lineageBreakReport();
    for (const entry of breaks) {
      console.warn("Media Viewer: " + (entry.notePath || entry.mediaPath) + " — " + entry.message);
    }
    if (!breaks.length) {
      new Notice("Media Viewer: no lineage breaks");
      return breaks;
    }
    new LineageBreakModal(this.app, this, breaks).open();
    return breaks;
  }

  // The media file the workspace has open, if it has one. Lets the command
  // work from the file explorer as well as from the pane.
  activeMediaPath() {
    const file = this.app.workspace.getActiveFile();
    const path = file && file.path;
    return path && isMediaPath(path) ? path : null;
  }

  pathExists(path) {
    const vault = this.app.vault;
    if (vault && typeof vault.getAbstractFileByPath === "function") {
      return vault.getAbstractFileByPath(path) !== null && vault.getAbstractFileByPath(path) !== undefined;
    }
    return this.index.fileFor(path) !== null && this.index.fileFor(path) !== undefined;
  }

  /* Paste from the command palette, where there is no clipboard event to read.
   *
   * navigator.clipboard.read() needs the window focused and can be refused
   * outright, so this is the second way in rather than the only one: Ctrl+V on
   * the pane goes through the event, which is both more reliable and what
   * anyone will actually press. */
  async pasteFromClipboard() {
    if (this.index.folder === null) {
      new Notice("Media Viewer: open a folder before pasting into it");
      return [];
    }
    const clipboard = typeof navigator !== "undefined" && navigator.clipboard;
    if (!clipboard || typeof clipboard.read !== "function") {
      new Notice("Media Viewer: this build cannot read the clipboard directly — press Ctrl+V on the pane");
      return [];
    }
    let contents = [];
    try {
      contents = await clipboard.read();
    } catch (error) {
      reportFailure("plugin", "reading the clipboard failed", error);
      new Notice("Media Viewer: could not read the clipboard");
      return [];
    }
    const items = [];
    for (const entry of contents) {
      const mime = (entry.types || []).find((type) => extensionForMime(type));
      if (!mime) continue;
      try {
        items.push({ blob: await entry.getType(mime), mime });
      } catch (error) {
        reportFailure("plugin", "could not read a clipboard image", error);
      }
    }
    if (!items.length) {
      new Notice("Media Viewer: no image on the clipboard");
      return [];
    }
    return this.writePastedImages(items);
  }

  /* Window-level failures.
   *
   * The guarded paths catch what this plugin calls directly; these catch what
   * it schedules — a callback from an image decode, a rejected promise nobody
   * awaited. Registered through registerDomEvent so Obsidian removes them on
   * unload rather than leaving a dead plugin listening.
   *
   * Errors from other plugins land here too. They are kept, but marked: during
   * a testing session "something threw while I was using the media pane" is
   * worth having even when the something was not us.
   */
  registerCrashHandlers() {
    if (typeof window === "undefined" || !this.registerDomEvent) return;
    this.registerDomEvent(window, "error", (event) => {
      const error = event && (event.error || event.message);
      this.recordWindowFailure("window.error", error, event && event.filename);
    });
    this.registerDomEvent(window, "unhandledrejection", (event) => {
      this.recordWindowFailure("unhandled rejection", event && event.reason, null);
    });
  }

  recordWindowFailure(scope, error, filename) {
    if (!this.crashLog) return;
    const text = errorText(error) + " " + (filename || "");
    const ours = text.indexOf("media-viewer") !== -1;
    this.crashLog.record(scope, ours ? "in Media Viewer" : "elsewhere in Obsidian", error);
  }

  async clearCrashLog() {
    if (!this.crashLog) return false;
    const cleared = await this.crashLog.clear();
    new Notice(cleared ? "Media Viewer: crash log cleared" : "Media Viewer: could not clear the crash log");
    return cleared;
  }

  async openCrashLog() {
    const path = this.crashLog ? this.crashLog.path : CRASH_LOG_PATH;
    if (this.crashLog) await this.crashLog.flush();
    const adapter = this.app.vault.adapter;
    const exists = adapter && typeof adapter.exists === "function" ? await adapter.exists(path) : false;
    if (!exists) {
      new Notice("Media Viewer: nothing has been logged yet");
      return false;
    }
    // Opened outside the vault's file list, because .obsidian is not a folder
    // Obsidian will open a file from — so the text goes to the clipboard and
    // the path is named, which is what a bug report needs anyway.
    return this.copyCrashLog();
  }

  async copyCrashLog() {
    const text = this.crashLog ? this.crashLog.text() : "";
    if (!text) {
      new Notice("Media Viewer: nothing has been logged yet");
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      new Notice("Media Viewer: crash log copied");
      return true;
    } catch (error) {
      reportFailure("crash-log", "could not copy the crash log", error);
      return false;
    }
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_MEDIA_VIEWER);
    if (existing.length) {
      workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    // A tab in the main area, not the right sidebar. The pane is a viewer and
    // a grid side by side; a sidebar is around 290px, which is narrower than
    // the point where MV-LAYOUT can put them side by side at all, so opening
    // there means a postage-stamp video above a two-column grid. The layout
    // still handles a sidebar — someone who drags it there gets the stacked
    // form — but that is a choice to make, not the default to land in.
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_MEDIA_VIEWER, active: true });
    workspace.revealLeaf(leaf);
    return leaf;
  }
}

module.exports = MediaViewerPlugin;

// Exposed for the out-of-vault test script. Obsidian ignores extra exports.
module.exports.core = core;
// Exported so the crash log can be driven against a stub adapter.
module.exports.CrashLog = CrashLog;
// MediaIndex is not pure — it holds a vault — but the vault surface it uses is
// one method, so it is testable against a stub and worth testing.
module.exports.MediaIndex = MediaIndex;
// Exported so the grid's DOM logic — tile reconciliation, lazy loading and
// thumbnail eviction — can be driven against a stub document.
module.exports.EditSession = EditSession;
module.exports.loadEditSource = loadEditSource;
module.exports.DecodeBudgetError = DecodeBudgetError;
module.exports.CropOverlay = CropOverlay;
module.exports.LineageStore = LineageStore;
module.exports.MetadataResolver = MetadataResolver;
module.exports.guarded = guarded;
module.exports.MediaViewerSettingTab = MediaViewerSettingTab;
module.exports.MediaViewerView = MediaViewerView;
module.exports.VIEW_TYPE_MEDIA_VIEWER = VIEW_TYPE_MEDIA_VIEWER;
