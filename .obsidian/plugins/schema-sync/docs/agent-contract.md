# CabCab Scheme DB — agent contract

How an agent turns raw material into schemas, records and value lists without
fighting the Schema Sync plugin.

Read [`CLAUDE.md`](../../../../CLAUDE.md) first — it carries the five
invariants. This document is the procedure. [`README.md`](../../../../README.md)
is the design record and explains *why* each rule exists; it is not repeated
here.

## 1. What you may write, and what writes itself

| Path | Who writes it |
| --- | --- |
| `data/raw/**` | The user drops it. You read it and move it to `data/raw/done/`. |
| `data/schema/<Name>.schema.md` | **You** — the `fields:` frontmatter and the prose between the title and the Field Reference. Never the table itself. |
| `data/record/<folder>/<Name>.md` | **You** — frontmatter and body, freely. Sync only ever *adds* missing keys; it never rewrites a record. |
| `data/config/<Schema>/<field>.md` | **Generated.** Only the `Notes` column of a row, and the region below the notes marker, are yours. |
| `data/base/<Name>.base` | **Generated once, then owned by the user.** Sync creates it if it is missing and afterwards maintains only the `<field>Image` formulas. Never create one by hand and never overwrite one — a view reordered or filtered by hand is not yours to discard. |
| `data/AssetDatabase.base.md` | **Generated.** The DBML ERD fence. Never edit. |
| `data/config/schema-mappings.md` | **Plugin bookkeeping.** Never edit. |

The `## Field Reference` table inside a schema note is generated even though the
rest of the note is yours. Write `fields:` and let sync render the table.

> **The one exception.** A Field Reference row with a **blank `Bound` cell** is
> read as hand-typed and adopted into `fields:` as an unbound field. That exists
> so a human can sketch a field directly in the table. You have `fields:` — use
> it, and never write a row by hand.

## 2. The inbox procedure

```
data/raw/        the user drops anything here — an export, a paste, a scribble
data/raw/done/   you move the source here once it is filed
```

For each file in `data/raw/`:

1. **Read it and decide what entity it describes.** One raw file may yield
   several records, or extend a schema without producing a record at all.
2. **Match an existing schema.** List `data/schema/*.schema.md` and compare by
   meaning, not by filename. Extend an existing schema rather than creating a
   near-duplicate — two schemas describing one entity is the expensive mistake
   here, because merging them later means rewriting every record.
3. **Create the schema if nothing fits** — section 3.
4. **Add any fields the raw data needs** — section 4.
5. **Write the records** — section 5.
6. **Leave value lists alone.** `syncConfigLists()` unions them from the records
   on the next sync. Writing one by hand breaks invariant 1.
7. **Move the source to `data/raw/done/`.** Never delete it — it is the evidence
   for what you inferred, and the user may have no other copy.
8. **Report what you did**, per raw file: the schema you chose or created, the
   fields you added and whether you bound them, and the records written.

Nothing in this loop needs Obsidian. Sync normalises when the vault is next
opened.

## 3. Creating a schema

Write `data/schema/<PascalCaseName>.schema.md`. The filename is the identity.

```markdown
---
schema: Realm
fields:
  - id:
      type: string
      required: true
  - biome:
      type: string
  - cover:
      type: attachment
  - sources:
      bind: false
---

# Realm Schema

One sentence on what this entity is. Your prose here survives every sync.

## Field Reference
```

Leave the `## Field Reference` heading with nothing under it — sync fills the
table in. You may also omit the heading entirely; sync adds it.

Do not write the `<!-- schema-sync:notes -->` marker yourself; sync appends it.

## 4. Field properties

| Property | Values | Effect |
| --- | --- | --- |
| `type` | `string`, `number`, `boolean`, `array`, `object`, `attachment` | Validation and the DBML column type. **Its presence is what binds the field.** |
| `required` | `true` | Reported as an issue when the value is missing *or blank*. |
| `default` | any | Written into new records instead of the empty value. |
| `relation` | a schema name | Emits a `Ref:` in the ERD, and a `<field>_<targetField>` formula per bound target field in the base view. Suppresses the field's own value list — a foreign key points at the list the target entity already owns. |
| `bind: false` | — | Documented but inert. Excluded from records, value lists, base columns, the ERD and validation. |

Choosing a type:

- **`attachment`** is a string holding a `[[wikilink]]` to a media file. Use it
  for images and PDFs, never for a link to another record.
- **A link to another record is `type: string` plus `relation: <Schema>`.**
- **`array`** for a genuine list of values. If those values are a closed set it
  still gets one value list, and that is correct.

When the raw data is ambiguous — a column you cannot confidently type — declare
the field **without a `type`**. It lands in the schema as documentation, reaches
nothing, and the user can bind it in 02 / Definition once they decide. That is
strictly better than guessing a type and writing the guess into every record.

## 5. Writing a record

Put it in the folder that schema's existing records already use. If there are
none, use `data/record/<schemaname>s/` — lowercase, pluralised with `s`.

```markdown
---
implements: Realm
id: "Aetheria"
biome: "Tidal flats"
cover: ""
---

# Aetheria

Whatever prose the raw source gave you.
```

- **Write every bound field**, empty string included, so the column exists to be
  filled in.
- **`implements:` must exactly match the schema's filename**, minus
  `.schema.md`.
- **Never name a record `_placeholder…`** — that prefix marks a template, which
  is never validated and never counted as data.
- Extra frontmatter keys are safe. Sync never removes them, and the user is
  asked once whether the property should join the schema.

## 6. Changing an existing schema

**Adding a field.** Append to `fields:`. Sync back-fills the key into every
record of that schema on the next run — additive and safe.

**Renaming a field.** Do it in the dashboard's 02 / Definition panel, not by
hand: renaming there moves the key in every record and moves the field's value
list with it. Editing `fields:` alone leaves every record carrying the old key
and orphans the list. Headless, it is three edits or none — rename in `fields:`,
rename the key in every record, and move `data/config/<Schema>/<old>.md` to
`<new>.md` with its `configFor` updated.

**Removing a field.** Delete it from `fields:`. Values already in records stay
put as ordinary free-form properties, so nothing is lost. The field's value list
becomes an orphan, cleared with **Clean orphaned config notes**.

**Renaming a schema.** Dashboard only. It moves the whole
`data/config/<Schema>/` folder, which a plain file rename does not.

## 7. Failure modes

| Symptom | Cause |
| --- | --- |
| A field never appears in records or views | It declares no `type`, so it is unbound. Intended, or give it one. |
| A deleted field comes back | It was deleted by removing its Field Reference row. Delete it from `fields:` instead. |
| A generated file lost your edit | It was regenerated. Rewrite below `<!-- schema-sync:notes -->`. |
| One schema's content appears in another's file | Two lookups disagreed on identity. The filename wins — check the `implements:` spelling. |
| The Field Reference looks stale | That note is open in Obsidian. An open schema note is never rewritten; it normalises once closed. |
| Nothing was generated at all | Obsidian is closed. Expected — open the vault. |

## 8. Do not

- Write into `data/config/`, `data/base/`, or `data/AssetDatabase.base.md`.
- Regenerate an existing `.base`. Bases reads new record properties itself, so a
  field you add needs nothing done to the view.
- Write a Field Reference table row.
- Delete anything from `data/raw/`.
- `git add -f` files under `data/` on `main` or `feature/*`.
- Create a second schema for an entity that already has one.
