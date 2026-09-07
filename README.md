# Obsidian Schema Sync

A schema-sync system for Obsidian markdown vaults, implemented as a community plugin.

Markdown is the database. Schemas are notes, records are notes, and the value lists that constrain them are notes. The plugin keeps them consistent and generates the table and ERD views over the top.

The goal is **minimal constraint on editability**. This is a personal knowledge manager, not a database — it optimises for the relationships between notes and for quickly renaming external attachments. Anything needing real constraints belongs in a real DBMS.

## Layout

```
MyVault/
├── data/
│   ├── schema/<Name>.schema.md        Entity definitions (fields, types, relations)
│   ├── record/<name>s/                Records implementing a schema
│   │   ├── _placeholder.<Name>.md       Template — never validated, never counted as data
│   │   └── _placeholder<N>.<Name>.md    Real records, awaiting a proper name
│   ├── config/
│   │   ├── <Plural>.config.md         Auto-generated value list for one attribute
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
| `.config.md` | `PascalCasePlural` | Unique values of one attribute; behaves like a set of enum options |
| `.base` | `PascalCase` | Bases table view over a record folder |
| `.base.md` | `PascalCase` | DBML ERD note |
| record notes | free | A note declaring `implements: <Schema>` |

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

**`bind: false`** keeps a field visible in the definition editor and the Field Reference, but excludes it from record frontmatter, config lists, base view columns, the ERD, and validation. Absent means bound, so existing schemas need no migration and `bind: true` is never written to disk.

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

Regeneration **unions** — rows added by hand survive, even when no record currently uses that value. Fields named `id` or `name` get no list, being identity keys rather than categories.

## Dashboard

Ribbon icon, or **Open schema dashboard**. Three panels:

**01 / Registry** — schemas, with duplicate and delete per row.

**02 / Definition** — the field editor. Click ✎ to unlock a row; **Enter** commits, **Escape** cancels and restores. Drag ⠿ to reorder — field order flows through to the schema note, base columns and the ERD. A blank field name is refused and reverted rather than saved. Renaming a field **moves the key in every record**, preserving values. Deleting a field offers "don't ask again this session".

**03 / Relation** — records for the selected schema, templates included and badged. Per row: open, ⧉ duplicate, 🖼 Asset Renamer, × delete (to trash, honouring your vault setting). `+ New <Schema> record` writes `_placeholder<N>.<Schema>.md` with every field, repeatable.

The layout responds to the **pane** width via container queries, not the window width, so it reflows correctly when docked in a split.

## Editing a schema note directly

Supported, and the plugin stays out of the way while you do it.

While a schema note is the **active file**, changes are held: only the dashboard refreshes, nothing is written. When you move off the note, one sync runs and applies your edits. `syncSchemaDocs` additionally refuses to rewrite the active file whatever triggered the sync.

For longer protection — a schema note pinned open across many syncs — the command **Toggle schema safety for the active note** exempts it until it is closed.

## Sync pipeline

**Sync schema system**, or automatically on change:

```
loadSchemas()               read data/schema/*.schema.md, keyed by filename
syncEntityFieldsForSchema() back-fill records with missing bound fields
ensurePlaceholders()        back-fill the _placeholder template
importLists()               create records from data/config/*.csv
syncConfigLists()           regenerate data/config/<Plural>.config.md, unioned
syncBaseViews()             write data/base/<Name>.base as Bases YAML
syncErd()                   write data/AssetDatabase.base.md as a DBML fence
cleanupGeneratedPaths()     delete only paths recorded as generated
syncSchemaDocs()            repair schema identity, heading, Field Reference
validateVault()             report issues to the status bar
```

Config lists run after records, so newly back-filled values are visible to them.

Unknown properties on a record are **reported, never removed** — adding a property to a note is a visible warning to correct in the schema, not a reason to lose data. Cleanup only ever touches paths the plugin recorded as generated, so hand-authored files under `data/` survive.

## Plugin interop

| Plugin | Relationship |
| --- | --- |
| **Bases** (core) | Consumes `data/base/*.base`. These must be Bases YAML — writing DBML there is what caused "unable to parse file". |
| **DBML Visualizer** | Renders the fence in `data/AssetDatabase.base.md`. |
| **Asset Renamer** | Edits `attachment` fields. No configuration needed; it reads frontmatter keys. |
| **Metadata Menu** | Asset Renamer registers `Select` preset fields from its own config sources. |

## Development

`main.js` is hand-written plain JavaScript with no build step, matching every other plugin in this vault. Edit it in place and reload Obsidian.

The file opens with a block of **pure generators** — dependency-free functions that turn schema data into file text. They are exported as `module.exports.generators` so they can be exercised under plain node with a stubbed `require("obsidian")`, which is how the output formats (Bases YAML, frontmatter, DBML) are verified without launching Obsidian.

Design notes for the current implementation are in [`.obsidian/plugins/schema-sync/docs/`](.obsidian/plugins/schema-sync/docs/).

## Known gaps

- A `.config.md` for a renamed, unbound or deleted field is **not** removed — these hold curated rows, so they are deliberately never auto-deleted. Remove them by hand.
- Config lists are keyed by attribute **name** across all schemas. Two schemas with a `Culture` field share one `Cultures.config.md`.
- `isRecordFile()` still treats `config/entity.md` as a record for backwards compatibility, though nothing generates it any more.
- The Field Reference table in a schema note can look stale while that note is the active file. It is rewritten as soon as you move off it.
- Container queries need Chromium 105+. Obsidian 1.7+ is well past this.
