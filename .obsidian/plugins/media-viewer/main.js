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
  compareMediaPaths,
  isInFolder,
  sortedInsertIndex,
  selectionAfterRemoval,
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
 * The scan is `vault.getFiles()` filtered by folder and extension — no disk
 * reads and no worker queue. Sidecar notes are excluded, as is every non-media
 * file.
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

  // Whether a vault file belongs in this index at all. Sidecars never appear in
  // the grid, and neither does anything that is not image or video.
  accepts(file) {
    if (!file || typeof file.path !== "string") return false;
    if (this.folder === null) return false;
    if (isSidecarPath(file.path)) return false;
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
    const files = this.vault && typeof this.vault.getFiles === "function" ? this.vault.getFiles() : [];
    for (const file of files) {
      if (!this.accepts(file)) continue;
      this.byPath.set(file.path, file);
      this.order.push(file.path);
    }
    this.order.sort(compareMediaPaths);
    this.emit("scan");
    return this.order;
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
    this.remove(file.path);
    this.emit("delete", file.path);
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

  emit(reason, path, oldPath) {
    if (typeof this.onChange === "function") this.onChange(reason, path, oldPath);
  }
}

class MediaViewerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

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
    this.index = new MediaIndex(this.app.vault);

    this.registerView(VIEW_TYPE_MEDIA_VIEWER, (leaf) => new MediaViewerView(leaf, this));

    this.addRibbonIcon("image", "Open Media Viewer", () => this.activateView());

    this.addCommand({
      id: "open-media-viewer",
      name: "Open Media Viewer",
      callback: () => this.activateView(),
    });

    // Registered on the vault rather than inside the view, so the index stays
    // correct while the pane is closed and does not need a rescan on reopen.
    // Each handler is a map lookup that misses for most of the vault.
    this.registerEvent(this.app.vault.on("create", (file) => this.index.handleCreate(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.index.handleModify(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.index.handleDelete(file)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.index.handleRename(file, oldPath))
    );
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
// MediaIndex is not pure — it holds a vault — but the vault surface it uses is
// one method, so it is testable against a stub and worth testing.
module.exports.MediaIndex = MediaIndex;
