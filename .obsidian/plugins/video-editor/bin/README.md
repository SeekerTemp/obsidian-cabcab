# bin

Put `ffmpeg` and `ffprobe` here and the plugin finds them — no install, no
admin rights, nothing on `PATH`.

On Windows that means `ffmpeg.exe` and `ffprobe.exe`; elsewhere the same names
without the extension. The plugin looks in this order:

1. A full path set in the plugin's settings
2. This folder
3. Whatever `PATH` has

Settings shows which of the three it settled on, for each binary separately —
half an install is a real state, and it looks the same from the red badge as no
install at all.

**This folder is git-ignored.** The two executables are about 170 MB and this
vault is the repository. They are also platform-specific, so a vault synced
between a Mac and a Windows machine wants a different pair on each and cannot
usefully carry both.

Windows builds: <https://www.gyan.dev/ffmpeg/builds/> — the "essentials" release
is enough. macOS: `brew install ffmpeg`, or copy the binaries here from
wherever brew put them.
