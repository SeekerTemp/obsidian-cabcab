# Media Viewer — design

A vault media browser, viewer and non-destructive editor, ported from the PyQt5
"Local Asset Renamer" desktop app. The renaming half of that app does not come
across: Asset Renamer already owns renaming in this vault.

## Scope

**In.** Browsing vault media in a dockable pane, image viewing with zoom, video
playback with speed and reverse, crop, rotate, flip, resize, video frame
capture, and a runtime debug log.

**Out.** Renaming, category dropdowns, the JSON preset editor, the old app's
Page 2 entirely, folders outside the vault, clipboard paste, annotation, and
video trimming. Nothing here reads or writes a Schema Sync schema — this plugin
is standalone.

## Plugin shape

`.obsidian/plugins/media-viewer/`, plain JavaScript, no build step, matching
Schema Sync and every other plugin in this vault. `main.js` opens with a block
of **pure functions** — geometry, path building, transform maths — exported as
`module.exports.core` so they run under plain node with a stubbed
`require("obsidian")`, the same way Schema Sync verifies its generators.

One large file is a deliberate trade: no npm, no build before reload, uniform
with its neighbours. The cost is a file that will not fit in one screen, and the
mitigation is that `core` holds everything worth testing.

`isDesktopOnly: true`. Touch drag-cropping is poor, large decodes exhaust mobile
memory, and iOS restricts video-to-canvas capture. Claiming mobile support would
be a claim we cannot keep.

## Components

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `core` | Crop mapping, clone paths, transform maths, zoom clamping, extension classification | nothing |
| `MediaIndex` | Ordered media list for one vault folder, from `vault.getFiles()` | vault |
| `ThumbnailCache` | Lazy thumbnails driven by `IntersectionObserver`, LRU-capped | MediaIndex |
| `ViewerSurface` | Image mode (zoom, pan) and video mode (scrub, speed, reverse, frame-step) | MediaIndex |
| `EditSession` | Non-destructive transform state, undo/redo, canvas render, encode | core |
| `CropOverlay` | Drag-select with eight handles, aspect lock, source-pixel readout | core, EditSession |
| `FrameCapture` | Video frame to bitmap, handed to `EditSession` | ViewerSurface, EditSession |
| `DebugLog` | Ring buffer, debounced file flush, error capture, timings | vault adapter |

Cropping happens **on the viewer in place**, not in a modal. The old
`CropImageDialog` was a second copy of the viewer with its own scroll area and
zoom controls — roughly 260 lines of duplication — and its selection could not
be adjusted once drawn, only redrawn.

## Data flow

```
folder → MediaIndex → thumbnail grid + ViewerSurface
                            ↓ select
                      EditSession   (rotate → flip → crop → resize)
                            ↓ Save
        encode → vault.createBinary(<stem>+clone+<ts>.<ext>)
                            ↓
        index inserts by path, selection follows to the new file
```

A source file is never overwritten, and a save never rescans the folder.

## Decisions

### Selection identity

Selection is keyed by **file path**, never by index. This is what fixes the old
app's three worst complaints at once — after a save there is no reload, no lost
scroll position and no lost selection — and it is why the index inserts rather
than rebuilds.

### Index consistency

`MediaIndex` holds a `Map` keyed by path. `vault.createBinary` fires a `create`
event that the index also listens for, so a save would otherwise add the file
twice: **insertion is idempotent by path**, and the event is a no-op for a file
already present.

`modify` on the displayed file re-reads its resource path — Obsidian's
`getResourcePath()` carries the mtime, so the URL changes and the browser cache
is bypassed. `delete` and `rename` update the map; if the affected file was
selected, selection moves to the following entry, or the previous one at the end
of the list.

### Transform pipeline

Fixed order, always:

```
decode → rotate (0/90/180/270) → flipH → flipV → crop → resize → encode
```

The crop rectangle is stored in the coordinate space of the **oriented** image —
after rotation and flips — because that is the space the user drew it in.
Changing rotation with a crop already set rotates the stored rectangle by the
delta, so the same region stays selected. Without a fixed order, crop-then-rotate
and rotate-then-crop silently disagree and undo becomes undefined.

### Crop mapping

The display is the oriented image scaled by factor `z`. A selection in CSS
pixels maps to source pixels by dividing by `z`, then **flooring the top-left
and ceiling the bottom-right**, then clamping to the image bounds. Expanding
outward never discards a pixel the user could see inside their selection;
rounding to nearest sometimes does. A selection resolving to less than 1x1 is
rejected rather than saved.

