# Schema Sync — Config Identity and Lifecycle

Date: 2026-09-08
Status: Draft, awaiting review
Scope: `.obsidian/plugins/schema-sync/main.js`, `tests/`
Covers: README problems 2, 3, 6
Follows: [2026-09-07-schema-sync-editor-and-relations.md](2026-09-07-schema-sync-editor-and-relations.md)

## Context

Three README items share one root cause: a config note's identity is derived from its field name at generation time and never re-derived.

- **2** — orphaned config notes survive forever. `syncConfigLists()` deliberately never registers them as generated paths, because they carry a hand-curated Notes column, so `cleanupGeneratedPaths()` never touches them.
- **3** — the `.config.md` suffix stops `[[attribute]]` resolving to the config note, so a field cannot link to its own value list. Separately, field names typed as `[[Planet]]` in 02/Definition are stored verbatim, brackets included.
- **6** — renaming a field in 02/Definition writes the schema and renames the property in records, but nothing renames the config note. The next sync generates a second one and both persist.

`renameField()` at main.js:85 is defined and exported but has no call site; `saveSchemaFromDashboard()` renames by rebuilding the `fields` object instead.

### Where the junk property names came from

The deleted record `id2.LifeForm.md` carried properties literally named `Architectures.config` and `Cultures.config`, and one of them is still recorded in `data.json` under `ignoredProperties`. Asset Renamer derives a property name from a config filename and, before the guard at [asset-renamer/main.js:421](../../asset-renamer/main.js), did not strip the suffix. Dropping `.config` from the filename removes that bug class at its source rather than stripping it downstream in each consumer.

## Decisions taken

| Decision | Choice |
| --- | --- |
| Config location | `data/config/<Schema>/<field>.md` — one note per schema+field |
| Filename | The field name. No `.config`, no pluralisation |
| Convention carrier | The folder structure, not the filename |
| Field Reference cell | `[[LifeForm/trait\|trait]]` — path-qualified, aliased to the field name |
| Foreign keys | Generate no config; link to the target schema's own-name config |
| Orphan rule | The `configFor` source no longer resolves to a declared field |
| Rename tracking | The `configFor:` frontmatter already in each config note |

### Why one folder per schema

The first draft of this spec shared one config note between every schema declaring the same field name, which forced a merge whenever a rename collided. Review found that merge would silently discard the hand-curated Notes column on every overlapping value — the exact content the orphan rule is cautious about.

Namespacing by schema removes the problem rather than handling it. No config note is ever shared, so `configFor` is single-valued, a field rename is always a plain rename, and a schema rename is a single folder rename. Two schemas may now both declare `trait` and each keeps its own list.

The cost is that Obsidian resolves `[[trait]]` by basename and ignores folders, so bare links would be ambiguous between `LifeForm/trait.md` and `Beast/trait.md`. Links are therefore path-qualified and aliased: `[[LifeForm/trait|trait]]` renders as `trait`, resolves unambiguously, and draws the graph edge. The alias pipe returns, but for disambiguation rather than to hide a suffix.

## Design

### C1 — Config note identity

`configFileNameFor(fieldName, definition)` is replaced by `configPathFor(schemaName, fieldName, definition)`, returning `data/config/<Schema>/<field>.md` or null. Eligibility is unchanged: string type, bound, no relation target, not an identity field. Its three call sites — the 02/Definition row button (title and muted state), `openFieldConfig()`, and `syncConfigLists()` — all gain the schema name, which each already has in scope.

`configFor` becomes single-valued: `configFor: [LifeForm.trait]`.

`pluralize()` loses both callers — the filename and the config note's `# Realms` heading — and is deleted along with its `generators` export. The heading becomes the field name.

`data/config/schema-mappings.md` stays where it is. It is now separated from config notes structurally, by living outside any schema folder, rather than by an exclusion list.

