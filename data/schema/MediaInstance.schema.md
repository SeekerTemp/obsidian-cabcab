---
schema: MediaInstance
fields:
  - media:
      type: attachment
      required: true
  - source:
      type: attachment
  - op:
      type: string
  - crop:
      type: object
  - transform:
      type: object
  - width:
      type: number
  - height:
      type: number
  - created:
      type: string
  - status:
      type: string
  - labels:
      type: array
---

# MediaInstance Schema

Defines the base fields for any MediaInstance note.

One record per media file the Media Viewer has acted on: where the file came
from, what was done to it, and anything you want to say about it. There is one
note type rather than two — a root asset simply declares no `source:`, so
lineage is a chain of the same thing rather than two formats meeting in the
middle, and a root that later turns out to have a parent needs no migration.

`media:` is the authoritative pairing and the only one. Nothing infers a
pairing from a filename, so a note that is moved or renamed by hand keeps
working. `crop` is stored in oriented-source pixels — the space the crop
overlay works in and the space the user drew it in — so the derivation is
reproducible rather than merely descriptive.

A note exists because someone acted on the file. Viewing writes nothing, so the
presence of a record is itself the signal that a file has been dealt with, and
its absence marks everything still untouched.

## Field Reference

| Field | Type | Default | Required | Bound | Relation |
| --- | --- | --- | --- | --- | --- |
| media | attachment | - | yes | yes | - |
| source | attachment | - | no | yes | - |
| op | string | - | no | yes | - |
| crop | object | - | no | yes | - |
| transform | object | - | no | yes | - |
| width | number | - | no | yes | - |
| height | number | - | no | yes | - |
| created | string | - | no | yes | - |
| status | string | - | no | yes | - |
| labels | array | - | no | yes | - |

<!-- schema-sync:notes -->

_Anything you write below this marker is preserved across syncs._

**Nothing below this line may be a markdown table.** Schema Sync's
bottom-to-top pull reads table rows as field definitions, and it does not stop
at the notes marker — a second table here is silently taken as the schema and
overwrites it.

**What each field means.**
`media` is the file this record is about, as a wikilink: the pairing, and the
only one. `source` is the file it was derived from, and is absent on a root.
`op` says what produced it — `crop`, `transform`, `capture` or `paste`, absent
on a root. `crop` is `{ x, y, w, h }` in oriented-source pixels, after rotation
and flips, absent when the whole image was taken; `transform` is
`{ rotate, flipH, flipV }`, the orientation that crop was measured in. `width`
and `height` are what the file measures. `created` is when the record was
written, in UTC. `status` is `edited`, `reviewed`, or anything you set by hand,
and `labels` is a free list that nothing in the plugin reads.

**Inherited, and not.**
A child declares only what is its own. Every other field is resolved by walking
up the `source:` chain at read time, stopping at the first ancestor that
declares it — which is the entire reason for tracking lineage: correcting a
value on the parent corrects it for every descendant.

Eight fields are intrinsic and never inherited, because they describe this file
rather than the subject it is of: `media`, `source`, `op`, `crop`, `transform`,
`width`, `height` and `created`. Inheriting a parent's crop would say this file
was cut from a rectangle it was not.

Everything else inherits — `status`, `labels`, and any field you add to this
schema or write into a record by hand. A field present but empty counts as not
declared, so a record Schema Sync has filled out with blanks still inherits
through them.

The cost, accepted deliberately: a child note read on its own — by Dataview, by
Bases, by a person — is not self-describing. Resolved values are shown in the
Media Viewer's lineage panel, not written to disk.
