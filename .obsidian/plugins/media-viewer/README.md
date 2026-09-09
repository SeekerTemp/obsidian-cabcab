# Media Viewer

A media browser, viewer and non-destructive editor for this vault, with **asset
lineage** — every file this plugin writes carries a note saying where it came
from, and that note stays correct when files move.

Desktop only. Touch drag-cropping is poor, large decodes exhaust mobile memory,
and iOS restricts video-to-canvas capture.

## What it does

| | |
| --- | --- |
| **Browse** | A dockable pane showing one folder's media as a lazy-loading thumbnail grid, filtered to images, videos or both |
| **View** | Zoom, pan, fit and 100% for images; play, scrub, speed and frame-step for video |
| **Edit** | Crop, rotate, flip and resize, on the viewer in place — no dialog, and no second copy of the viewer |
| **Save** | A new file beside the source, in the source's own format, with the selection following it and no rescan |
| **Capture** | The video frame on screen, written as a PNG whose note names the video and the second it came from |
| **Label** | What a file is *about* — a use case, what it shows, free labels — written to its note |
| **Board** | Evidence placed on an Obsidian canvas, with the provenance arrows drawn for you |
| **Track** | A `MediaInstance` record for every file it writes, and for every file it edits from |
| **Resolve** | Metadata inherited up the `source:` chain, so correcting a value on the parent corrects it everywhere below |

## Opening the pane

- The **ribbon icon**, or **Open Media Viewer** from the command palette.
- **Open in Media Viewer** on any folder's — or any media file's — context menu.
- Otherwise the pane follows the active file, and remembers its folder across
  restarts.

Choosing a folder from the context menu pins the pane to it, because otherwise
the next click in the file explorer would silently undo the choice.

## Keys

The pane binds these only while it has focus. `W`, `A`, `S` and `D` are
ordinary letters everywhere else in Obsidian, and a plugin that swallowed them
globally would break typing.

| Key | Image | Video | Editing |
| --- | --- | --- | --- |
| `W` / `S` | Zoom in / out | Seek ±5s | — |
| `A` / `D` | Previous / next file | Previous / next file | Previous / next file |
| `Space` | — | Play / pause | — |
| `,` `.` | — | Step one frame | — |
| `C` | — | Capture this frame as a PNG | — |
| `R` | — | Play backwards | Rotate |
| `<` `>` | — | Slower / faster | — |
| `0` / `F` | 100% / fit | — | — |
| `Ctrl+V` | Paste an image into this folder | | |
| `Enter` | — | — | Crop to the selection |
| `[` `]` | — | — | Rotate |
| `H` / `V` | — | — | Flip |
| `Ctrl+Z` | — | — | Undo, `Ctrl+Shift+Z` to redo |
| `Ctrl+S` | — | — | Save |
| `Escape` | — | — | Clear the selection, then leave edit mode |

## Editing

**Edit** opens a session on the displayed image. Cropping happens on the viewer
in place: drag a selection, adjust it by any of its eight handles, lock an
aspect ratio if you want one, and the readout shows the size in **source
pixels** — the only unit a crop is actually judged in.

The pipeline is fixed: `rotate → flip → crop → resize`. Rotating with a crop
already set moves the stored rectangle so the same region stays selected.
Without a fixed order, crop-then-rotate and rotate-then-crop silently disagree
and undo stops being definable.

Resize takes either form. **1920 wide** is a dimension and **half** is a
factor, and they behave differently on purpose: a scale still means something
after the crop changes underneath it, and a typed size does not, so changing the
crop drops one and keeps the other.

Undo applies to unsaved state only. Saving writes a new file, moves the
selection to it and opens a fresh session there; undo never steps back past a
file that has been written.

### Limits

- Sources over **40 megapixels** are refused, with a message naming the
  dimensions. A 12000 × 9000 PNG is 432 MB of pixels before anything is done
  to it.
