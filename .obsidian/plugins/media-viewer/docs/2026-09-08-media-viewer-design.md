# Media Viewer — design

A vault media browser, viewer and non-destructive editor with **asset lineage**,
ported from the PyQt5 "Local Asset Renamer" desktop app.

The renaming half of that app does not come across — Asset Renamer already owns
renaming in this vault. What comes across instead is a claim the old app could
never make: because every edit happens inside a vault, a derived file can carry a
note recording where it came from, and that record can be kept correct when files
move.

## Scope

**In.** Media browsing in a dockable pane, image viewing with zoom, video
playback with speed and reverse, crop, rotate, flip, resize, video frame
capture, `.instance.md` lineage notes with inherited metadata, and a runtime
debug log.

**Out.** Renaming, category dropdowns, the JSON preset editor, the old app's
Page 2 entirely, its `FolderBrowserWidget` folder tree, folders outside the
vault, clipboard paste, annotation, and video trimming. Nothing here reads or
writes a Schema Sync schema.

## Plugin shape

`.obsidian/plugins/media-viewer/`, plain JavaScript, no build step, matching
Schema Sync and every other plugin in this vault. `main.js` opens with a block
of **pure functions** — geometry, path building, transform maths, lineage
resolution — exported as `module.exports.core` so they run under plain node with
a stubbed `require("obsidian")`, the same way Schema Sync verifies its
generators.

One large file is a deliberate trade: no npm, no build before reload, uniform
with its neighbours. The cost is a file that will not fit in one screen, and the
mitigation is that `core` holds everything worth testing.

`isDesktopOnly: true`. Touch drag-cropping is poor, large decodes exhaust mobile
memory, and iOS restricts video-to-canvas capture.

## Lineage

The centrepiece. Every managed media file is paired with a sidecar note:

```
data/assets/cover.png
data/assets/cover.instance.md
data/assets/cover+clone+260908110422.png
data/assets/cover+clone+260908110422.instance.md
```

One note type, not two. A root asset's note simply declares no `source:`, so
lineage is a chain of the same thing rather than two formats meeting in the
middle — and a root that later turns out to have a parent needs no migration.

### Note format

```yaml
---
media:  "[[cover+clone+260908110422.png]]"
source: "[[cover.png]]"
op: crop
crop:   { x: 120, y: 40, w: 800, h: 600 }
transform: { rotate: 0, flipH: false, flipV: false }
width: 800
height: 600
created: 2026-09-08T11:04:22Z
status: edited
labels: []
---

<!-- media-viewer:notes -->
```

`media:` is the **authoritative** pairing — the filename match is only how notes
are discovered, so a note whose name has drifted still works. `crop` is stored in
oriented-source pixels, the same space the crop overlay works in, so the
derivation is reproducible rather than merely descriptive.

`status:` is one of `edited`, `reviewed` or any value you set by hand, and
`labels:` is a free list. Neither is used by this plugin's logic — they exist so
the overview tab can answer "unlabelled" without a later format migration, and
so Dataview and Bases can query them today. Both are inherited down the chain
like any other field.

Everything below the notes marker is yours and is never rewritten, following the
convention Schema Sync already established in this vault.

### A note means the file has been dealt with

Notes are not created for every media file in the vault. They are created when
you **act** on a file, never when you merely look at one — so the presence of a
note is itself the signal that a file has been reviewed, and the absence of one
marks everything still untouched.

| Trigger | Result |
| --- | --- |
| The plugin writes a derived file | Its note is created with full provenance |
| A file is used as an edit source | A root note is created for it, with no `source:` |
| **Mark as reviewed** command | A bare root note is created on demand |
| Opening, viewing, zooming, playing | **Nothing.** Viewing never writes |

Cropping `cover.png` therefore produces two notes: one for the crop, and a root
note for `cover.png` itself. You did open that file and act on it, so it has
been reviewed — and the root note is what gives the crop something to inherit
from.

**Mark as reviewed** exists because otherwise a file that is already correct
could never leave the unreviewed list; the list would shrink only by editing
files that needed no editing.

Untracked media stays fully viewable and editable. It simply carries no lineage
and no review mark until something gives it one.

### Reviewed, and the cost of that word

