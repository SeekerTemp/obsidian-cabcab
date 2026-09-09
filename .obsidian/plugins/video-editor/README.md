# Video Editor

Trim, split, arrange and export vault video, and record every cut as a
`MediaInstance` note so a clip can always say which walkthrough it came from
and which seconds it covers.

It is the second half of the evidence flow Media Viewer starts. Media Viewer
captures a frame and labels it; this cuts the footage that frame was taken
from. Both write the same record type, so a frame captured out of a clip
trimmed here resolves up one chain to the original recording.

## What it needs

**ffmpeg and ffprobe.** A browser page cannot cut video: canvas yields frames
and `MediaRecorder` re-encodes badly, while lossless trimming is demux and
remux. The plugin is `isDesktopOnly: true` and drives a native binary through
`child_process`.

They do not have to be *installed*. ffmpeg ships as a self-contained static
executable, so the simplest complete install is to put `ffmpeg` and `ffprobe`
in this plugin's own `bin/` folder — no admin rights, nothing on `PATH`. That
is how this vault has it, and one command does it:

```bash
node scripts/fetch-ffmpeg.js
```

**On a fresh clone that command is the whole setup.** `bin/` is git-ignored, so
a pull arrives with it empty — see [docs/SETUP.md](docs/SETUP.md) for what does
and does not travel with the repo.

The plugin looks in three places, in order:

1. A full path set in the plugin's settings
2. `bin/` beside `main.js`
3. Whatever `PATH` has

Settings reports which of the three it settled on, **for each binary
separately** — half an install is a real state, and from the red badge it looks
identical to no install at all. The header badge names the version when one is
found, and **Check now** re-looks after you change anything.

If you would rather install system-wide: `winget install Gyan.FFmpeg` on
Windows, `brew install ffmpeg` on macOS, your package manager on Linux.

`bin/` is git-ignored. The two executables are about 290 MB together, this
vault is the repository, and they are platform-specific anyway — a vault synced
between a Mac and a Windows machine wants a different pair on each.

## Opening a video

Open the pane — the ribbon scissors icon, or **Open the video editor** in the
command palette — and it shows **the videos in your vault**. Folders that hold
one are listed down the side with counts, there is a search box, and every tile
carries a still taken from the file. **Double-click a tile to start editing
it.**

That is the way in. The empty state is the browser, because a pane whose empty
state tells you to go and use a different pane is a pane you cannot open.

The other ways in still work and are quicker when you already know the file:

- Right-click a video in the file explorer — or in the **Media Viewer grid**,
  which offers Obsidian's own file menu — and choose **Open in Video Editor**.
- **Open the active file in the video editor** in the command palette.

**Browse** in the header goes back to the list once something is open.

## The pane

A stage with a floating toolbar over it, a timeline beneath, and the clip list
to one side. In a narrow split the clip list moves under the stage and the
toolbar drops its labels; the pane reflows on **its own** width, not the
window's.

### Keys

| Key | What it does |
| --- | --- |
| `Space` | Play or pause. Playing outside the selection restarts at the in point |
| `←` `→` | Seek five seconds |
| `,` `.` | Step one frame, at the rate ffprobe reported |
| `Shift+,` `Shift+.` | Playback speed, 0.25×–4× |
| `I` `O` | Set the in or out point to the playhead |
| `S` | Split the selection at the playhead |
| `C` | Add the selection to the clip list |

Keys are listened for on the pane, not globally — otherwise `Space` would stop
being a space bar everywhere else in the vault.

### The timeline

Drag either handle to move an in or out point, drag anywhere else to scrub.
Dragging one handle past the other swaps them rather than refusing the drag.
What is excluded is dimmed rather than hidden, because you have to see what you
are leaving out to know you left out the right thing.

The filmstrip is a **fixed number of stills spread across the width**, not one
per second. That is what makes a 60-minute file usable: the strip costs the
same as it does for a ten-second clip. Turn it off, or change the cap, in
settings.

## Cutting

**Trim to file** writes the selection as a new file beside the source (or into
the output folder, if you set one), named `<stem>+trim+<timestamp>.<ext>`.

**Add clip** puts the selection on the list. **Export** joins the list into one
file, named `<stem>+cut+<timestamp>.<ext>`. Rows reorder by dragging, and
clicking a row moves the selection back to it.

**Split** cuts the selection at the playhead and adds both halves as clips.

Extracting audio writes `<stem>+audio+<timestamp>.m4a`.

The timestamp is in the name only so two cuts of one video are told apart at a
glance. Nothing reads it back — where a clip came from lives in its record,
which is the thing that survives a rename.

### Stream copy or re-encode