No other code keys off the `.config.md` suffix. `checkImplementationColumns()` guards on `configFor` frontmatter and the raw `/^configFor:/m` text; `isRecordFile()` guards on the `data/config/` prefix, which subfolders still match. Both are filename-independent — verified.

The sample-database bootstrap at main.js:1168-1172 writes `<name>.config.md` and is updated to match.

### C2 — Field name normalisation

```js
// A field name typed as a wikilink is the user reaching for the value list the
// field points at. Keep the target, drop the brackets: the link belongs in the
// Field Reference cell, which the generator writes, not in `fields:`.
function normalizeFieldName(raw)
```

Applied at three entry points:

1. The 02/Definition name input, in `saveSchemaFromDashboard()`.
2. `parseFieldReferenceRows()` — **load-bearing, not cosmetic.** The generator now writes `[[LifeForm/trait|trait]]` into that cell, so the bottom-to-top pull only round trips if reading strips the path and alias back to `trait`.
3. `parseFieldSpec()`, for the "Add field" prompt.

A field name is now also a filename, so after stripping, a name containing `/`, `\`, `:`, `#`, `^`, `|`, `[` or `]` is rejected with a notice rather than escaping the config folder. A trailing `.config` is stripped as well, cleaning up names left behind by the Asset Renamer bug described above.

`saveSchemaFromDashboard()` already rejects two fields with the same name in one schema. That check becomes case-insensitive, because the two names are now two filenames on a case-insensitive filesystem.

### C3 — Field Reference links

`renderFieldReference()` writes the Field cell as:

| Field kind | Example field | Cell |
| --- | --- | --- |
| Has a config | `LifeForm.trait` | `[[LifeForm/trait\|trait]]` |
| Relation, target declares its own name | `Verse.Realm` → `Realm` | `[[Realm/Realm\|Realm]]` |
| Relation, target has no such field | `Pack.owner` → `LifeForm` | `[[LifeForm.schema\|owner]]` |
| No config (unbound, identity, non-string) | `LifeForm.id` | `id` — plain text |

A link therefore means "this field has somewhere to point", and its absence means it does not. Graph view draws the edge either way.

**Assumption, not a stated requirement:** the fallback row. A relation to `LifeForm` has no `LifeForm` field to point at — `id` is an identity field and excluded from configs — so it links to the target schema note. This is always defined and matches the existing notice in `openFieldConfig()`: "its values come from that entity's records, not a config list."

### C4 — Rename sync

`configFor` is the back-link, so no new bookkeeping is introduced. Config notes are located by scanning `configFor` frontmatter, never by filename, so the plan is correct regardless of what a note is currently called.

**Field rename** — `trait` to `feature` in `LifeForm`:

| Situation | Action |
| --- | --- |
| Normal | `renameFile` to `LifeForm/feature.md`, rewrite `configFor` |
| Target path already occupied | Report and leave both. Do not merge |

Refusing to merge is deliberate. Duplicate field names within a schema are already rejected at save, so an occupied target can only be a leftover from an earlier failed rename. Merging two curated Notes columns is precisely the silent data loss this design exists to avoid; the orphan cleanup in C5 handles the leftover with the user looking at it.

**Schema rename** — `data/config/<Old>/` is renamed to `data/config/<New>/` and each note's `configFor` is rewritten.

`app.fileManager.renameFile` is used rather than a vault rename, so Obsidian rewrites every `[[LifeForm/trait|trait]]` in the vault to the new path.

**Ordering constraint.** The config rename is awaited *before* `writeSchemaFile()` in `saveSchemaFromDashboard()`. Both write the schema note — Obsidian's link update and our regeneration — and ours must be last so it is authoritative.

### C5 — Orphan cleanup

Pure decision, `orphanedConfigs(configNotes, schemas)`:

