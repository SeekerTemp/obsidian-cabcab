const { Plugin, ItemView, TFile, TFolder } = require("obsidian");

const VIEW_TYPE_MEDIA_VIEWER = "media-viewer-pane";

// Deliberately small. Anything the user can see in the pane header lives here
// so the pane comes back the way they left it, and nothing else does.
const DEFAULT_SETTINGS = {
  lastFolder: null,
  recursive: false,
  filter: "both",
  // Following is what makes the pane feel connected to the file explorer, so
  // it starts on. Choosing a folder from its context menu pins the pane, which
  // is the only way an explicit choice can survive the next click.
  followActiveFile: true,
};

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

// Which folder the pane should follow to, given the file the workspace just
// made active. Only media files move the pane: opening a markdown note should
// not swap a folder of images for an empty list.
function folderForActiveFile(path) {
  if (!path) return null;
  if (isSidecarPath(path)) return null;
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
      console.error("Media Viewer: thumbnail eviction failed for " + key, error);
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
  panLimit,
  clampPan,
  panAfterZoom,
  siblingPath,
  ZOOM_WHEEL_RATIO,
  ZOOM_KEY_RATIO,
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
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    // clear() runs the eviction callback for every entry, which is how a blob
    // URL gets revoked exactly once. The tiles are about to go anyway; the
    // point is that nothing leaks past them.
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
  }

  buildViewer(parent) {
    const viewer = parent.createDiv({ cls: "mv-viewer" });
    this.viewerEl = viewer;

    const stage = viewer.createDiv({ cls: "mv-stage" });
    this.stageEl = stage;
    stage.addEventListener("wheel", (event) => this.handleWheel(event));
    stage.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    stage.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    stage.addEventListener("pointerup", (event) => this.handlePointerUp(event));
    stage.addEventListener("pointercancel", (event) => this.handlePointerUp(event));
    // A double-click toggles between fitting the pane and full size, which is
    // the gesture every image viewer has and the fastest way back from a deep
    // zoom.
    stage.addEventListener("dblclick", () => this.toggleFit());

    const bar = viewer.createDiv({ cls: "mv-viewer-bar" });
    this.viewerBarEl = bar;

    this.prevEl = this.barButton(bar, "Previous", () => this.plugin.selectSibling(-1));
    this.nextEl = this.barButton(bar, "Next", () => this.plugin.selectSibling(1));
    this.zoomEl = bar.createDiv({ cls: "mv-zoom" });
    this.fitEl = this.barButton(bar, "Fit", () => this.fitToPane());
    this.fullEl = this.barButton(bar, "100%", () => this.zoomToActualSize());

    this.viewerNameEl = bar.createDiv({ cls: "mv-viewer-name" });

    // showInViewer short-circuits when the path has not changed, and it starts
    // as null — so the empty stage has to be drawn once here rather than
    // waiting for a selection that may never come.
    this.renderViewer();
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
          if (entry.isIntersecting) {
            this.visible.add(path);
            this.loadThumbnail(entry.target, path);
          } else {
            this.visible.delete(path);
          }
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
    this.syncTiles(paths);
    this.showInViewer(this.plugin.selectedPath);
    this.updateViewerBar();

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
      this.releaseTile(path, tile);
    }

    // Walk the desired order against the DOM in one pass, inserting what is
    // missing and moving only what is genuinely out of place. An unchanged
    // list touches nothing.
    let cursor = this.gridEl.firstElementChild;
    for (const path of paths) {
      let tile = this.tiles.get(path);
      if (!tile) {
        tile = this.createTile(path);
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
  loadThumbnail(tile, path) {
    // get(), not has(): a hit is a use, and the tile should age from now
    // rather than from whenever it first loaded.
    if (this.thumbnails.get(path)) return;
    const file = this.index.fileFor(path);
    if (!file) return;

    const frame = tile.querySelector(".mv-tile-frame");
    if (!frame) return;

    this.thumbnails.set(path, tile);

    if (classifyPath(path) !== "image") {
      frame.addClass("is-placeholder");
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
    });
    img.addEventListener("load", () => tile.removeClass("is-broken"));
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
    this.thumbnails.delete(path);
    if (this.visible.has(path)) this.loadThumbnail(tile, path);
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

    this.stageEl.empty();
    this.stageEl.removeClass("is-broken");
    this.imageEl = null;

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

    if (classifyPath(path) !== "image") {
      // MV-VIDEO replaces this. Saying so is better than a blank stage that
      // looks like a failure.
      this.stageEl.createDiv({
        cls: "mv-stage-message",
        text: "Video playback arrives with the video viewer.",
      });
      this.updateViewerBar();
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

  applyTransform() {
    if (this.imageEl && this.imageEl.style) {
      this.imageEl.style.width = this.naturalWidth ? this.naturalWidth * this.zoom + "px" : "";
      this.imageEl.style.height = this.naturalHeight ? this.naturalHeight * this.zoom + "px" : "";
      this.imageEl.style.transform = "translate(" + this.panX + "px, " + this.panY + "px)";
    }
    this.updateViewerBar();
  }

  updateViewerBar() {
    if (this.zoomEl) {
      this.zoomEl.setText(this.naturalWidth ? Math.round(this.zoom * 100) + "%" : "");
    }
    if (this.prevEl) this.prevEl.disabled = !this.plugin.siblingOf(-1);
    if (this.nextEl) this.nextEl.disabled = !this.plugin.siblingOf(1);
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
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const key = String(event.key || "").toLowerCase();
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

  // The displayed file was written to underneath the viewer. Re-read it, but
  // keep the zoom and pan: the user is looking at a particular part of a
  // particular image, and an edit saved elsewhere should not move their view.
  reloadViewer(path) {
    if (!path || path !== this.viewerPath || !this.imageEl) return;
    const file = this.index.fileFor(path);
    if (!file) return;
    this.imageEl.src = this.plugin.app.vault.getResourcePath(file);
  }

  // The pane can be resized while an image is open, which changes what "fit"
  // means and can leave the pan outside its new bounds.
  handleResize() {
    if (!this.naturalWidth) return;
    this.clampPanToBounds();
    this.applyTransform();
  }
}

class MediaViewerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Selection is a path, never an index. This is the decision that lets a
    // save keep the scroll position and the highlight it started with.
    this.selectedPath = null;

    this.index = new MediaIndex(this.app.vault);
    this.index.recursive = this.settings.recursive;
    this.index.onChange = (reason, path, oldPath) => this.handleIndexChange(reason, path, oldPath);

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
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.lastFolder !== null) {
        this.index.setFolder(this.settings.lastFolder, this.settings.recursive);
      }
      this.followActiveFile(this.app.workspace.getActiveFile());
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
    this.index.setFolder(folder, this.settings.recursive);
    this.settings.lastFolder = this.index.folder;
    void this.saveSettings();
    this.refreshViews();
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
    this.index.setRecursive(this.settings.recursive);
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
      if (reason === "modify") {
        view.reloadThumbnail(path);
        view.reloadViewer(path);
      } else {
        view.render();
      }
    }
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
// Exported so the grid's DOM logic — tile reconciliation, lazy loading and
// thumbnail eviction — can be driven against a stub document.
module.exports.MediaViewerView = MediaViewerView;
module.exports.VIEW_TYPE_MEDIA_VIEWER = VIEW_TYPE_MEDIA_VIEWER;