| | Stream copy | Re-encode |
| --- | --- | --- |
| Speed | Seconds, on an hour of footage | Real time, roughly |
| Quality | Lossless — the bytes are the same bytes | One generation of x264 |
| Accuracy | Starts on the nearest keyframe before the cut | Frame-exact |
| Joining mixed sources | Only when their streams match | Always |

Copy is the default and is right for most cuts. Switch to re-encode when the
cut has to land on an exact frame, or when a join of clips from different
recordings fails — the failure says so in those words rather than in ffmpeg's.

Every job shows a percentage, an estimate of what is left, and a **Cancel**
button. Cancelling kills the process; closing Obsidian kills anything still
running, so an hour-long encode does not outlive the plugin that started it.

## What it records

Every derived file gets a `MediaInstance` note, and its source gets a root note
if it did not have one — otherwise the child's `source:` would dangle the
moment anyone looked.

```yaml
---
implements: MediaInstance
media: "[[data/media/walk+trim+260909140503.mp4]]"
source: "[[data/media/walk.mp4]]"
op: trim
sourceStart: 718.25
sourceEnd: 800.5
created: 2026-09-09T14:05:03Z
status: edited
---
```

A join names its first piece as `source:` so the chain still resolves, and puts
the whole recipe in `clips:`:

```yaml
op: cut
clips: ["data/walk.mp4 00:11:58.000-00:13:20.500", "data/login.mp4 00:00:31.000-00:00:53.400"]
```

Three rules this shares with Media Viewer, and they are the ones easy to break:

- **A note is found through `metadataCache`, by the `media:` link it declares —
  never by its filename.** Move a note or rename it by hand and it keeps
  working.
- **A field a child does not declare is resolved by walking up `source:` at
  read time.** `sourceStart`, `sourceEnd` and `clips` are intrinsic and never
  inherited, for the same reason a crop rectangle is not: they say where *this*
  file was cut from.
- **Opening a video writes nothing.** A record exists because someone cut
  something.

`useCase`, `shows` and `labels` are Media Viewer's to set and are inherited
down the chain, so a clip labelled once carries that label to every frame
captured out of it.

## Layout of the code

No build step, no npm, no `package.json` — `main.js` is what Obsidian loads.
Reload Obsidian to see a change.

`main.js` opens with a block of pure functions exported as
`module.exports.core`: path building, timecode parsing, range maths, **ffmpeg
argument construction**, ffprobe and progress parsing, export planning and note
rendering. Everything below the "End of core" banner touches Obsidian, a
filesystem or a child process.

That split is the testing strategy. The thing hardest to test by running it — a
native binary over a 60-minute file — is easy to test by reading the arguments
before they are sent. Anything worth testing belongs in `core`.

Classes below the banner, in dependency order: `FfmpegRunner`, `Filmstrip`,
`TrimSession`, `LineageStore`, `ExportRunner`, `VideoEditorView`,
`VideoEditorSettingTab`, `VideoEditorPlugin`.

## Tests

**`tests/` is git-ignored and not in the repository** — what has to work on
another machine is the plugin, not the harness, and Obsidian loads `main.js`
and nothing else. On a machine that has them:

```bash
node tests/all.js            # every suite, each in its own process
node tests/ffmpeg.test.js    # one suite — every test file runs directly
node tests/smoke.js          # end-to-end against a real ffmpeg
```

Plain node, a hand-written harness, no framework — the same shape as Media
Viewer and Schema Sync. `tests/load-plugin.js` loads `main.js` with
`require("obsidian")` redirected to a stub; `tests/stub-dom.js` supplies enough
DOM; `tests/fake-vault.js` a vault; and the ffmpeg suites a fake child process,
so **nothing in `all.js` needs a real binary to run**.

`smoke.js` is the other half, and is not in `all.js` on purpose: it needs
ffmpeg and takes a couple of minutes, because it builds a 60-minute video and
cuts it. A fake child process will happily accept an argument list real ffmpeg
rejects, so every "the arguments say X" assertion is only worth as much as the
claim that X is what ffmpeg does. That is what this checks.

## Known edges

- A stream-copy cut starts on the nearest keyframe *before* the in point, so a
  clip can begin up to a group-of-pictures early. That is inherent to copying,
  not a bug; re-encode is the answer when it matters.
- ffmpeg writes into the vault folder directly rather than through
  `vault.createBinary`, because an hour-long export is measured in gigabytes
  and buffering one through memory to hand it back to the same disk is how a
  machine falls over. The pane waits for Obsidian's watcher to notice; if it
  has not within twenty seconds the file is still there, it just cannot be
  selected yet.
- Joining clips from several recordings with stream copy only works when their
  streams match. The error names the setting that fixes it.
