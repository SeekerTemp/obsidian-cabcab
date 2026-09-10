# Video Editor — task handoff index

Same working process as Media Viewer: one task per session, one commit per
task, and a task is done when its **Verify** line actually passes rather than
when the code looks right. Start a session by naming a keyword:

> `VE-TRIM` — continue from the handoff index

Rules that hold for every task:

- Plain JavaScript, no build step. Everything lives in
  `.obsidian/plugins/video-editor/main.js`, with pure logic in the `core` block
  at the top, exported as `module.exports.core`.
- Anything in `core` gets node tests, run with a stubbed `require("obsidian")`.
- **Every ffmpeg argument list is built by a pure function and asserted in
  `tests/ffmpeg.test.js`.** Nothing in `tests/all.js` runs the binary, so the
  suite runs anywhere — that is what makes it worth running on every change.
- `tests/smoke.js` is the exception and runs the real thing, because a fake
  child process will accept an argument list ffmpeg rejects. It is not in
  `all.js`: it needs a binary and takes a couple of minutes.
- Reload Obsidian to test. Several Verify lines below need a person and a real
  video; they say so.

---

## M1 — Cut one clip

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 1 | `VE-SCAFFOLD` | `manifest.json` (`isDesktopOnly: true`), `main.js`, `styles.css`, a view opening in a main-area tab | all three | — | The plugin appears in settings and the ribbon opens an empty pane |
| 2 | `VE-CORE` | `core`: paths, timecodes, ranges, clips, filmstrip counts, settings normalisation | `main.js`, `tests/core.test.js` | 1 | `node tests/core.test.js` passes |
| 3 | `VE-FFMPEG` | `FfmpegRunner`: locate the binaries, run one, parse `-progress`, cancel, kill on unload; every argument list a pure function | `main.js`, `tests/ffmpeg.test.js`, `tests/runner.test.js` | 2 | Both suites pass; a missing ffmpeg is reported in words |
| 4 | `VE-PROBE` | ffprobe for duration, size, frame rate and codecs; the element's own metadata as the fallback | `main.js` | 3 | An mp4 opens and the header names its size, rate and length |
| 5 | `VE-TRANSPORT` | Play/pause, seek, frame-step at the probed rate, speed 0.25×–4×, playback stopping at the out point | `main.js`, `styles.css` | 4 | Space, arrows and `,`/`.` all do what the tooltips say |
| 6 | `VE-TIMELINE` | In/out handles, drag-to-scrub, dimmed exclusions, ruler; handles that swap rather than refuse | `main.js`, `styles.css` | 5 | Dragging either handle past the other swaps them |
| 7 | `VE-STRIP` | Filmstrip: **count from the pane's width, never from the duration**; stills piped as JPEG, object URLs released | `main.js` | 6 | A 60-minute file draws the same number of stills as a 10-second one |
| 8 | `VE-TRIM` | Trim the selection to `<stem>+trim+<ts>.<ext>`, copy or re-encode, with progress and cancel | `main.js` | 7 | A trim of a real file plays, and starts where the in point was |

## M2 — Arrange and export

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 9 | `VE-CLIPS` | Clip list: add, remove, reorder by dragging, select-moves-the-selection; a list spanning several videos | `main.js`, `styles.css` | 8 | Three clips reorder by dragging and the total updates |
| 10 | `VE-SPLIT` | Split the selection at the playhead into two clips; refuse a split that would leave nothing | `main.js` | 9 | Splitting mid-selection adds two rows; splitting at the edge adds none |
| 11 | `VE-EXPORT` | Trim each clip to a temp file, then join with the concat demuxer; temp files cleared even on failure | `main.js`, `tests/export.test.js` | 10 | Two clips export as one file that plays through both |
| 12 | `VE-AUDIO` | Extract the selection's audio to `<stem>+audio+<ts>.m4a` | `main.js` | 8 | The m4a plays and is the right length |

## M3 — Lineage

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 13 | `VE-SCHEMA` | `sourceStart`, `sourceEnd` and `clips` added to `MediaInstance`, and to Media Viewer's intrinsic list | `data/schema/`, `media-viewer/main.js` | — | Schema Sync accepts it; Media Viewer's suite still passes |
| 14 | `VE-RECORD` | A record per derived file plus a root for the source; found by `media:`, never by filename; prose below the marker preserved | `main.js`, `tests/lineage.test.js` | 13 | One trim produces two notes; opening a video produces none |
| 15 | `VE-MENU` | **Open in Video Editor** on the `file-menu` for video files | `main.js` | 4 | The item appears in the file explorer *and* in the Media Viewer grid |

## M4 — Polish

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 16 | `VE-SETTINGS` | Binary paths, copy/re-encode, CRF, output folder, record folder, filmstrip, debug logging | `main.js` | 3 | Settings persist across reload |
| 17 | `VE-ERRORS` | Missing binary, unreadable file, failed join, cancelled job, vault not on a disk — each named and survivable | `main.js` | 16 | Every row of the table below behaves as written |
| 18 | `VE-README` | Plugin `README.md` in the vault's documentation style | `README.md` | 17 | — |