This rule is the single most testable thing in the plugin and is where the old
app's crop bugs lived. It is stated here so the tests assert intended behaviour
rather than whatever the implementation happens to do.

### Decode budget

Sources above **40 megapixels** are refused with a message naming the
dimensions; the old app carried `MAX_IMAGE_DIMENSION` and `MAX_DECODE_SIZE_MB`
for the same reason. Below that ceiling, anything longer than 4096px on its long
edge is displayed through a **downscaled proxy** while the crop maths continues
to run in full oriented-source coordinates, so a crop of a large image is still
cut at full resolution.

### Encoding

Output format follows the source, because encoding everything to PNG — as the
old app did — turns a 2 MB JPEG crop into a 15 MB file:

| Source | Output |
| --- | --- |
| JPEG | JPEG at the configured quality (default 0.92) |
| WebP | WebP at the configured quality |
| PNG, BMP, GIF | PNG |
| Video frame capture | PNG |

Rotation, flipping and cropping never introduce transparency, so a JPEG source
stays safely a JPEG.

### Output naming

Beside the source, collision-safe, carrying the old app's convention:

- Edits: `<stem>+clone+<yymmddHHMMSS>.<ext>`, then `.1`, `.2` … on collision.
- Frame captures: `<stem>+frame+<ms>ms+<yymmddHHMMSS>.png`.

### Undo

Undo and redo apply to the **unsaved** transform state only. Saving writes a new
file, moves selection to it, and opens a fresh session on that file; the previous
session's history is discarded. Undo never deletes a file that has been written.

### Reverse playback

Implemented by stepping `currentTime` backwards under `requestAnimationFrame`.
This is honestly best-effort: on long H.264 files with sparse keyframes it can
fall to a few frames per second and thrash the disk. It ships behind measurement
— the debug log records achieved frame rate — and falls back to reduced-
resolution reverse scrubbing if the measured rate is unusable on real files.

## Debug log

Off by default; a settings toggle turns it on. When logging every animation
frame during reverse playback, the log is itself a performance problem, so this
is not a thing to leave running.

- In-memory **ring buffer**, last 2000 entries.
- Flushed to `.obsidian/plugins/media-viewer/debug.log` on a 500 ms debounce,
  and immediately on any error and on plugin unload.
- One structured line per entry, greppable rather than prose:
  `2026-09-08T11:04:22.118Z | WARN | EditSession | encode.slow | path=a.png ms=1840 bytes=2119433`
- `window.onerror` and `unhandledrejection` are captured, so a failure mid-drag
  reaches the file instead of only the devtools console.
- Timed operations are the ones that historically hurt: folder scan, first
  visible thumbnails, decode, encode, save, and reverse-playback frame rate.
- A **Copy debug log** command puts the buffer on the clipboard.

`debug.log` is git-ignored.

## Error handling

Every file operation is guarded so that one bad file cannot take down the grid —
the old app crash-logged instead, in `logs/app_crash.log`.

| Failure | Behaviour |
| --- | --- |
| Corrupt or undecodable image | Broken badge on the thumbnail, message in the viewer, browsing continues |
| Unsupported video codec | Message naming the codec |
| Source over the decode budget | Refused with its dimensions; nothing is loaded |
| Encode or save failure | `Notice`, and **the edit session stays open** so the work is not lost |
| File deleted underneath the viewer | Selection moves to a neighbour |

## Use cases

| # | Use case |
| --- | --- |
| UC-01 | Open the media pane from the ribbon, docked or in a split |
| UC-02 | Choose a vault folder to browse; remember the last one |
| UC-03 | Browse thumbnails that load only as they scroll into view |
| UC-04 | Filter the grid to images, videos, or both |
| UC-05 | Select an item and view it full size |
| UC-06 | Zoom, pan, fit-to-pane and reset to 100% |
| UC-07 | Move through the folder from the keyboard without touching the grid |
| UC-08 | Play a video and scrub it |
| UC-09 | Change playback speed between 0.25x and 4x |
| UC-10 | Play a video backwards |
| UC-11 | Step one frame forward or back |
| UC-12 | Capture the current video frame as a PNG in the vault |
| UC-13 | Drag a crop selection over an image |
| UC-14 | Adjust that selection by its handles, optionally with a locked aspect ratio |
| UC-15 | Rotate in 90° steps, flip horizontally or vertically |
| UC-16 | Resize to explicit dimensions or by scale factor |
| UC-17 | Undo and redo edits before saving |
| UC-18 | Save the result as a new file beside the source |
| UC-19 | Crop a captured video frame before saving it |
| UC-20 | Keep browsing when a folder contains corrupt or unsupported files |
| UC-21 | Turn on debug logging, reproduce a fault, and hand over the log |
| UC-22 | Keep working when files change on disk underneath the pane |

