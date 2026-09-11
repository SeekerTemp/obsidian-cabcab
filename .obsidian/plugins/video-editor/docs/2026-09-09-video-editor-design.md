# Video Editor — design

> Written 2026-09-09, when video trimming came back off Media Viewer's **Out**
> list. That design doc's "Beyond this build" section predicted this work and
> two things about it: that a browser page cannot cut video, so it means
> ffmpeg; and that the MCP which will eventually drive it does not need a
> plugin API, because every record is an ordinary vault note. Both held, and
> both shaped what is below.

## Why a second plugin

The choice was between adding trimming to Media Viewer and building it beside
it. Trimming wants everything Media Viewer already has — the lineage store, the
`MediaInstance` note, the derived-path builders, selection that follows a save —
and a trim really is a crop in the time dimension.

What decided it the other way is what trimming wants that Media Viewer does
not, and would rather not have:

- a native binary, found or not found on the machine
- `child_process`, a long-running job, a progress bar and a cancel button
- a job that can run for minutes and must not outlive the app

Media Viewer is a browser-only pane over the vault's own APIs. Putting a
process manager inside it would make every one of its 700 tests share a module
that spawns processes, and would put "is ffmpeg installed" in the failure path
of looking at a PNG. Two plugins, one record format.

The cost is duplication: eight path helpers, the YAML writer and the note
renderer exist twice. A shared file was considered and rejected — with no build
step it means one plugin reaching into the other's folder, which is a load-order
dependency that breaks the moment a user disables one of them. Duplicating
sixty lines of string handling is the cheaper of the two costs, and the thing
that must not diverge is the *format*, which lives in
`data/schema/MediaInstance.schema.md` rather than in either plugin.

### The integration is one event listener

Media Viewer's grid triggers Obsidian's own `file-menu` for the tile under the
cursor (`media-viewer/main.js:4604`, from `MV-EXPLORER`). So listening for
`file-menu` puts **Open in Video Editor** into the Media Viewer grid *and* the
file explorer, without either plugin knowing the other exists. That is the
whole seam, and it is the argument for the split rather than against it.

## Scope

**In.** Playback with in/out points, frame-stepping, a filmstrip timeline,
trim, split, a clip list you can reorder, export by concatenation, audio
extraction, and a `MediaInstance` record for everything written.

**Out.** Transitions, titles, filters, a second track, waveforms, and anything
else that turns every export into a re-encode. The reason most exports are fast
is that most exports are a copy.

## The thing the design is actually about: 60 minutes

The requirement is a 60-minute walkthrough, and nearly every decision here is
that requirement.

**Seeking before the input.** `-ss` after `-i` makes ffmpeg decode the whole
file and throw away everything before the cut. On an hour of footage that is
the difference between two seconds and several minutes. `-ss` before `-i` seeks
the container, and has been accurate for re-encodes since ffmpeg 2.1, so the
only cost is the keyframe rounding a stream copy has anyway.

**A duration, not an end time.** With input seeking, what `-to` is measured
from has changed between ffmpeg releases. `-t` has not.

**The filmstrip count comes from the pane's width.** One thumbnail per second
is 3,600 ffmpeg invocations. The strip is a fixed number of stills spread
across the width, so it costs the same for an hour as for ten seconds — which
is the only way the hour is usable at all. Stills are piped as JPEG rather than
written, because 24 throwaway files per resize is 24 files to create, read and
delete.

**Stills are generated one at a time.** Twenty-four concurrent ffmpeg processes
seek the same disk; the set finishes later than sequentially would, while
making the machine unusable meanwhile.

**Nothing is buffered through memory.** ffmpeg writes straight into the vault
folder rather than being read back and handed to `vault.createBinary`. An
hour-long export is gigabytes, and passing that through the renderer to give it
back to the same disk is how a machine falls over. The cost is that the vault
finds out through its watcher, so the pane waits — and if the watcher is slow,
the export still succeeded and simply cannot be selected yet. Failing an export
over a watcher's timing would be failing over nothing.

**Progress, an estimate and a cancel.** A job that may run for minutes needs
all three. Progress is `-progress pipe:1` on stdout, which also keeps stderr
free of everything except errors, so the error summary does not have to filter
a thousand status lines out of it. The estimate comes from ffmpeg's own
`speed=`, and is deliberately coarse: an ETA that ticks every second reads as
precision it does not have.

## Copy versus re-encode

Offered as a setting rather than chosen, because neither is right for every
cut.

