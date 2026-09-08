const { Plugin, ItemView } = require("obsidian");

const VIEW_TYPE_MEDIA_VIEWER = "media-viewer-pane";

/* ------------------------------------------------------------------------ *
 * core — pure functions. No Obsidian API, no I/O, no `this`.
 * Everything between this banner and the next one runs under plain node with
 * a stubbed `require("obsidian")`, which is the only way this maths gets
 * verified without launching Obsidian. See tests/core.test.js.
 * ------------------------------------------------------------------------ */

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "avif"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"];
const SIDECAR_SUFFIX = ".instance.md";
const NOTES_MARKER = "<!-- media-viewer:notes -->";

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 32;

// Encoding follows the source, because encoding everything to PNG turns a 2 MB
// JPEG crop into a 15 MB file. Rotation, flipping and cropping never introduce
// transparency, so a JPEG source stays safely a JPEG.
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

function isSidecarPath(path) {
  return baseNameOf(path).toLowerCase().endsWith(SIDECAR_SUFFIX);
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

// <stem>+frame+<ms>ms+<yymmddHHMMSS>.png. Milliseconds are floored, so the name
// names a frame that was actually displayed rather than one rounded past.
function framePathFor(sourcePath, milliseconds, taken, date) {
  const ms = Math.max(0, Math.floor(Number(milliseconds) || 0));
  const stem = stemOf(sourcePath) + "+frame+" + ms + "ms+" + timestampFor(date);
  return uniquePath(folderOf(sourcePath), stem, "png", taken);
}

// A sidecar is the media stem plus ".instance.md". Where that stem is already
// taken — because cover.png and cover.mp4 sit in one folder — the extension is
// folded in: "cover.mp4.instance.md". Discovery tries both forms, and `media:`
// settles any remaining doubt.
function sidecarCandidatesFor(mediaPath) {
  const folder = folderOf(mediaPath);
  const extension = extensionOf(mediaPath);
  const plain = joinPath(folder, stemOf(mediaPath) + SIDECAR_SUFFIX);
  if (!extension) return [plain];
  return [plain, joinPath(folder, stemOf(mediaPath) + "." + extension + SIDECAR_SUFFIX)];
}

// The path a sidecar write should use. The plain form wins unless something
// already holds it, in which case the extension-folded form is tried, then
// numbered.
function sidecarPathFor(mediaPath, taken) {
  const exists = typeof taken === "function" ? taken : () => false;
  const candidates = sidecarCandidatesFor(mediaPath);
  for (const candidate of candidates) {
    if (!exists(candidate)) return candidate;
  }
  const last = candidates[candidates.length - 1];
  const stem = baseNameOf(last).slice(0, -SIDECAR_SUFFIX.length);
  return uniquePath(folderOf(last), stem, "instance.md", exists);
}

// A sidecar names its media by stem, so the reverse mapping strips the suffix.
// Only a hint for discovery — `media:` is authoritative.
function mediaStemForSidecar(sidecarPath) {
  const name = baseNameOf(sidecarPath);
  if (!name.toLowerCase().endsWith(SIDECAR_SUFFIX)) return null;
  return name.slice(0, -SIDECAR_SUFFIX.length);
}

const core = {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  SIDECAR_SUFFIX,
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
  isSidecarPath,
  matchesFilter,
  mimeForExtension,
  outputExtensionFor,
  clampZoom,
  stepZoom,
  fitZoom,
  timestampFor,
  uniquePath,
  clonePathFor,
  framePathFor,
  sidecarCandidatesFor,
  sidecarPathFor,
  mediaStemForSidecar,
};

/* ------------------------------------------------------------------------ *
 * End of core. Everything below touches Obsidian.
 * ------------------------------------------------------------------------ */

class MediaViewerView extends ItemView {
  getViewType() {
    return VIEW_TYPE_MEDIA_VIEWER;
  }

  getDisplayText() {
    return "Media Viewer";
  }

  getIcon() {
    return "image";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("media-viewer");
    root.createDiv({ cls: "mv-empty", text: "No folder selected." });
  }

  async onClose() {
    this.contentEl.empty();
  }
}

class MediaViewerPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_MEDIA_VIEWER, (leaf) => new MediaViewerView(leaf));

    this.addRibbonIcon("image", "Open Media Viewer", () => this.activateView());

    this.addCommand({
      id: "open-media-viewer",
      name: "Open Media Viewer",
      callback: () => this.activateView(),
    });
  }

  // Reuse an existing pane rather than stacking duplicates; a second ribbon
  // click should reveal the pane already open, not open another.
  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_MEDIA_VIEWER);
    if (existing.length) {
      workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    const leaf = workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_MEDIA_VIEWER, active: true });
    workspace.revealLeaf(leaf);
    return leaf;
  }
}

module.exports = MediaViewerPlugin;

// Exposed for the out-of-vault test script. Obsidian ignores extra exports.
module.exports.core = core;
