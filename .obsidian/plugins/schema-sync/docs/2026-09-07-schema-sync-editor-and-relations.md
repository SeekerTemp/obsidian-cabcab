# Schema Sync — Batches B, C, D: Editor, Relations, Rename

Date: 2026-09-07
Status: Implemented
Scope: `.obsidian/plugins/schema-sync/main.js`, `styles.css`
Follows: [2026-09-07-schema-sync-data-layer-design.md](2026-09-07-schema-sync-data-layer-design.md)

Implemented directly at the user's instruction ("Implement the rest, go") rather than through a separate approval round. Decisions made without a design gate are recorded here.

## Batch B — 02 / Definition editor

### The `bind` flag

Each field carries `bind`, defaulting to true. `bind: false` makes a field **documentation only**: it stays visible in the definition editor and the schema note's Field Reference, but is excluded from record frontmatter, config lists, base view columns, DBML tables and relations, and validation.

Serialised only when false, so existing schema notes are unchanged byte-for-byte. `readFields()` treats an absent `bind` as true, so no migration is needed.

### The `attachment` type

A sixth field type. Stored as a string holding a `[[wikilink]]` to a media file — `storageType()` maps it to `string` for validation, and `dbmlColumnType()` to `varchar`.

**No changes to Asset Renamer were needed.** `AssetRenamerModal` builds its property dropdown from `[...Object.keys(frontmatter)]` ([asset-renamer/main.js:98](../../asset-renamer/main.js)), so any frontmatter key on a note is already selectable there. Schema Sync's only obligation is to make sure the key exists, which `recordValuesFor()` does by emitting `""`. Attachment fields are excluded from config list generation, since they hold media links rather than categories.

The 03 panel gains a 🖼 button per record that opens the note and invokes `asset-renamer:open-asset-renamer`, guarded so it reports cleanly when the plugin is disabled.

### Focus-deferred sync (revised after user feedback)

**Superseded the first attempt at direct editing.** Initially a `window.confirm` on `file-open` asked whether to disable safety for the note. That was the wrong mechanism: `metadataCache.on("changed")` still fired on every keystroke pause and ran a full `syncSystem()` 250ms later, rewriting records, base views and config lists mid-edit. Direct editing felt broken because it was — the prompt only stopped the schema note itself being rewritten, not the vault-wide churn around it.

Now: when a schema note is the **active file**, a metadata change adds it to `pendingSchemaEdits` and triggers only `scheduleSchemaPreview()` — a 400ms-debounced `loadSchemas()` + `refreshDashboards()` that reads and renders but writes nothing. The dashboard stays live while typing; nothing is saved.

`flushPendingSchemaEdits()` runs on `active-leaf-change` and `file-open`, and skips any path that is still the active file, so a flush from an unrelated pane switch cannot touch the note being worked on. When the user leaves the note, one `syncSystem()` runs and a notice names the schemas applied.

`syncSchemaDocs()` additionally refuses to rewrite the active file under any trigger, as a second line of defence.

The blocking prompt is gone. A **"Toggle schema safety for the active note"** command replaces it, for the longer case of pinning a schema note open untouched across many syncs; `safetyOff` still auto-releases when the note closes.

### Per-note safety toggle (original design, now secondary)

`safetyOff` and `safetyPrompted` are session-scoped path sets. On `file-open` of a schema note, the user is asked once whether to turn safety off. While a path is in `safetyOff`, `syncSchemaDocs()` skips it entirely — edits flow note → registry via the existing `loadSchemas()` reload, not the other way. `releaseClosedSafetyFiles()` runs on every `file-open` and drops any path no longer open in a leaf, so closing the note re-arms safety and the next open prompts again.

Dashboard-initiated writes still go through, since those are explicit user actions on the file.

### Drag to reorder

A `⠿` handle per row using native HTML5 drag and drop. `dataTransfer.setData` is called on dragstart because Electron refuses to begin a drag without payload data. Drop calls `reorderSchemaFields()`, which rebuilds the field object in the new order — field order is object insertion order throughout, so this propagates to the schema note, base view columns, and the ERD.

### Escape, Enter, and blank names

Rows are locked until ✎ is clicked. On unlock the row's values are snapshotted; Escape restores the snapshot and re-locks without saving, Enter blurs to commit. Escape is handled explicitly because reverting an input on Escape is not dependable in Electron.

`saveSchemaFromDashboard()` now rejects a blank field name outright: it restores the original name in the input, shows a notice, and abandons the entire save rather than writing a partially-renamed schema. Duplicate names are rejected the same way.

### Delete confirmation

`DeleteFieldModal` replaces `window.confirm`, adding a "Don't ask again this session" checkbox that sets `skipDeleteConfirm`. Deliberately session-scoped, never persisted — matching Obsidian's own behaviour for file deletion.

### Layout

Header is `position: sticky` with an opaque background, and its vertical padding and title size are reduced. Field rows drop from 8px to 3px padding, and the editor, schema list and entity list each scroll independently at `max-height: 52vh` so a long schema cannot push the other panels off-screen. Breakpoints at 1150px (two columns, editor takes the full second row) and 780px (single column, field rows wrap).

The existing warm palette and Manrope typography are unchanged — the request was for density and scrolling, not a restyle.

## Batch C — 03 / Relation panel

- The record-creation button is always present, not only when a schema has no records. Label is now `+ New <Schema> record`.
- Each record row gains ⧉ duplicate (copies the file to `<name> 2.md` in the same folder, tracks it, and opens it) and 🖼 asset-renamer buttons, mirroring the 01/Registry row layout.
- Record naming, folder targeting and full-field frontmatter were already fixed in batch A's `implementEntity()`.

## Batch D — the rename bug

**Not reproduced.** The README describes "Rename left blank cause bug unable to rename file — it's not reverse event though I press esc". The surface being renamed was not identified, so three defects that match the description were fixed on the schema-field rename path:

1. Blank name now reverts and aborts the save (above).
2. Escape now genuinely cancels an in-progress row edit (above).
3. **Renaming a field no longer orphans record data.** Previously `saveSchemaFromDashboard()` built the new field map under the new key and wrote it; the old key vanished from the schema while every record kept it, so validation then reported it as undeclared on every note. `renameRecordField()` now moves the key in place across all records implementing the schema, preserving the value, and the save notice names the renames performed.

If the original bug was on a different surface — Obsidian's own file rename, or Asset Renamer's — it is still open and needs a reproduction.

## Testing

The scratchpad `node --test` suite covers 24 cases. Batch B/C additions assert that unbound fields are excluded from records, base columns and DBML while remaining in the schema note; that `bind: true` is never serialised; that attachment fields produce an empty string key and a varchar column; and that `reorderFields` and `renameField` preserve every other field and its position.

UI behaviour — drag, Escape, the safety prompt, the modals — is not unit-testable here and needs manual verification in Obsidian.

## Known gaps

- The safety prompt uses `window.confirm`, which blocks the UI, and fires on every schema-note open. This is what was asked for, but it will be intrusive if schema notes are opened often.
- Config files for a removed or renamed field are never auto-deleted (see batch A), so an unbound or renamed field leaves its `.config.md` behind.
- `isRecordFile()` still special-cases `config/entity.md` for back-compatibility, though nothing generates it any more.
