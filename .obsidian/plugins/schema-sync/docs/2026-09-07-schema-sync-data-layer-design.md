# Schema Sync — Batch A: Data-Layer Correctness

Date: 2026-09-07
Status: Approved, ready for implementation planning
Scope: `.obsidian/plugins/schema-sync/main.js`

## Context

The Schema Sync plugin manages a schema/record/config system in an Obsidian vault:

- `data/schema/<Name>.schema.md` — field definitions in frontmatter
- `data/record/<name>s/*.md` — records declaring `implements: <Name>`
- `data/config/*.config.md` — enum-style value lists backing attribute selection
- `data/base/<Name>.base` — table views over records
- `data/AssetDatabase.base.md` — DBML ERD for the dbml-visualizer plugin

The plugin is a single hand-written `main.js` (~1120 lines, no build step), matching every other plugin in this vault. It has no tests.

This spec covers **batch A only**: the data-layer generators and the identity model. Three further batches are deferred and each gets its own spec:

- **B** — 02/Definition editor UX (non-destructive editing, per-note safety toggle, `bind: yes/no` column, drag-to-reorder, delete-confirm suppression, sticky and scrollable layout, `attachment` field type for asset-renamer interop)
- **C** — 03/Relation panel (entity naming, new-entity and duplicate buttons)
- **D** — the rename-blank bug, which needs a reproduction before it can be specified

## Problems being fixed

### P1 — `.base` files are unparseable

The **Bases** core plugin is enabled (`.obsidian/core-plugins.json` has `"bases": true`), so a `.base` file must be Bases YAML. `syncBaseViews()` writes DBML into `data/base/*.base`, which Bases rejects with "unable to parse file".

`.base` (Bases YAML) and `.base.md` (a note containing a dbml code fence) are unrelated formats that the current code conflates in one function.

### P2 — Schema identity is resolved two different ways

`loadSchemas()` and `schemaFile()` key a schema by **filename** (basename minus `.schema`). `syncSchemaDocs()` keys it by the **`schema:` frontmatter property** via its own `.find()`.

When the two disagree, `syncSchemaDocs()` writes one schema's Field Reference table into another schema's file. This has already happened in the vault: `data/schema/Realm.schema.md` declares `schema: Verse`, carries the heading `# Verse Schema`, has a `fields:` block with one field (`Realm`), and a Field Reference table listing all eight Verse fields.

### P3 — Placeholders and records omit most fields

Three independent causes of the same symptom:

1. `defaultsFor()` emits only fields that are `required` or have a `default`. A schema of all-optional, no-default fields (Verse) produces frontmatter containing nothing but `implements`.
2. `ensurePlaceholders()` calls `continue` when the placeholder file already exists, so it never back-fills fields added to the schema later.
3. `syncEntityFieldsForSchema()` explicitly filters out placeholder files.

### P4 — The Implement button writes to the wrong place

`implementEntity()` hardcodes `config/entity.md` as its output, ignores the schema's records folder, and refuses to run at all once any entity exists — so it cannot be used to add a second record.

### P5 — No per-attribute value lists

Nothing generates the `data/config/*.config.md` enum lists that records are meant to select from.

### P6 — Sync deletes files it did not create

`syncBaseViews()` deletes every `.base.md` under `data/` and every `.base` under `data/base/` on each run, including hand-authored files.

## Design decisions

Settled during brainstorming:

| Decision | Choice | Rationale |
| --- | --- | --- |
| `.base` record selection | Filter by folder; columns are exactly the schema's fields | User preference; folder is the visible organising principle |
| Config list granularity | One file per attribute, PascalCase plural | Matches the README's `(PascalCases).config` naming rule; each file is a self-contained dropdown source |
| Config file sharing | One file per attribute **name**, values unioned across schemas | A category list is a concept, not a per-entity thing |
| Schema identity | Filename wins; `schema:` frontmatter auto-repaired | Filename is the entity name in the user's convention |
| Implement output | `_placeholder<N>.<Schema>.md`, N from 2, real records | Reads `&N` as "next free number"; avoids `&` in filenames |
| Empty field values | Genuinely empty (`""`, `0`, `false`, `[]`, `{}`) | No `TODO_` text; required-ness surfaced by validation instead |
| Stale file cleanup | Only paths recorded as generated | Hand-made files under `data/` must survive a sync |
| File extension | `.config.md`, not bare `.config` | Obsidian only indexes and link-resolves `.md`; a bare `.config` gets no metadataCache entry and cannot back a dropdown |
| Code structure | One hand-written `main.js`; generators extracted as pure functions | No toolchain; keeps the plugin file hand-editable in the vault, as every other plugin here is |