"Reviewed" here means *this plugin has written something about the file*. It
does not distinguish a considered decision from an accidental crop, and it
cannot: a marker in a file's existence has exactly one bit. The `status:` field
carries any finer meaning.

The unreviewed set needs no index of its own — it is every media file in the
vault minus those `LineageStore` knows a note for, which is a set difference
over data already in memory.

### Inheritance

A child declares only its own fields. Any other field is resolved by **walking
up the `source:` chain at read time** — so correcting a value on the parent
corrects it for every descendant, which is the entire reason for tracking
lineage in the first place.

Resolution stops at the first ancestor declaring the field. Cycles are broken by
a visited set and the walk is capped at 32 hops; both conditions are logged and
surfaced rather than silently swallowed. A `source:` pointing at a file that no
longer exists ends the walk and is reported in the pane.

The cost, accepted deliberately: a child note read on its own — by Dataview, by
Bases, by a human — is not self-describing. Resolved values are shown in the
pane, not written to disk.

### Keeping lineage correct across renames

**Only tracked files are touched.** Renaming or moving a media file with no note
does nothing at all — no scan, no rewrite, no work. The rename listener's first
act is a map lookup, and for most of the vault that lookup misses and the event
is dropped. Handling is therefore proportional to what you have actually edited,
not to vault size.

For tracked files, the plugin handles vault `rename` events itself rather than
relying on Obsidian's "automatically update internal links" setting, which the
user may have turned off:

| Event | Response |
| --- | --- |
| A media file is renamed or moved | Its own sidecar note is renamed and moved alongside it, and its `media:` link is rewritten |
| A media file is renamed or moved | Every `source:` link pointing at it is rewritten, wherever those children live |
| A media file is deleted | Children keep their `source:`, which now dangles and is reported in the pane |
| A sidecar note is renamed by hand | Nothing breaks — `media:` is authoritative |

**Children are never renamed.** Rename `cover.png` to `hero.png` and
`cover+clone+260908110422.png` keeps its name; only the links change. Cascading
the rename would turn one operation into many that can each fail partway, and
would break every inbound link to a child.

A sidecar is renamed with its own media file because that pairing is what makes
notes discoverable — but nothing depends on it, since `media:` is authoritative.

### Why this reaches Asset Renamer

Asset Renamer renames media through Obsidian's own rename path, which fires the
same `rename` event this plugin listens for. So renaming a cover through Asset
Renamer repairs the lineage of every crop taken from it, with no integration
between the two plugins and no code shared. The vault is the interface.

## Components

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `core` | Crop mapping, clone paths, transform maths, zoom clamping, extension classification, chain resolution | nothing |
| `MediaIndex` | Ordered media list for one vault folder, from `vault.getFiles()` | vault |
| `LineageStore` | Reads and writes `.instance.md`, maps media to note and parent to children | vault, metadata cache |
| `MetadataResolver` | Walks the `source:` chain to resolve an inherited field | core, LineageStore |
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

## Choosing a folder

The old app's `FolderBrowserWidget` — a hand-built folder tree with back
navigation — is deleted outright. Obsidian's file explorer already is that
widget, and better.

The plugin still scans, because a grid and prev/next navigation need a list:

- The pane follows the **active file**, and scans that file's folder.
- **Open in Media Viewer** on a folder's context menu sets the folder directly.
- The last folder is remembered across restarts.
- Scanning is non-recursive by default, with a recursive toggle.

The scan itself is `vault.getFiles()` filtered by folder and extension — no disk
reads, no worker queue, none of the old app's thumbnail machinery.

## Data flow