## M5 — From using it

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 19 | `VE-BROWSE` | **The pane could not be opened.** Its empty state told you to go and right-click a file somewhere else, which is a dead end. The empty state becomes the vault's videos: folders with counts, a search, a still per tile, double-click to edit | `main.js`, `styles.css`, `docs/layout.html` | 4 | Open the pane with nothing loaded and start editing a video without leaving it |
| 20 | `VE-EMPTYFIX` | Three things the first screenshot showed: a stray black `<video>` box in the empty state, ffmpeg's git-describe version pushing the header apart, and a live timecode readout for a video that is not open | `main.js`, `styles.css` | 19 | Nothing in the empty pane refers to a video that is not there |
| 21 | `VE-TILEINFO` | Hovering a tile shows name, folder, duration, shape, size and date created; the duration also sits on the poster. `PosterCache` becomes `TileCache` and probes alongside the still, since ffprobe reads a header where the still decodes a frame | `main.js`, `styles.css`, `docs/layout.html` | 19 | Hover a tile and read its duration and creation date without opening it |

## M6 — Out of the vault

| # | Keyword | Goal | Touches | Needs | Verify |
| --- | --- | --- | --- | --- | --- |
| 22 | `VE-HANDOFF` | **media-handoff/1**: a canvas plus the lineage records become an ordered shot list something else can act on. Order from the arrows, captions from their labels, provenance from the records. Written beside the board as `<board>.handoff.json` | `main.js`, `docs/MEDIA-HANDOFF.md` | 14 | Write one from `assets/board.canvas` and every shot names its recording and its second |

## Progress

- [x] 1 `VE-SCAFFOLD`
- [x] 2 `VE-CORE`
- [x] 3 `VE-FFMPEG`
- [x] 4 `VE-PROBE`
- [x] 5 `VE-TRANSPORT`
- [x] 6 `VE-TIMELINE`
- [x] 7 `VE-STRIP`
- [x] 8 `VE-TRIM`
- [x] 9 `VE-CLIPS`
- [x] 10 `VE-SPLIT`
- [x] 11 `VE-EXPORT`
- [x] 12 `VE-AUDIO`
- [x] 13 `VE-SCHEMA`
- [x] 14 `VE-RECORD`
- [x] 15 `VE-MENU`
- [x] 16 `VE-SETTINGS`
- [x] 17 `VE-ERRORS`
- [x] 18 `VE-README`
- [x] 19 `VE-BROWSE` — from the first real session: the pane had no way in
- [x] 20 `VE-EMPTYFIX` — from the same screenshot
- [x] 21 `VE-TILEINFO` — from the vault README's feedback list
- [x] 22 `VE-HANDOFF` — the bridge to an MCP; format in docs/MEDIA-HANDOFF.md

Everything above passes under `node tests/all.js` — 238 tests across seven
suites, none of which need ffmpeg.

`node tests/smoke.js` adds 29 more against a **real** ffmpeg and a real
60-minute video: probing, both trim modes, muting, a two-clip join, the
filmstrip, audio extraction, a failing run and a cancelled one. It confirmed the
claim the whole design rests on — see the numbers below.

**What neither covers is the checklist below**, and it needs a person, because
it is about whether the output actually plays and whether the pane feels right.

---

## Acceptance checklist — needs a person

What is left is what neither harness can reach. `tests/all.js` never runs
ffmpeg, and `tests/smoke.js` runs it but has no Obsidian, no pane and no eyes:
it can prove a trim lands within a keyframe of where it was asked to, and
cannot tell you whether the output plays, whether the drag felt right, or
whether the clip starts on the frame you meant.

### Before anything

- [x] ffmpeg and ffprobe are in the plugin's own `bin/` — a GPL build, so
      `libx264` is present and re-encode works. `node tests/smoke.js` finds
      them there and passes
- [x] `node scripts/fetch-ffmpeg.js` puts them there from empty, verified by
      moving the existing pair aside and running it. See
      [SETUP.md](SETUP.md) for what a clone on another machine needs
- [x] **Video Editor** is enabled in `community-plugins.json`
- [ ] Reload Obsidian so it loads

### Opening

- [ ] The pane opens showing **the vault's videos**, with folder counts down
      the side and a still on each tile
- [ ] **Double-clicking a tile** starts editing it — this is the flow the pane
      was missing entirely
- [ ] A single click only selects; it does not open
- [ ] Every tile shows its **duration** in the corner of the poster
- [ ] **Hovering a tile** shows its name, duration, dimensions, size and the
      date it was created
- [ ] A file ffprobe cannot read still gets a tooltip with name, size and date
- [ ] Typing in the search box narrows the list, and the count says "n of m"
- [ ] Clicking a folder narrows to it; **All videos** goes back
- [ ] **Browse** in the header returns to the list with a video open
- [ ] Nothing in the empty pane shows a black box, a timecode, or a version
      string long enough to push the header apart