## Architecture

### Unit 1 — Generators (pure)

A block of dependency-free functions near the top of `main.js`. Each takes plain data and returns a string. No Obsidian API, no `this`, no I/O. This is what makes batch A testable without running Obsidian.

| Function | Input | Output |
| --- | --- | --- |
| `renderBaseYaml(schemaName, fields, recordFolder)` | schema name, field map, folder path | Bases YAML |
| `renderConfigNote(attributeName, sources, values, existingValues)` | attribute, owning `Schema.field` list, values found in records, values already in the file | `.config.md` text |
| `renderRecordFrontmatter(schemaName, fields)` | schema name, field map | YAML frontmatter body, all fields |
| `renderSchemaNote(name, fields, sourcePath, body)` | schema name, field map, optional source, existing prose | `.schema.md` text |
| `renderDbml(schemas)` | full schema map | DBML text for the ERD fence |
| `pluralize(word)` | attribute name | PascalCase plural |
| `yamlValue`, `frontmatterText`, `emptyValue` | — | moved out of the plugin class, behaviour unchanged |

`renderSchemaNote` gains the `body` parameter and preserves it. The current `schemaMarkdown()` discards the note's prose on every dashboard save. This is nominally a batch-B concern, but the generator is being rewritten here and leaving it destructive would mean rewriting it twice.

### Unit 2 — Schema registry (identity)

`schemaKeyFor(file)` returns the basename minus `.schema` for any file under `data/schema/`. `loadSchemas()`, `schemaFile()`, and `syncSchemaDocs()` all route through it — `syncSchemaDocs()` loses its own `.find()`.

`repairSchemaIdentity(file, key)` runs during sync: if `frontmatter.schema !== key`, it rewrites the property and the `# <Name> Schema` heading to match the filename.

### Unit 3 — View generation

`syncBaseViews()` splits in two:

- `syncBaseViews()` writes `data/base/<Entity>.base` as Bases YAML:

```yaml
filters:
  and:
    - file.inFolder("data/record/verses")
views:
  - type: table
    name: Verse
    order:
      - file.name
      - Realm
      - LifeForm
      - Culture
      - Architecture
      - Service
      - Faction_Alignment
      - Weather
      - Event
```

- `syncErd()` writes `data/AssetDatabase.base.md`, unchanged dbml fence output.

The blanket delete loop is replaced. Generated paths are recorded under `generatedPaths` in `data/config/schema-mappings.md`; only recorded paths whose schema no longer exists are eligible for deletion.

### Unit 4 — Config list generation

`syncConfigLists()` runs after records are synced.

- Applies to every `string` field with no `relation`, **except** fields named `id` or `name` (case-insensitive). Added during implementation: the first dry run against the vault produced `data/config/ids.config.md` from `LifeForm.id`, which is an identity key rather than a category enum — a list of every id in the vault is noise, not a dropdown. These are the same two names `dbmlRefTarget()` already treats as a table's key.
- Config files are **not** registered in `generatedPaths` and are therefore never auto-deleted. Added during implementation: they hold user-curated rows, so removing or renaming a field must not take the curated list with it. The cost is that a config file for a deleted field lingers until removed by hand.
- Target: `data/config/<Plural>.config.md`, one file per attribute **name** across all schemas.
- Values: unique non-empty values of that attribute across all records implementing any schema declaring it, rendered as wikilinks, sorted.
- Frontmatter: `configFor: [Verse.Culture, LifeForm.Culture]`.
- Body: a markdown table matching the shape of the existing `config/categories.md`.
- **Regeneration unions, never replaces.** The union happens inside `renderConfigNote`, which receives both the values discovered in records and the values parsed out of the existing file. Rows already present are retained even when no record currently uses that value, so hand-added options survive.
- A config file is created even when no record supplies a value yet, so the dropdown source exists from the moment the field is declared. With the vault in its current state (records are placeholders only), the first sync produces empty tables.

### Unit 5 — Record and placeholder generation

`recordValuesFor(fields)` replaces `defaultsFor()` at the record-writing call sites and emits **every** field: the declared `default` if present, otherwise the type's empty value (`""`, `0`, `false`, `[]`, `{}`).

