# Obsidian Media Viewer

### Problems
1. Zoom above 100% cause image distorded this bug still remain since the python. The new board.cavas view fixed this, you should take canvas logic. If zoom >100% should swap to canvas view
2. Old UI UX written by python suck, you should demo .html first, only reuse the layout. Currently Reponsive is fine to keep
3. Add button Create Schema'record. -> Quick create a record for currently selected image based on schema from select list.(This must be a schema sync feature, Apply to all type of file -> bind as attachment file with root\path\file.extension)
# Obsidian Video Editor

### Problems
1. Add hover tool tip to view video infor like durations, name, date created.
---

## Install — Video Editor environment

Everything, from nothing, on a machine with **git** and **node**. No npm, no
build step, no admin rights.

```bash
# 1. Get the vault
git clone -b feature/media-viewer https://github.com/SeekerTemp/obsidian-cabcab.git
cd obsidian-cabcab

# 2. ffmpeg + ffprobe into the plugin's own bin/   (~1 min, ~290 MB)
cd .obsidian/plugins/video-editor
node scripts/fetch-ffmpeg.js
cd ../../..

# 3. Open the folder as a vault in Obsidian, then reload it
#    Both plugins are already enabled in .obsidian/community-plugins.json
```

Already have the vault — only step 2 matters:

```bash
cd <vault>/.obsidian/plugins/video-editor
node scripts/fetch-ffmpeg.js
```

macOS instead of step 2 (no build worth fetching blind):

```bash
brew install ffmpeg
cp "$(which ffmpeg)" "$(which ffprobe)" <vault>/.obsidian/plugins/video-editor/bin/
```

Or install system-wide and skip step 2 entirely — `winget install Gyan.FFmpeg`,
`sudo apt install ffmpeg`, `brew install ffmpeg`.

**Check it worked, in the app:** the header badge turns green and names a
version; **Settings → Video Editor → Where it is looking** names the exact path
per binary; and the browser tiles show stills with durations rather than blank
grey rectangles.

**Why step 2 exists.** ffmpeg is a self-contained static executable, so the two
files in `bin/` are a complete install. `bin/` is git-ignored because it is
290 MB, this vault *is* the git repository, and the binaries are
platform-specific. The plugin looks in three places in order: a path set in
settings, then `bin/`, then `PATH` — any one of them satisfies it.

**Media Viewer needs none of this.** Pull, reload, done.

Full detail: [`.obsidian/plugins/video-editor/docs/SETUP.md`](.obsidian/plugins/video-editor/docs/SETUP.md)