- A note is **live** when its `configFor` source names a schema that exists and still declares that field. Bind state is irrelevant, so the two-stage `x` button (unbind, then remove) stays reversible.
- Source field gone, or schema gone → orphan.
- A whole `data/config/<Schema>/` folder whose schema no longer exists → every note in it is an orphan.
- A note with no `configFor` is never touched. Neither is `schema-mappings.md`.

A **Clean orphaned configs** button in 01/Registry, the vault-scoped panel. It opens a list of candidates showing each dead source and the note's row count, with checkboxes and nothing preselected, and trashes the selected notes via `fileManager.trashFile` so the vault's own trash setting is honoured. It never runs automatically.

### C6 — Migration

Self-healing, no separate command. `syncConfigLists()` gains a migration pass that runs **before** generation. Order matters: generating first would create empty notes at the new paths and leave the old ones looking like orphans.

For each `configFor`-bearing note in `data/config/`, including the old flat ones:

1. Destination is `data/config/<Schema>/<field>.md` for its **first live source**.
2. If the note is already there, nothing happens.
3. Otherwise `renameFile` to the destination, then rewrite `configFor` to that single source.
4. A legacy note with **several** live sources is copied into each additional schema's folder with its rows intact, then the original is renamed to serve the first. Copying rather than moving means no Notes cell is lost anywhere.

The destination is derived from the field name directly, not from `configPathFor()`, which returns null for unbound fields whose notes must still be migrated.

On the next sync: `traits.config.md` becomes `data/config/LifeForm/trait.md`, and `Realms.config.md` becomes `data/config/Realm/Realm.md`, contents and inbound links preserved.

### C7 — Tests

Extends the `tests/undeclared-property.test.js` harness — a `Module._load` hook stubs the `obsidian` import so pure functions can be exercised out of vault. New pure seams, all exported through `generators`:

- `normalizeFieldName` — brackets, path-qualified links, aliases, headings, illegal characters, trailing `.config`
- `configPathFor` — the new layout, and each exclusion rule
- `renderFieldReference` into `parseFieldReferenceRows` — round trip, including the aliased path form
- `fieldReferenceLink` — config, relation, relation-without-target, plain
- `configRenamePlan` — normal, occupied target, schema rename
- `migrationPlanFor` — flat to foldered, already correct, multi-source legacy
- `orphanedConfigs` — live, dead field, dead schema, unbound-still-live

## Risks

### R1 — Bare entity names stay free, but only for links we write

Namespacing plus path-qualified links means the generator never writes bare `[[Realm]]`, so that name remains available for the Realm entity in sub-projects D and E. This was the sharpest objection to the previous draft and it is now resolved for generated links.

It is not resolved for links **you** type. `data/config/Realm/Realm.md` still has the basename `Realm`, so a hand-typed `[[Realm]]` elsewhere in the vault resolves to the value list. Proposed but not specified here: a sync-time warning when a config note's basename collides with another note.

### R2 — Case-insensitive filesystem collisions

This vault is on Windows. Collisions are now confined to a single schema declaring two fields differing only in case, which C2 rejects at save. The remaining exposure is two *schemas* whose names differ only in case producing one folder; rare, and reported rather than silently merged.

### R3 — Stale `configFor` on unbound fields

`syncConfigLists()` only rewrites notes for fields that pass `configPathFor()`, which excludes unbound fields. A schema renamed while one of its fields is unbound leaves that note with a stale source, and the orphan rule will flag it. Accepted: the cleanup is manual and shows its reasoning, so a false positive is visible rather than silent. The schema-rename handler in C4 mitigates the common case.

### R4 — Scope beyond items 2, 3 and 6

Deleting `pluralize()`, rejecting illegal filename characters, stripping trailing `.config` from field names, case-insensitive duplicate rejection, and the FK link fallback are all additions. Each is small and each is listed above so it can be cut.

## Out of scope

Items 4, 5, 7, 8, 9 and 10 belong to sub-projects C, D, E and F. Item 1 is fixed and verified.
