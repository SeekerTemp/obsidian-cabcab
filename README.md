# Obsidian Schema Sync

A schema-sync system for Obsidian markdown vaults, implemented as a community plugin.

Markdown is the database. Schemas are notes, records are notes, and the value lists that constrain them are notes. The plugin keeps them consistent and generates the table and ERD views over the top.

The goal is **minimal constraint on editability**. This is a personal knowledge manager, not a database — it optimises for the relationships between notes and for quickly renaming external attachments. Anything needing real constraints belongs in a real DBMS.

The system is called **CabCab Scheme DB**; `schema-sync` is the plugin that implements it.

## Documentation

This file is the design record — what was built and why. Two documents cover use:

| Document | For |
| --- | --- |
| [`docs/manual.md`](.obsidian/plugins/schema-sync/docs/manual.md) | You. The dashboard, the two sync directions, editing schema notes by hand, settings. |
| [`docs/agent-contract.md`](.obsidian/plugins/schema-sync/docs/agent-contract.md) | An AI agent. What it may author, what is generated, and the procedure for turning `data/raw/` into schemas and records. |

[`CLAUDE.md`](CLAUDE.md) loads automatically in an agent session and carries the five invariants plus a pointer to the contract.

## Problems

### Done

**1. Undeclared-property prompt stopped firing.** Not a regression — the guard was
right, the test data was gone. `checkUndeclaredProperties()` and `validateFile()`
shared one `_placeholder.` check, and the last numbered record was deleted in the
same commit that shipped the feature, so every remaining note was a template and
the prompt had nothing to fire on. The two skips are now separate: templates are
still never validated, but a property added to one raises the prompt, because
that is the plainest statement of schema intent there is.

**2. Orphaned configs survived.** `Clean orphaned configs` in 01/Registry and in
the command palette. A list is orphaned only when its field is gone from the
schema entirely, or the schema is gone — unbinding keeps the list, so the
two-stage `×` button stays reversible. Nothing is preselected and files are
trashed, not deleted.

**3. Field names kept their `[[ ]]`, and configs could not be linked.** Field names
typed as `[[Planet]]`, `[[LifeForm/trait|trait]]` or `[[trait#Values]]` normalise
to the target, and a trailing `.config` is stripped. Config notes moved to
`data/config/<Schema>/<field>.md`, so the Field Reference cell links straight to
the value list and the graph draws the edge. A foreign key generates no list of
its own — it points at the one the target entity already owns, so the values
cannot drift apart.

**5. Version control.** Branch model below. `data/` is now untracked on `main` and
`feature/*` — the files are untouched on disk, just no longer in git there.

**6. Renaming a field duplicated its config.** Renaming in 02/Definition now moves
the value list with the field, and renaming a schema moves its whole folder. An
occupied target is reported rather than merged: merging two notes would silently
discard one side's hand-written Notes column.

**9. Attachments render as images in base views.** Each bound `attachment` field
emits an `image(<field>)` formula and the view shows that in place of the
raw path column.

**11. A `.base` is written once and then belongs to you.** Regenerating it every
sync threw away any view that had been reordered, renamed or filtered by hand,
and there was no reason to: Bases reads a record's properties itself, so a field
added to the schema appears in the view without help. Sync now creates the file
if it is missing and afterwards maintains exactly one thing inside it — the
`<field>Image` formulas, because only the schema knows which fields are
attachments. A formula it creates earns a column; a column you delete afterwards
stays deleted. Everything else in the file is left byte-for-byte alone.

**4 and 10. Asset Renamer is built in.** The sibling plugin is merged into Schema
Sync and disabled; its folder is left in place so it can be re-enabled if needed.
It keeps its own ribbon icon, commands and file-menu entry — naming an attachment
is a separate job from keeping schemas in sync. Its dropdowns are now built from
the record's **own schema's** value lists rather than every file in a config
folder, and a note that declares no schema is offered nothing. `Generate
config.base` writes a view for `data/config` as well as the fallback folder.