```
folder → MediaIndex → thumbnail grid + ViewerSurface
                            ↓ select
              LineageStore → MetadataResolver → lineage panel
                            ↓ edit
                      EditSession   (rotate → flip → crop → resize)
                            ↓ Save
        encode → vault.createBinary(<stem>+clone+<ts>.<ext>)
               → LineageStore.write(<stem>+clone+<ts>.instance.md)
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

`.instance.md` files never appear in the grid.

### Transform pipeline

Fixed order, always:

```
decode → rotate (0/90/180/270) → flipH → flipV → crop → resize → encode
```

The crop rectangle is stored in the coordinate space of the **oriented** image —
after rotation and flips — because that is the space the user drew it in, and it
is the space written into the `.instance.md` note. Changing rotation with a crop
already set rotates the stored rectangle by the delta, so the same region stays
selected. Without a fixed order, crop-then-rotate and rotate-then-crop silently
disagree, undo becomes undefined, and the recorded provenance stops describing
what actually happened.

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
- Sidecars: the media file's stem plus `.instance.md` —
  `cover+clone+260908110422.png` pairs with
  `cover+clone+260908110422.instance.md`. Where a stem is already taken, because
  `cover.png` and `cover.mp4` sit in one folder, the extension is folded in:
  `cover.mp4.instance.md`. Discovery tries both forms, and `media:` settles any
  remaining doubt.

The name records that a file is derived; the note records what it was derived
from. The name is a convenience, the note is the truth.

### Undo

Undo and redo apply to the **unsaved** transform state only. Saving writes a new
file and its note, moves selection to the new file, and opens a fresh session on
it; the previous session's history is discarded. Undo never deletes a file that
has been written.

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
  visible thumbnails, decode, encode, save, lineage resolution, and
  reverse-playback frame rate.
- Rename cascades log every link they rewrite, since that is the operation with
  the widest blast radius and the least visible failure mode.
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
| Binary saved but note write failed | The file survives, the pane flags it as untracked, and **Repair lineage** rewrites the note |
| `source:` points at a missing file | Chain resolution stops there; the pane shows the break |
| Lineage cycle, or a chain over 32 hops | Walk aborts, both logged and shown |
| File deleted underneath the viewer | Selection moves to a neighbour |

## Use cases

| # | Use case |
| --- | --- |
| UC-01 | Open the media pane from the ribbon, docked or in a split |
| UC-02 | Have the pane follow the media file selected in the file explorer |
| UC-03 | Open a folder in the pane from its context menu; last folder is remembered |
| UC-04 | Browse thumbnails that load only as they scroll into view |
| UC-05 | Filter the grid to images, videos, or both |
| UC-06 | Select an item and view it full size |
| UC-07 | Zoom, pan, fit-to-pane and reset to 100% |
| UC-08 | Step through sibling media from the keyboard |
| UC-09 | Play a video and scrub it |
| UC-10 | Change playback speed between 0.25x and 4x |
| UC-11 | Play a video backwards |
| UC-12 | Step one frame forward or back |
| UC-13 | Capture the current video frame as a PNG, tracked as a child of the video |
| UC-14 | Drag a crop selection over an image |
| UC-15 | Adjust that selection by its handles, optionally with a locked aspect ratio |
| UC-16 | Rotate in 90° steps, flip horizontally or vertically |
| UC-17 | Resize to explicit dimensions or by scale factor |
| UC-18 | Undo and redo edits before saving |
| UC-19 | Save the result as a new file beside the source, with its lineage note |
| UC-20 | Crop a captured video frame before saving it |
| UC-21 | See a file's parent and children, and jump along the chain |
| UC-22 | See which metadata a file declares and which it inherits, and from where |
| UC-23 | Rename a parent — through Asset Renamer or anywhere else — and have children stay correct |
| UC-24 | Mark a file reviewed without editing it |
| UC-25 | Repair a file whose note is missing or broken |
| UC-26 | Find lineage breaks across the vault |
| UC-27 | Keep browsing when a folder contains corrupt or unsupported files |
| UC-28 | Turn on debug logging, reproduce a fault, and hand over the log |
| UC-29 | Keep working when files change on disk underneath the pane |
| UC-30 | See which media in the vault has never been reviewed |
| UC-31 | See which reviewed media carries no labels |
| UC-32 | Rename untracked media without the plugin doing any work |

## Backlog

### M1 — Browse

- [ ] Plugin scaffold: `manifest.json`, `main.js`, `styles.css`, ribbon icon, `ItemView`
- [ ] `core`: extension classification, zoom clamping, clone-path builder
- [ ] `MediaIndex` over a vault folder, non-recursive, with a recursive toggle
- [ ] Pane follows the active file; **Open in Media Viewer** on a folder's context menu
- [ ] Last-folder persistence
- [ ] Thumbnail grid, `IntersectionObserver`-driven, LRU-capped
- [ ] Image viewer: zoom by wheel and `W`/`S`, pan, fit, reset
- [ ] Keyboard navigation through siblings, selection keyed by path
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

### M4 — Lineage

- [ ] `LineageStore`: read, write and discover `.instance.md`, with `media:` authoritative
- [ ] Note written on every derived save, carrying `crop` and `transform`
- [ ] Root note created when a file is used as an edit source
- [ ] **Mark as reviewed** command; viewing never writes a note
- [ ] `status:` and `labels:` fields, inherited like any other
- [ ] `MetadataResolver`: chain walk, cycle guard, 32-hop cap, break reporting
- [ ] Lineage panel: parent, children, and which fields are inherited from where
- [ ] `rename` handling: sidecar follows its media; `source:` links rewritten; children never renamed
- [ ] `delete` handling: dangling `source:` reported, never silently repaired
- [ ] **Repair lineage** for a file whose note is missing or broken
- [ ] Vault-wide lineage break report
- [ ] Notes marker (`<!-- media-viewer:notes -->`) preserved on every rewrite

### M5 — Overview tab (deferred)

Scoped here so the note format does not need migrating later; not built in this
pass. The data it needs already exists.

- [ ] Unreviewed list: all vault media minus those `LineageStore` holds a note for
- [ ] Unlabelled list: tracked media whose resolved `labels:` is empty
- [ ] Lineage break list
- [ ] Filter by `status:` and by folder

### M6 — Diagnostics

- [ ] `DebugLog`: ring buffer, debounced flush, structured lines
- [ ] `window.onerror` and `unhandledrejection` capture
- [ ] Timings for scan, first-visible-thumbs, decode, encode, save, resolution
- [ ] Rename cascades log every rewritten link
- [ ] Settings toggle, off by default; **Copy debug log** command
- [ ] `.gitignore` entry for `debug.log`

### M7 — Resilience and polish

- [ ] Guarded failure paths for every row in the error-handling table
- [ ] Settings: recursive scan, JPEG/WebP quality, sidecar creation, debug logging
- [ ] Node tests over `core` with a stubbed `require("obsidian")`
- [ ] Manual performance pass at 20 / 100 / 500+ files
- [ ] `README.md` for the plugin

## Testing

`core` runs under node with a stubbed `require("obsidian")`, as Schema Sync's
generators do. Covered there:

- Crop mapping at many zoom levels, in every rotation and flip combination,
  including selections that overhang the image edge.
- Crop-rectangle carry-over when rotation changes after a crop is set.
- Clone-path, frame-capture-path and sidecar-path collision sequences.
- Transform dimension maths, including 90° rotation of non-square images.
- Zoom clamping at both limits.
- Extension classification, including unknown and uppercase extensions.
- Chain resolution: first-declaring ancestor wins, cycles abort, the hop cap
  holds, and a missing ancestor reports rather than throws.
- Note round-tripping, including preservation of content below the notes marker.

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
- [ ] Rename a parent through Asset Renamer; every child resolves afterwards
- [ ] Move a parent to another folder; same check
- [ ] Rename a parent with Obsidian's link-updating setting **off**; same check
- [ ] Three-deep chain: crop of a crop of a capture, then rename the root

## Open risks

- Reverse playback may not be usable on long files. Measured in M2; the fallback
  is scoped, and dropping the feature stays on the table.
- Video thumbnail generation seeks every video in a folder once. On a slow drive
  this could be the new equivalent of the old app's thumbnail stalls, measured in
  the same M7 pass.
- Rename handling is the widest-blast-radius operation here, and a partial
  failure leaves lineage half-rewritten. Mitigated by logging every rewrite and
  by **Repair lineage**, but a rename touching many children is not atomic and
  cannot be made so through the vault API.
- "Reviewed" carries exactly one bit — whether a note exists. An accidental
  crop marks a file reviewed just as a considered decision does, and nothing
  distinguishes them. `status:` is where any finer meaning has to live.
- Live inheritance means a child note read outside this plugin — by Dataview or
  Bases — shows only its own fields. If those queries turn out to matter, the
  answer is a materialise command, deliberately deferred rather than designed in.