## Backlog

### M1 — Browse

- [ ] Plugin scaffold: `manifest.json`, `main.js`, `styles.css`, ribbon icon, `ItemView`
- [ ] `core`: extension classification, zoom clamping, clone-path builder
- [ ] `MediaIndex` over a chosen vault folder, non-recursive, with a recursive toggle
- [ ] Folder picker with last-folder persistence
- [ ] Thumbnail grid, `IntersectionObserver`-driven, LRU-capped
- [ ] Image viewer: zoom by wheel and `W`/`S`, pan, fit, reset
- [ ] Keyboard navigation: `A`/`D` and arrow keys, selection keyed by path
- [ ] Image/video/both filter
- [ ] Container-query layout so the pane reflows when docked in a split
- [ ] Vault `create`/`modify`/`delete`/`rename` handling, idempotent by path

### M2 — Video

- [ ] Video viewer: play/pause on `Space`, scrub bar, position and duration readout
- [ ] Seek ±5s on `W`/`S`, frame-step
- [ ] Playback speed 0.25x–4x
- [ ] Video thumbnails: seek to 1s, draw once to canvas, cache
- [ ] Reverse playback under `requestAnimationFrame`, with measured frame rate
- [ ] Reduced-resolution reverse-scrub fallback if the measurement is poor
- [ ] Frame capture to PNG, named `<stem>+frame+<ms>ms+<ts>.png`

### M3 — Edit

- [ ] `EditSession`: fixed transform pipeline, undo/redo, canvas render
- [ ] Decode budget with downscaled display proxy above 4096px
- [ ] `CropOverlay`: drag-select, eight handles, aspect lock, source-pixel readout
- [ ] Crop mapping per the floor/ceil rule, with tests across zoom levels
- [ ] Rotate 90°, flip horizontal and vertical, with crop-rect carry-over
- [ ] Resize by dimensions or scale
- [ ] Format-following encode with a quality setting
- [ ] Save via `vault.createBinary`, selection follows to the new file
- [ ] Crop a captured video frame before saving

### M4 — Diagnostics

- [ ] `DebugLog`: ring buffer, debounced flush, structured lines
- [ ] `window.onerror` and `unhandledrejection` capture
- [ ] Timings for scan, first-visible-thumbs, decode, encode, save
- [ ] Settings toggle, off by default; **Copy debug log** command
- [ ] `.gitignore` entry for `debug.log`

### M5 — Resilience and polish

- [ ] Guarded failure paths for every row in the error-handling table
- [ ] Settings: default folder, recursive scan, JPEG/WebP quality, debug logging
- [ ] Node tests over `core` with a stubbed `require("obsidian")`
- [ ] Manual performance pass at 20 / 100 / 500+ files
- [ ] `README.md` for the plugin

## Testing

`core` runs under node with a stubbed `require("obsidian")`, as Schema Sync's
generators do. Covered there:

- Crop mapping at many zoom levels, in every rotation and flip combination,
  including selections that overhang the image edge.
- Crop-rectangle carry-over when rotation changes after a crop is set.
- Clone-path and frame-capture-path collision sequences.
- Transform dimension maths, including 90° rotation of non-square images.
- Zoom clamping at both limits.
- Extension classification, including unknown and uppercase extensions.

The rest is manual, replacing `PERFORMANCE_CHECKLIST.md` minus its category and
rename sections:

- [ ] Folders of 20, 100 and 500+ files; record scan and first-visible-thumb times
- [ ] Pane stays responsive while thumbnails are still loading
- [ ] Switch folders rapidly with no stale thumbnails
- [ ] Scroll top to bottom fast with no crash and no runaway memory
- [ ] Save leaves scroll position and selection intact, with no rescan
- [ ] Folder containing corrupt and unsupported files still browses
- [ ] Media on a slow external drive, reached through a vault symlink
- [ ] Reverse playback frame rate on a long clip and on a short one
- [ ] Crop output opened and checked pixel-exact against the selection

## Open risks

- Reverse playback may not be usable on long files. Measured in M2; the fallback
  is scoped, and dropping the feature stays on the table.
- Video thumbnail generation seeks every video in a folder once. On a slow drive
  this could be the new equivalent of the old app's thumbnail stalls, and it is
  measured in the same M5 pass.