**7. Foreign fields pull through a relation.** Each bound relation emits a
`<field>_<targetField>` formula per bound target field, so a row can be labelled
and filtered by the entity it points at. Nothing is written into `fields:` —
query and labelling only. One hop, so a cycle cannot generate forever.

**8. A value list can be implemented as records.** The ⤓ button on each
02/Definition row, before the delete button, creates one record per row named
after the value, with the field and the schema's identity field set to it.
Existing notes are skipped, so it is safe to press twice.

### Open

_Nothing outstanding from the original list._

## Layout

```
MyVault/
├── data/
│   ├── raw/                           Inbox — raw notes and exports awaiting normalisation
│   │   └── done/                        Sources already filed, kept as evidence
│   ├── schema/<Name>.schema.md        Entity definitions (fields, types, relations)
│   ├── record/<name>s/                Records implementing a schema
│   │   ├── _placeholder.<Name>.md       Template — never validated, never counted as a record
│   │   └── _placeholder<N>.<Name>.md    Real records, awaiting a proper name
│   ├── config/
│   │   ├── <Schema>/<field>.md        Auto-generated value list for one field
│   │   └── schema-mappings.md         Plugin bookkeeping (bindings, tracked paths)
│   ├── base/<Name>.base               Obsidian Bases table view (YAML)
│   └── AssetDatabase.base.md          DBML ERD for the DBML Visualizer plugin
├── config/                            Hand-authored config predating the plugin
├── assets/config/                     Asset Renamer sources
└── .obsidian/plugins/schema-sync/     The plugin itself
```

### Naming conventions

| Suffix | Case | Meaning |
| --- | --- | --- |
| `.schema.md` | `PascalCase` | Interface definition of an entity |
| `config/<Schema>/<field>.md` | matches the field | Unique values of one field; behaves like a set of enum options. The folder carries the convention, so the file name matches the field exactly and `[[Schema/field\|field]]` links straight to it |
| `.base` | `PascalCase` | Bases table view over a record folder |
| `.base.md` | `PascalCase` | DBML ERD note |
| record notes | free | A note declaring `implements: <Schema>` |

A **template** (`_placeholder.<Name>.md`) is never validated and never counted as
a record, but its values do join value lists, and a property added to it still
raises the undeclared-property prompt. Both for the same reason: for some schemas
the template is the only note that ever exists, so what is written there is the
plainest statement of intent available.

**The filename is the identity.** A schema is named by its file, not by its `schema:` property — the property is repaired to match on every sync. Two lookups that disagreed on this previously caused one schema's generated content to be written into another's file.

`.config` and `.base` files are `.md` where they need to be indexed: Obsidian only resolves links and frontmatter in markdown, so a bare `.config` file could not back a dropdown. `.base` is the exception, being a format Obsidian registers itself.

## File formats

### Schema

```markdown
---
schema: Verse
fields:
  - Realm:
      type: string
      relation: Realm
  - Culture:
      type: string
  - Cover:
      type: attachment
  - Notes:
      type: string
      bind: false
---

# Verse Schema

Your own prose here is preserved across syncs.

## Field Reference

| Field | Type | Default | Required | Bound |
| --- | --- | --- | --- | --- |
| ... generated ... |
```

Field properties:

| Property | Values | Effect |
| --- | --- | --- |
| `type` | `string`, `number`, `boolean`, `array`, `object`, `attachment` | Validation and the generated DBML column type |
| `required` | `true` | Reported as an issue when missing **or blank** |
| `default` | any | Written into new records instead of the empty value |
| `relation` | a schema name | Emits a `Ref:` in the ERD; suppresses the attribute's config list |
| `bind` | `false` | Documentation only — see below |

**`bind: false`** keeps a field visible in the definition editor and the Field Reference, but excludes it from record frontmatter, config lists, base view columns, the ERD, and validation. A scratch field: documented, inert.

