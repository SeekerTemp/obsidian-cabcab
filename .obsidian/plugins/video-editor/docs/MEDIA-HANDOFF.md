# media-handoff/1

A JSON description of a video to be made, written from an Obsidian canvas.

The canvas is where a person arranges the evidence and says what it means. This
is that arrangement in a form something else can act on — an MCP driving CapCut,
a script driving ffmpeg, a model asked to write the narration. The point is that
**the plan and the provenance travel together**: every shot says which file it
is, which recording it came from, and which second of it, so the thing consuming
this can explain its own output.

Nothing in the format is specific to CapCut. It describes *what to show and in
what order*, not how to render it.

## Where it comes from

Three inputs, all already in the vault:

| Input | Gives |
| --- | --- |
| `*.canvas` | which files, how they connect, and what the arrows say |
| `MediaInstance` records | which recording each file came from, and which seconds |
| ffprobe (optional) | how long each video actually is |

The canvas carries intent. The records carry provenance. Neither is invented
here — this reads both and joins them.

## The shape

```json
{
  "protocol": "media-handoff/1",
  "generatedAt": "2026-09-10T09:12:00Z",
  "board": "assets/board.canvas",
  "vaultBase": "D:/1_doc/MyVault_imagePlugins/obsidian-cabcab",
  "totalSeconds": 94.25,
  "shots": [ /* see below */ ],
  "context": [ /* notes and text nodes */ ],
  "edges": [ { "from": "nodeId", "to": "nodeId", "label": "Dog hands" } ],
  "problems": [ "assets/gone.mp4 is on the board but not in the vault" ]
}
```

### A shot

```json
{
  "node": "4fe7ddbd",
  "order": 4,
  "kind": "video",
  "file": "assets/2025-12-23 16-56-17.mp4",
  "absolute": "D:/.../assets/2025-12-23 16-56-17.mp4",
  "exists": true,

  "source": "assets/2025-12-23 16-56-17.mp4",
  "start": null,
  "end": null,
  "sourceTime": null,
  "duration": 35.2,
  "hold": null,

  "captions": [
    "The dog tryin to import a Board plan to visualize plan.",
    "Yes the mere touch of this hand improve the envidence's credit"
  ],
  "leadsTo": ["00a26e4f", "f42890b8"],
  "evidence": { "useCase": "Checkout", "shows": null, "status": "reviewed", "labels": [] }
}
```

| Field | Meaning |
| --- | --- |
| `node` | The canvas node id. **This is the identity, not `file`** — see below |
| `order` | 1-based position in the sequence |
| `kind` | `video`, `image` or `audio` |
| `file` | Vault path |
| `absolute` | Filesystem path, for something that has never heard of a vault |
| `exists` | Whether the vault currently holds it |
| `source` | The recording it descends from, resolved through `source:` links |
| `start`, `end` | Seconds into `source`, for a clip cut out of it. `null` on a whole file |
| `sourceTime` | Seconds into `source`, for a single captured frame |
| `duration` | Seconds of footage. Filled from ffprobe when it was available |
| `hold` | How long to show a still. `null` on anything with a duration |
| `captions` | The labels on arrows arriving at this node, in board order |
| `leadsTo` | Node ids this one points at, so the graph survives the flattening |
| `evidence` | `useCase`, `shows`, `status`, `labels` — resolved up the `source:` chain |

### Context

Markdown and text nodes are not footage. They are carried separately so nothing
is lost, and a note that is a `MediaInstance` record says which file it is about:

```json
{ "node": "aadce491", "kind": "note", "file": "data/media/2025-12-23 16-56-17.md",
  "describes": "assets/2025-12-23 16-56-17.mp4", "text": null }
```

A plain text node carries `text` and no `file`.

## Rules

**Order comes from the arrows, then from the board.** A canvas is a graph and a
video is a list, so the arrows are followed first: a node never appears before
one that points at it. Nodes with nothing to separate them fall back to reading
order — top to bottom, then left to right. A cycle is reported in `problems` and
its members are ordered by position rather than dropped, because a cycle is a
mistake in the drawing and refusing to emit anything is not a useful answer to
it.

**The node is the identity, not the file.** The same frame can sit on the board
twice, meaning "show this again", and it does on the board this was written
against. Keying on the path would silently merge them.

**Arrow labels become captions.** They are what the person said about the
connection, which is the closest thing on a canvas to narration. A shot with two
arrows arriving gets both, ordered the way the board orders their sources.

**Provenance is resolved, never invented.** `source`, `start`, `end` and
`sourceTime` come from `MediaInstance` records. A file with no record gets nulls
and a line in `problems` — it is on the board without anything saying where it
came from, which is worth knowing before a model narrates over it.

**`evidence` is inherited.** `useCase`, `shows`, `status` and `labels` are
resolved by walking up `source:` to the first ancestor that declares them, which
is the whole reason for the lineage: labelling a recording once labels every
frame cut out of it.

**Missing files are reported, not omitted.** A shot whose file has gone still
appears, with `exists: false`. Dropping it would make the plan quietly shorter
than the board.

**Durations are best-effort.** `duration` is filled by probing when ffmpeg is
available and is `null` otherwise. A consumer that needs real durations should
probe the `absolute` paths itself rather than trust a null to mean zero.

## Writing one

In Obsidian: **Write a media handoff from a board** in the command palette. It
writes `<board>.handoff.json` beside the canvas.

Everything above the "End of core" banner in `main.js` builds this, so it is
also reachable without the plugin:

```js
const { core } = require(".obsidian/plugins/video-editor/main.js");
const handoff = core.boardHandoff(canvasJsonText, {
  board: "assets/board.canvas",
  lookup: (vaultPath) => recordFor(vaultPath),   // MediaInstance, or null
  absoluteOf: (vaultPath) => "/vault/" + vaultPath,
  exists: (vaultPath) => true,
});
```

`lookup` is the only interesting one: hand it something that returns a record
for a media path and the chain resolves. Hand it `() => null` and you still get
an ordered shot list, just without provenance.

## What it deliberately does not say

- **Transitions, effects, music, titles.** Those are the editor's vocabulary,
  not the board's, and inventing them here would mean guessing.
- **Aspect ratio and resolution.** A consumer knows its own target better than
  this does.
- **Where a shot should be trimmed to.** If a clip needs cutting, cut it in the
  Video Editor — the trim gets a record, and the record is what shows up here.

The version is in `protocol`. A change that removes or repurposes a field gets a
new number; adding one does not.