Stream copy is a demux and a remux: lossless, seconds on an hour, and only able
to start on a keyframe — so a clip can begin up to a group-of-pictures early.
Re-encode is frame-exact and costs real time.

Two consequences worth writing down:

- On a copy, an output keeps the **source's container**. On a re-encode it
  takes mp4, because at that point every piece really is the same thing.
- A join of clips from different recordings can only be copied when their
  streams match. ffmpeg says so in codec terms that do not name the fix, so the
  plugin says it in the words that do: *switch Output to Re-encode*.

## Export is two passes, not one filter graph

Each clip is trimmed to a temp file, then the concat **demuxer** joins them. A
filter graph (`concat` filter) would re-encode everything, including the clips
that needed nothing. The demuxer is a copy — seconds on an hour of footage.

The join is always a copy, even when the setting says re-encode, because the
pieces were produced by the pass above and re-encoding them again is a second
generation of loss for nothing.

A single-clip export skips the temp files and the join entirely: it is a trim
wearing a different hat, and it writes the same record either way.

## What gets recorded

Three fields were added to `MediaInstance`:

| Field | Why |
| --- | --- |
| `sourceStart` | Where the clip begins in its source. `sourceTime` was a moment; a trim is a span |
| `sourceEnd` | Where it ends |
| `clips` | A join's recipe, one line per piece. `source:` holds exactly one file and a concatenation has more than one |

All three are **intrinsic** — never inherited down the chain — for the same
reason a crop rectangle is not: they say where *this* file was cut from. A
frame captured out of a trimmed clip begins somewhere else entirely, and
inheriting the clip's `sourceStart` would have it claim a second it does not
begin at. Media Viewer's intrinsic list was extended to match, which is the one
change this work made outside its own folder.

`source:` on a join names the **first** piece, so the chain still resolves to
something rather than dangling. `clips:` says the rest of the truth, in a form
a person or a model can read without either plugin.

A root record is written for the source when it has none. Without it, the
child's `source:` dangles the moment anyone looks. An existing record is the
user's and is left alone — a trim is no reason to rewrite it.

## The pane

Demoed as `docs/layout.html` first and the layout reused, which is this vault's
rule for new UI. The one piece that is preference rather than deduction is the
**floating toolbar over the stage**: it keeps the stage's height and puts the
controls where the eye already is. It is also, deliberately, the Editing
Toolbar look.

Everything else follows from the content. The clip list sits beside the stage
because it is a list of decisions you compare, and moves under it in a narrow
pane rather than being squeezed. The pane reflows on a **container query**, not
a media query: this pane can be a narrow split in a maximised window or a wide
one in a small window, and the window cannot tell those apart.

Keys are bound on the pane rather than as global hotkeys. A global `Space`
would take the space bar away from every note in the vault.

## Testing

The `core` block is the contract, and it holds every ffmpeg argument list.
That is the point: the thing hardest to test by running it — a native binary
over an hour of footage — is easiest to test by reading what it was going to be
told. 228 tests run under plain node with no ffmpeg present.

What the harness cannot see: whether the output plays, whether a copy landed on
the keyframe it should have, how long an hour-long re-encode really takes, and
whether Obsidian's watcher notices a gigabyte in time. Those are the acceptance
checklist in `HANDOFF.md`, and they need a person.

Three bugs the tests found while being written, recorded because each was a
silent wrong answer rather than a crash:

- `Number(null)` is `0`, so an audio-only file — or any container that declares
  no duration — reported a confident duration of zero.
- A range clamped to the end of a file lands a float-epsilon under the minimum
  length, so a clip taken at the very end of a walkthrough was silently dropped
  as too short. That is exactly where a walkthrough's last click tends to be.
- The one-job-at-a-time guard was set *after* an `await`, so two clicks in the
  same moment both got past it and two ffmpeg processes wrote two files.

## Open risks

- Keyframe rounding on a stream copy is invisible until someone checks a cut
  against the frame they meant. The pane names the trade in settings, but does
  not show where the keyframes are. Showing them would need a full index pass
  over the file, which on an hour of footage is its own cost.
- The vault-settle wait is a poll with a twenty-second cap. It has no way to
  distinguish "the watcher is slow" from "the write failed after ffmpeg exited
  zero", and reports the optimistic reading of both.
- Temp files for an export live in the system temp folder and are cleared in a
  `finally`. A process killed outright — not cancelled, killed — leaves them.
- Cancellation is polled every 120 ms rather than pushed. The alternative is
  handing every caller a kill function to hold and remember to drop, and a box
  with a boolean in it is the thing that is actually easy to get right.
