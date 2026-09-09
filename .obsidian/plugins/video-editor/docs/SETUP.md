# Running these plugins on another machine

Short answer: **Media Viewer works the moment you pull. Video Editor needs one
command first**, because the thing it drives is a 290 MB native binary that has
no business being in a git repository.

## What a clone actually gets

Both plugins are plain JavaScript with **no build step, no npm, and no
`package.json`**. `main.js` is what Obsidian loads. There is nothing to
install, compile or bundle. Node is not needed to *use* either plugin — only to
run the one setup command below, and Obsidian itself does not care whether node
is on the machine at all.

| | Travels with the repo | Does not |
| --- | --- | --- |
| Plugin code (`main.js`, `styles.css`, `manifest.json`) | ✅ | |
| Which plugins are enabled (`.obsidian/community-plugins.json`) | ✅ | |
| The `MediaInstance` schema and its Bases | ✅ | |
| Lineage records in `data/media/` | ✅ | |
| Plugin settings (`data.json`) | | ❌ git-ignored, per machine |
| ffmpeg and ffprobe (`video-editor/bin/`) | | ❌ git-ignored, 290 MB, platform-specific |
| The media itself (`assets/*.mp4`) | | ❌ never committed |

Settings being per-machine is deliberate rather than an oversight: the one
setting that matters most is a path to a binary, and that path is different on
every machine anyway.

## Media Viewer

Nothing to do. Pull, enable it if it is not already, reload.

`isDesktopOnly: true` — touch drag-cropping is poor, large decodes exhaust
mobile memory, and iOS restricts video-to-canvas capture. It will not appear on
a phone or tablet.

## Video Editor

It drives a native ffmpeg through `child_process`, because a browser page
cannot cut video: canvas yields frames, `MediaRecorder` re-encodes badly, and
lossless trimming is demux and remux.

A fresh clone has an **empty `bin/`** — only its README. Fill it:

```bash
cd .obsidian/plugins/video-editor
node scripts/fetch-ffmpeg.js
```

That downloads the right build for the machine, extracts it, and puts
`ffmpeg` and `ffprobe` in `bin/`. It takes about a minute and needs no npm, no
admin rights, and nothing on `PATH`.

Then reload Obsidian. The header badge turns green and names the version.

### If you would rather not

The plugin looks in three places, in order, and any of them satisfies it:

1. A full path set in the plugin's settings
2. `bin/` beside `main.js`
3. Whatever `PATH` has

So `winget install Gyan.FFmpeg`, `brew install ffmpeg`, or your package manager
all work just as well. Settings reports which of the three it settled on, **for
each binary separately** — half an install is a real state, and from the red
badge it looks the same as no install at all.

### Platform notes

| Platform | `node scripts/fetch-ffmpeg.js` | Notes |
| --- | --- | --- |
| Windows x64 | ✅ | Extracts with `System32\tar.exe`; Git Bash's GNU tar cannot read a zip |
| Linux x64 / arm64 | ✅ | `.tar.xz`, any tar reads it |
| macOS | ❌ | No single build worth trusting to fetch blind. `brew install ffmpeg`, then leave it on `PATH` or copy the two binaries into `bin/` |

The builds fetched are BtbN's **GPL** ones on purpose. The LGPL builds omit
`libx264`, which the re-encode path asks for by name — so an LGPL build would
install cleanly and then fail the first frame-exact cut.

The binaries are platform-specific, which is the other reason `bin/` is
git-ignored: a vault synced between a Mac and a Windows machine wants a
different pair on each and cannot usefully carry both.

## Checking it worked

All of it is in the app, because that is where it matters:

1. **The header badge** turns green and names the version. Red means nothing
   was found anywhere.
2. **Settings → Video Editor → Where it is looking** names the exact path each
   binary resolved to, and which of the three places it came from. It reports
   ffmpeg and ffprobe separately, because half an install is a real state and
   looks identical to none from the badge alone.
3. **Open the Video Editor.** The browser should list the vault's videos with a
   still on each tile. The stills come from ffmpeg, so blank grey rectangles
   mean the binary is not being found.
4. **Trim something short.** A few seconds with the default stream copy should
   finish almost instantly and produce a file beside the source, plus a
   `MediaInstance` note in `data/media/`.

### A note on the test suites

They are not in the repository — `tests/` is git-ignored, because what has to
work on a new machine is the plugin, not the harness. They exist on the machine
the work was done on, and none of them is needed to run either plugin: Obsidian
loads `main.js` and nothing else.

If you do want them on another machine, they can be un-ignored again with one
line in `.gitignore`.