**Binding is opt-in for anything half-written.** A field binds when it declares a `type`; a field with no type, a bare `- name` entry, or a Field Reference row with a blank `Bound` cell stays **unbound** until you say otherwise. A half-finished thought should never write itself into every record. An explicit `bind:` always wins, and `bind: true` is never written to disk, so schemas with fully declared fields need no migration.

**`attachment`** is a string holding a `[[wikilink]]` to a media file. Asset Renamer builds its property picker from a note's frontmatter keys, so an attachment field is editable there with no configuration — the plugin's only job is to make sure the key exists.

### Record

Every bound field is written, even when empty, so the column exists to be filled in:

```markdown
---
implements: "Verse"
Realm: ""
Culture: ""
Cover: ""
---

# Aetheria
```

### Config list

Auto-generated, one file per attribute name, shared across every schema declaring it:

```markdown
---
configFor: [Verse.Culture, LifeForm.Culture]
---

# Cultures

| Culture | Notes |
| --- | --- |
| [[Nomadic clans]] |  |
```

Regeneration **unions** — rows added by hand survive, even when no record currently uses that value, and the `Notes` cell on each row is carried across.

A **primary key gets a list like any other field**: its rows are the set of instances that exist. That list is what a foreign key points at, and what the ⤓ button turns into records with `id` set to the row's name. Only two kinds of field have no list — `attachment` fields, which hold media rather than categories, and unbound fields, which are written nowhere.

## Writing in generated files

Generated files are rebuilt wholesale on every sync, so anything written into one would otherwise be destroyed. Every generated markdown file therefore ends with a protected region:

```markdown
<!-- schema-sync:notes -->

Anything below this line is yours. Sync never touches it.
```

This applies to `.config.md` value lists, `.schema.md` notes (below the Field Reference), and the `.base.md` ERD. New records and placeholders are created with the marker already in place.

Three places are safe to write in:

| Where | Protected |
| --- | --- |
| Below the notes marker, in any generated file | Verbatim |
| The `Notes` column of a `.config.md` row | Per row |
| Prose between the title and the Field Reference in a schema note | Verbatim |

**Record notes are never rewritten at all** — only frontmatter keys are added, never removed, and the body is untouched. Undeclared frontmatter properties on a record are equally safe.

## Dashboard

Ribbon icon, or **Open schema dashboard**. Three panels:

**01 / Registry** — schemas, with duplicate and delete per row.

**02 / Definition** — the field editor. Click ✎ to unlock a row; **Enter** commits, **Escape** cancels and restores. Drag ⠿ to reorder — field order flows through to the schema note, base columns and the ERD. A blank field name is refused and reverted rather than saved. Renaming a field **moves the key in every record**, preserving values.

Rows are **live-editable by default** — no gate, changes apply as you make them, and Escape reverts a row you are part-way through. This is a note editor, not a DBMS: the trade is that a malformed edit lands rather than being caught. Settings → Schema Sync → *Require unlock before editing a field* restores the ✎-per-row behaviour if you want the extra step.

**× is two-stage and non-destructive first.** On a bound field it **unbinds** — no confirmation, since nothing is written away and the bind dropdown reverses it. The field stops reaching records, config lists, base views and the ERD, and values already stored in records stay put as ordinary free-form properties. Pressing × again on the now-unbound field removes it from the schema, and that step does ask, with "don't ask again this session".

**03 / Relation** — records for the selected schema, templates included and badged. Per row: open, ⧉ duplicate, 🖼 Asset Renamer, × delete (to trash, honouring your vault setting). `+ New <Schema> record` writes `_placeholder<N>.<Schema>.md` with every field, repeatable.

The layout responds to the **pane** width via container queries, not the window width, so it reflows correctly when docked in a split.

## Editing a schema note directly

Supported, and the plugin stays out of the way while you do it.

**A schema note that is open in any leaf is never rewritten.** Not "not the active view" — open anywhere, including a background tab or a split. Flushing is triggered by moving focus off the note, at which point it is no longer active but is still open; rewriting it there reloads the editor buffer under the cursor and makes the note impossible to type in. The note is normalised once it is actually closed.