- [ ] Right-click a video in the file explorer → **Open in Video Editor**
- [ ] Right-click a video tile in the **Media Viewer grid** → the same item is
      there. This is the integration, and it is one event listener
- [ ] The header names the size, frame rate and length, and the ffmpeg badge is
      green
- [ ] A 60-minute file opens as fast as a short one

### Transport

- [ ] `Space` plays and pauses; playing runs to the out point and stops there
- [ ] `,` and `.` step exactly one frame — check against the readout
- [ ] `Shift+.` speeds up; the toolbar button shows the rate

### Timeline

- [ ] The filmstrip draws, and draws the **same number of stills** for a
      60-minute file as for a short one
- [ ] Dragging a handle past the other swaps them
- [ ] Dragging a handle and moving the cursor off the strip keeps tracking
- [ ] Clicking the strip moves the playhead and leaves the selection alone

### Cutting

- [ ] Trim a 30-second selection out of a 60-minute file with **stream copy**.
      It should finish in seconds
- [ ] The output plays, and its length matches the selection
- [ ] Trim the same selection with **re-encode**. Progress climbs, the estimate
      is roughly right, and **Cancel** stops it
- [ ] A cancelled job leaves no partial file selected and no job stuck running
- [ ] Extract audio; the m4a plays

### Arranging

- [ ] Add three clips, reorder two by dragging, export
- [ ] The exported file plays through all three in the order shown
- [ ] Export clips from **two different recordings** with stream copy. If it
      fails, the message should name Re-encode as the fix — then switch and
      confirm it works

### The media handoff

- [ ] Right-click `assets/board.canvas` → **Write a media handoff**
- [ ] `assets/board.handoff.json` appears beside it
- [ ] The shots are in the order the arrows imply, not the order the canvas
      file happens to list them
- [ ] The captured frames name the video and the second they came from
- [ ] The video is **not** reported as a zero-length clip — Schema Sync fills
      records with `sourceStart: 0`, and reading that literally was a real bug
- [ ] `problems` names anything on the board with no record behind it

### Records

- [ ] One trim produces **two** notes: one for the clip, one for the source
- [ ] The clip's note names the video and the seconds — `source:`,
      `sourceStart`, `sourceEnd`
- [ ] Opening a video and scrubbing it writes **nothing**
- [ ] Move the clip's note to another folder and rename it by hand; the pane
      still finds it
- [ ] Set `useCase:` on the source's note; a frame captured from the clip in
      Media Viewer resolves that use case up the chain
- [ ] Write prose under the notes marker, trim again, and confirm it survived

### Failure

- [ ] Point the ffmpeg path at something that is not ffmpeg; the pane says so
      and refuses jobs rather than throwing
- [ ] Open a corrupt or unsupported file; the pane opens and says ffprobe could
      not read it
- [ ] Close Obsidian mid-export; no ffmpeg process is left running

### Performance, on real footage

Measured by `tests/smoke.js` against a synthetic 60-minute 320×240 file with a
two-second keyframe interval, on the development machine. Real footage is
larger and will be slower, but the shape should hold — and the first row is the
one the design was built around.

| What | Measured |
| --- | --- |
| Stream-copy trim, 30s taken **50 minutes into** a 60-minute file | **90 ms** |
| Re-encode trim, same span, `ultrafast` CRF 28 | ~1 s |
| Filmstrip, 10 stills across a 60-minute file | ~650 ms |
| Stream-copy accuracy | 30.02 s for a 30 s request — one keyframe of rounding |
| Re-encode accuracy | 30.018 s — frame-exact, as bought |

The 90 ms is the whole argument for `-ss` before `-i`. With the seek after the
input, ffmpeg decodes fifty minutes and discards them.

Still needs a person, on real footage:

- [ ] A real 60-minute screen recording, stream-copy trim — record the seconds:
- [ ] The same file, re-encode — record the minutes:
- [ ] The pane stays responsive while the strip is still filling in
- [ ] A trimmed clip opened in a player starts on the frame you meant

---

## Beyond this build

The design doc's longer aim is an editor driven as much by an **MCP** as by
hand, and nothing here should make that harder. Two things are already true of
it:

- Every record is an ordinary vault note, so a server can read the clip list,
  group the evidence and call ffmpeg without this plugin being open.
- Every argument list is a pure function in `core`. An MCP that wanted to cut
  the same way would import them rather than re-deriving them.

Not built, and deliberately:

- **Transitions, titles, filters.** Each turns every export into a re-encode,
  and the point of this is that most exports are not.
- **A multi-track timeline.** One video track and its own audio is what a
  walkthrough is. A second track is a different product.
- **Waveforms.** They need a full decode of the audio, which on an hour of
  footage costs more than the strip and answers a question nobody asked here.
