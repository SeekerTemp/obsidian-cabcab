# Running these plugins on another machine

Short answer: **Media Viewer works the moment you pull. Video Editor needs one
command first**, because the thing it drives is a 290 MB native binary that has
no business being in a git repository.

## What a clone actually gets

Both plugins are plain JavaScript with **no build step, no npm, and no
`package.json`**. `main.js` is what Obsidian loads. There is nothing to
install, compile or bundle, and node is needed only to run the tests — not to
use the plugins.

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

```bash
node tests/all.js     # 276 tests, needs no ffmpeg at all
node tests/smoke.js   # 29 more, against the real binary
```

`smoke.js` builds a 60-minute video and cuts it, so it takes a couple of
minutes. It prints which of the three places the binary came from, which is the
fastest way to confirm the `bin/` folder is being found:

```
found via: bundled — .../plugins/video-editor/bin/ffmpeg.exe
```

If it says `Skipped: nothing to test against`, the fetch has not run.

In the app itself: open the Video Editor, and the browser should list the
vault's videos with a still on each tile. Stills come from ffmpeg, so if the
tiles are blank grey rectangles the binary is not being found — check the
header badge and the **Where it is looking** row in settings.