While the note is the active view, changes are held entirely: only the dashboard refreshes, nothing is written. When you move focus off it, one sync runs and applies your edits **outward** — to records, config lists, base views and the ERD — leaving the note itself alone.

Both directions of the schema note are read:

- `fields:` frontmatter is authoritative for the fields it declares.
- **The Field Reference table is an input too**, but only for *adding*. A row with a **blank `Bound` cell** is read as hand-typed and adopted into `fields:`, always unbound; flip `bind` in 02/Definition when you're ready to commit to it.

**Only blank-`Bound` rows are adopted**, and that is what makes deletion work. The generator always writes `yes` or `no` in that column, so a row carrying either is its own output and is ignored on the way back in. Without that rule the two copies resurrect each other: delete a field from `fields:` and its still-present generated row puts it straight back.

So: **delete a field in `fields:` frontmatter, or with the × in 02/Definition — not by deleting its table row.** The stale row is ignored immediately and disappears when the table is next regenerated. Because an open note is only rewritten by a sync you press yourself, the deleted field can linger *visually* in the table until then; it is already gone from the schema.

Because an open note cannot be written back, an adopted field stays adopted-but-undeclared until the note is closed. It reaches records and config lists immediately regardless.

## The two directions

The dashboard header has one button per direction, and they are not symmetrical.

**↓ Sync schema system — top to bottom.** The schema is authoritative. Pushes it out to records, config lists, base views and the ERD, and regenerates each Field Reference table from `fields:`. Additive and safe: it never removes a record property.

**↑ Pull from notes — bottom to top, and destructive by design.** Each schema note's Field Reference table *becomes* the field set. A row deleted there deletes the field; a row added there adds it; blank cells resolve to the quiet defaults — `string`, no default, not required, **unbound**, no relation. Field order follows the table.

This is the one operation that can drop a field, so it confirms first and lists exactly what will go. Values already in records are never touched — a dropped field just becomes an ordinary free-form property. It does not push anything outward; follow it with a sync.

The table carries **every** field property, `Relation` included, so a pull is lossless — it cannot drop something the table was unable to express.

The command **Toggle schema safety for the active note** pins a note as never-rewritten even after it is closed, until toggled back.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Require unlock before editing a field | **off** | On, each row in 02/Definition needs its ✎ pressed before it can be edited. Off, rows are live. |
| Confirm before removing a field or deleting a record | on | Gates the second × on a field and record deletion. Unbinding is never confirmed; records go to the trash. |

## Sync pipeline

**Sync schema system**, or automatically on change:

```
loadSchemas()               read data/schema/*.schema.md, keyed by filename
syncEntityFieldsForSchema() back-fill records with missing bound fields, and
                            cast value-list fields to [[links]]
ensurePlaceholders()        back-fill the _placeholder template
importLists()               create records from data/config/*.csv
syncConfigLists()           regenerate data/config/<Schema>/<field>.md, unioned
                            from records, hand-added rows and Metadata Menu.
                            This and the [[cast]] of the edited record also run
                            ~1s after any record is edited
syncBaseViews()             create data/base/<Name>.base if missing; otherwise
                            reconcile only its <field>Image formulas
syncErd()                   write data/AssetDatabase.base.md as a DBML fence
cleanupGeneratedPaths()     delete only paths recorded as generated
syncSchemaDocs()            repair schema identity, heading, Field Reference
validateVault()             report issues to the status bar
```

Config lists run after records, so newly back-filled values are visible to them.

## Undeclared record properties

Add a property to a record that its schema does not declare, and you are asked once what it is:

| Choice | Effect |
| --- | --- |
| **Define and bind** | Adds the field to the schema *and* to every record of that schema, then opens the dashboard on it. Use when it belongs to the entity. |
| **Define, unbound** | Adds it to the schema as documentation only. Other records are untouched, and it is there to bind later. Use for an attribute one record happens to need. |
| **Leave it alone** | Stays a property of that record alone. Remembered on disk, so you are never asked again. |