- Anything longer than **4096px** is displayed through a downscaled proxy while
  the maths runs in full source coordinates, so a crop drawn on the proxy is
  still cut at full resolution.

### Output

The format follows the source, because encoding everything to PNG turns a 2 MB
JPEG crop into a 15 MB file.

| Source | Output |
| --- | --- |
| JPEG | JPEG at the configured quality |
| WebP | WebP at the configured quality |
| PNG, BMP, GIF | PNG |

Names are `<stem>+clone+<yymmddHHMMSS>.<ext>`, beside the source. Pasted images
are `pasted+<yymmddHHMMSS>.<ext>`, in whatever format the clipboard says they
are — a pasted GIF stays a GIF, since the bytes are already decided and
renaming them would be a lie about the file.

The name records **that** a file is derived. The note records what from.

## Lineage

Every file this plugin writes gets a record implementing
[[MediaInstance]] — an ordinary note in `data/media/`, not a private
format beside the image:

```yaml
---
implements: MediaInstance
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

Anything you write below that marker is yours and is never rewritten.

### Notes mean the file has been dealt with

| You do this | This happens |
| --- | --- |
| Save an edit | Its note is written, with full provenance |
| Use a file as an edit source | A root note is written for it |
| Run **Mark as reviewed** | A bare root note is written |
| Open, view, zoom, play | **Nothing.** Viewing never writes |

So one crop produces two notes, and the presence of a note is itself the signal
that a file has been reviewed. **Mark as reviewed** exists because otherwise a
file that is already correct could never leave the unreviewed list.

Untracked media is fully viewable and editable. It simply carries no lineage
until something gives it one.

### Finding a note

By what it says, never by what it is called. `LineageStore` reads
`metadataCache` and keeps two maps — media to its note, media to the notes
naming it as `source:` — so a note you move or rename by hand keeps working,
because nothing ever depended on where it was.

### Inheritance

A child declares only its own fields. Everything else is resolved by walking up
the `source:` chain at read time and stopping at the first ancestor that
declares it — which is the whole reason for tracking lineage: correcting a value
on the parent corrects it for every descendant.

Nine fields never inherit, because they describe the file rather than its
subject: `media`, `source`, `op`, `crop`, `transform`, `sourceTime`, `width`,
`height`, `created`.

Resolved values are shown in the lineage panel and never written to disk. The
cost, accepted deliberately: a child note read on its own — by Dataview, by
Bases, by a person — is not self-describing.

### Renames

Renaming or moving a media file with **no** note does nothing at all. For one
that has one, Obsidian's own link updating rewrites `media:` and `source:` and
the plugin does nothing further; the one case where it writes is a vault with
that setting turned **off**.

Children are never renamed. Rename `cover.png` to `hero.png` and
`cover+clone+260908110422.png` keeps its name; only the links change.

This reaches **Asset Renamer** for free. It renames through Obsidian's own
rename path, which fires the event this plugin listens for — no integration
between the two, and no code shared. The vault is the interface.

## Commands

| Command | What it does |
| --- | --- |
| Open Media Viewer | Opens the pane as a tab |
| Paste image into the current folder | For when `Ctrl+V` on the pane is not available |
| Mark as reviewed | Writes a bare root note for the selected file |
| Repair lineage | Writes a note back for a file that has lost one |
| Report lineage breaks | Lists every dangling link and every broken chain. Changes nothing |
| Report media never acted on | Lists vault media with no note at all. Changes nothing |
| Capture the current video frame | For when the pane does not have focus |
| Add to board | Puts the selected file on the board last used |
| Add to board (choose a board) | The same, asking which board first |
| Copy crash log | Puts this session's failures on the clipboard |
| Clear crash log | Starts the log over |

## Settings

| Setting | Default |
| --- | --- |
| Include subfolders | off |
| Follow the active file | on |
| JPEG and WebP quality | 0.92 |
| Write lineage notes | on |
| Folder for new lineage notes | `data/media` |
| Debug logging | off |
| Crash log | **on** |

**Crash log** is the one that stays on. It records failures — never tracing —
to `.obsidian/plugins/media-viewer/crash.log`, so a problem can be handed over
without being reproduced in the developer console first. **Copy crash log**
puts the same thing on the clipboard, and works even when the file could not be
written, which is exactly the situation worth reporting.

**Debug logging** puts `ms=` timings on the developer console for scans,
thumbnails, decodes, encodes, saves and lineage resolution. Nothing is written
to disk: the console already filters, persists, survives the failure and is one
keystroke away.

## Capturing evidence

The workflow this plugin exists for:

1. **Record** a walkthrough of whatever you are investigating.
2. **Capture** the frames that matter — `C`, or the Capture button in the
   transport. Each one is written beside the video as
   `<name>+frame+<timestamp>.png`, and its note records `sourceTime`: the
   second of the video it came from. That field is the only record of it, so a
   capture always knows where it came from.
3. **Label** it in the lineage panel — a use case, what it shows, any labels.
   Nothing infers this; it is the part you know.
4. **Read it back.** The notes are ordinary records in this vault's schema
   system, so `data/base/MediaInstance.base` groups them by use case and
   anything speaking to the vault from outside can do the same without this
   plugin being involved.

Labels are your own values, never inherited ones. A value coming from further
up the chain shows as a greyed hint instead, because typing over it and saving
would copy the parent's answer down and quietly end the inheritance.

## Boards

A board is an **Obsidian canvas** — a normal `.canvas` file. This plugin does
not build one and does not fill one from a folder scan: dragging 500 files onto
a canvas is what no machine handles. It adds what you ask it to add, and draws
the provenance arrow when the other end of the chain is already on the board.

- **Add to board** from a tile's right-click menu, or the command.
- The board is remembered, so the second and every later add is one click.
- Adding a capture whose video is already there draws the arrow between them.
  Adding the video *after* its captures joins them up as well.
- Arrows arrive labelled with their provenance — `frame @ 1:32`, `crop` — and
  are yours from that moment. Retype them, move things, group them, add sticky
  notes: nothing already on a board is ever moved or rewritten.

## Files in the grid

Tiles behave like the file explorer's, because they are the same files:
right-click gives Obsidian's own file menu — everything other plugins add to it
included — and a tile can be dragged out onto a folder to move the file.

## When something goes wrong

One bad file never takes down the grid. A corrupt image gets a broken badge and
browsing continues; an unplayable video names its container; a file over the
decode budget is refused with its dimensions.

A save that fails **keeps the edit session open** — a crop that took a minute to
place is not work to throw away because the disk was full. A file that saved but
could not be tracked says so, and **Repair lineage** writes the note back.

A `source:` naming a file the vault does not hold is reported and never silently
fixed: it may have moved, may be gone, or may not have synced yet, and only you
can tell which. Lineage cycles and chains over 32 hops abort, and are both
logged and shown.

## Development

Plain JavaScript, no build step, matching Schema Sync and every other plugin
here. Everything is in `main.js`, which opens with a `core` block of pure
functions — geometry, transform maths, note rendering, chain resolution —
exported as `module.exports.core`.

```
node tests/all.js     # every suite, each in its own process
node tests/core.test.js   # one suite
node tests/bench.js       # the performance harness
```

The tests load `main.js` against a stubbed `require("obsidian")` and a stub
document, which is how the grid, the viewer, the crop overlay and the lineage
store are all driven without launching the app. That is not a substitute for
opening Obsidian — smooth scrolling in a 500-file folder is a judgement only the
real pane can settle — it is how the bugs that would make that scrolling rough
get caught first.

See [`docs/2026-09-08-media-viewer-design.md`](docs/2026-09-08-media-viewer-design.md)
for why it is shaped this way, and [`docs/HANDOFF.md`](docs/HANDOFF.md) for what
is built and what is not.