- `ensurePlaceholders()` back-fills missing keys into an existing `_placeholder.<Schema>.md` without touching values already set.
- `implementEntity(schemaName)` writes to `folderForSchema(schemaName)` as `_placeholder<N>.<Schema>.md`, N being the lowest free integer starting at 2, with full frontmatter. The `existingData` guard is removed so it can be pressed repeatedly.
- No change is needed to the placeholder predicate: `PLACEHOLDER_PREFIX` is `"_placeholder."`, and `_placeholder2.Verse` does not start with it, so numbered files are already treated as real records by `dataFiles()` and validation.

### Unit 6 — Validation

One rule added to `validateFile()`: a `required` field that is present but empty reports `"<name> is required"`. Without it, records now full of empty strings would all validate clean and the 03 panel's "In sync" badge would carry no information.

## Data flow

```
sync
 |- loadSchemas()               reads data/schema/*.schema.md, keyed by filename
 |- repairSchemaIdentity()      frontmatter + heading follow the filename
 |- syncEntityFieldsForSchema() back-fills records with missing fields
 |- ensurePlaceholders()        back-fills _placeholder.<Schema>.md
 |- syncConfigLists()           data/config/<Plural>.config.md, unioned
 |- syncBaseViews()             data/base/<Entity>.base    (Bases YAML)
 |- syncErd()                   data/AssetDatabase.base.md (DBML fence)
 |- syncSchemaDocs()            Field Reference table, via schemaFile()
 |- validateVault()             reports issues to the status bar
```

Config lists must be generated after record sync, so newly back-filled values are visible. Base views depend only on schema fields, so their position is not constrained.

## Error handling

- A schema note with unreadable or absent `fields:` loads as an empty field map rather than throwing; the dashboard shows it with zero properties.
- Vault writes go through the existing `processFrontMatter` / `vault.modify` paths, which already serialise through Obsidian. The `patching` guard against re-entrant validation stays as is.
- Identity repair is idempotent: a second sync over a repaired file is a no-op.
- Config list regeneration never deletes rows, so a failed or partial run cannot lose hand-entered options.
- Path cleanup acts only on paths previously recorded as generated, so an unrecognised file under `data/` is left alone rather than deleted.

## Testing

A `node --test` script in the session scratchpad — **not** in the vault, so no `node_modules` is ever created inside a folder Obsidian scans.

The script intercepts `require("obsidian")` via a `Module._load` hook returning a stub module (`Plugin`, `ItemView`, `Modal`, `Notice`, `TFile`, `SuggestModal`, `normalizePath`), which lets `main.js` load under plain node. It then asserts on the pure generators:

1. `renderBaseYaml` output parses as YAML and yields the expected `filters` and `order` keys — the direct proof that Bases will accept it, and the one thing that otherwise could not be checked without launching Obsidian.
2. `renderRecordFrontmatter` emits one key per schema field, with correct empty values per type.
3. `renderSchemaNote` round-trips a body: prose passed in comes back out intact.
4. `renderConfigNote` unions supplied values with pre-existing rows and drops neither.
5. `pluralize` covers `Culture`→`Cultures`, `Weather`→`Weathers`, `Category`→`Categories`, `Class`→`Classes`.

Behaviour that touches the Obsidian API (identity repair, path cleanup, the Implement button) is not unit-tested; it is verified by reloading the plugin and running **Sync schema system** against this vault.

## Acceptance criteria

1. `data/base/Verse.base` opens in Obsidian as a table without a parse error, showing records from `data/record/verses` with one column per Verse field.
2. `data/schema/Realm.schema.md` reads `schema: Realm`, is headed `# Realm Schema`, and its Field Reference lists only `Realm`.
3. `data/record/verses/_placeholder.Verse.md` carries all eight Verse fields.
4. Pressing Implement twice yields `_placeholder2.Verse.md` and `_placeholder3.Verse.md` in `data/record/verses/`, each with all eight fields, and both appear in `Verse.base`.
5. `data/config/Cultures.config.md` exists and lists the unique `Culture` values found in records; a row added by hand survives the next sync.
6. `data/AssetDatabase.base.md` still renders through dbml-visualizer.
7. A hand-created file under `data/` is not deleted by a sync.
8. The scratchpad test script passes.

## Out of scope

Everything in batches B, C, and D. Specifically not addressed here: the dashboard's sticky or scrollable layout, drag-to-reorder, the per-note safety toggle, the `bind: yes/no` column, the `attachment` field type and asset-renamer interop, the 03 panel's duplicate and new-entity buttons, and the rename-blank bug.