Dismissing the dialog answers nothing — it stays quiet for now and asks again later.

The type is inferred from the value, including `attachment` when the value is a `[[link]]` to a non-markdown file. Whatever you choose, the property itself is **never removed or rewritten**.

Turn the prompts off, or clear the remembered dismissals, in Settings → Schema Sync.

Cleanup only ever touches paths the plugin recorded as generated, so hand-authored files under `data/` survive.

## Plugin interop

| Plugin | Relationship |
| --- | --- |
| **Bases** (core) | Consumes `data/base/*.base`. These must be Bases YAML — writing DBML there is what caused "unable to parse file". Each file is created once and then yours; only the attachment formulas are kept in sync. |
| **DBML Visualizer** | Renders the fence in `data/AssetDatabase.base.md`. |
| **Asset Renamer** | Merged in. Its own ribbon icon and commands; builds names from the record's own schema's value lists. The standalone plugin is disabled but left on disk. |
| **Metadata Menu** | A field is registered as a `Select` once, when its value list is first generated with values in it; sync then keeps that preset's options in step with the list. The renamer's third column sets any field's type by hand. Options are shown plain; sync casts the chosen value to `[[value]]` in the record, so it draws a graph edge. Values typed into one of its dropdowns are read back into the value list. |

## Development

`main.js` is hand-written plain JavaScript with no build step, matching every other plugin in this vault. Edit it in place and reload Obsidian.

The file opens with a block of **pure generators** — dependency-free functions that turn schema data into file text. They are exported as `module.exports.generators` so they can be exercised under plain node with a stubbed `require("obsidian")`, which is how the output formats (Bases YAML, frontmatter, DBML) are verified without launching Obsidian.

Design notes for the current implementation are in [`.obsidian/plugins/schema-sync/docs/`](.obsidian/plugins/schema-sync/docs/).

## Version control

Three kinds of branch, and what each one carries:

| Branch | Carries | `data/` |
| --- | --- | --- |
| `main` | `.obsidian/` — settings and every plugin | ignored |
| `feature/<plugin>` | Plugin work, branched from and merged back to `main` | ignored |
| `data/<project>` | One project's notes. Plugins come from `main` | tracked |

`.gitignore` is itself a tracked file, so each branch carries its own copy and git
swaps the rules on checkout. `main` and `feature/*` ignore `/data/`; a
`data/<project>` branch drops that line, which is what makes its notes trackable.

To pull the latest plugins into a project, merge `main` into the `data/<project>`
branch. Never merge the other way: a plugin hotfix made on a data branch should be
**cherry-picked** onto `main`, because merging would drag the whole vault with it.

`.gitignore` only governs files that are not already tracked, so it cannot stop a
merge from carrying data onto `main`. [`.githooks/pre-push`](.githooks/pre-push)
is the net that catches that, refusing any push to `main` or `feature/*` that
contains files under `data/`. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

## Known gaps

- A value-list field stores a `[[link]]`, so putting the cursor in its raw property
  box opens Obsidian's own link picker, which fuzzy-matches the whole vault and
  offers notes unrelated to the field. That picker is core Obsidian, triggered by
  the bracket syntax that earns the graph edge, and there is no API to scope it.
  Enter values through Metadata Menu's field icon instead.
- The bare basenames config notes use — `data/config/Realm/Realm.md` is `[[Realm]]` — compete with every other note in the vault. Generated links are always path-qualified, so they are safe; a hand-typed `[[Realm]]` may not be.
- A value list whose field was merely **unbound** is kept, so unbinding stays reversible. Only a deleted field or schema makes one an orphan.
- `isRecordFile()` still treats `config/entity.md` as a record for backwards compatibility, though nothing generates it any more.
- The Field Reference table in a schema note can look stale while that note is the active file. It is rewritten as soon as you move off it.
- Container queries need Chromium 105+. Obsidian 1.7+ is well past this.
