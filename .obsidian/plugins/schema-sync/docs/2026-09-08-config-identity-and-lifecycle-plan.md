# Config Identity and Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Schema Sync's value lists from flat `data/config/<plural>.config.md` to per-schema `data/config/<Schema>/<field>.md`, link each field to its own list from the Field Reference, keep that list in step through renames, and give the user a way to clear orphans.

**Architecture:** Every decision is extracted as a pure function at the top of `main.js` and exported through `module.exports.generators`, so it can be tested outside Obsidian. Plugin methods stay thin — they gather state, call the pure function, and apply the result. This is the pattern established by `undeclaredPropertyFor()` in the item-1 fix.

**Tech Stack:** Single hand-written `main.js` (no build step), CommonJS, Obsidian plugin API. Tests are plain `node` scripts using `assert`, with a `Module._load` hook stubbing the `obsidian` import.

**Spec:** [2026-09-08-config-identity-and-lifecycle.md](2026-09-08-config-identity-and-lifecycle.md)

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `.obsidian/plugins/schema-sync/main.js` | Everything. Pure helpers at top, `SchemaSyncView`, `SchemaSyncPlugin` | Modify |
| `.obsidian/plugins/schema-sync/tests/undeclared-property.test.js` | Item-1 regression suite | Unchanged |
| `.obsidian/plugins/schema-sync/tests/config-identity.test.js` | This spec's pure functions | Create |

`main.js` is ~2280 lines and already organised as *pure helpers → modals → view → plugin*. New pure functions go beside `configFileNameFor` at line ~273. Splitting the file is out of scope: it matches every other plugin in this vault and the spec does not call for restructuring.

### Deviation from the spec, recorded

The spec says config notes are located "by `configFor` frontmatter, never by filename". After Task 4 the path is *derived* from schema plus field, so path and `configFor` are the same fact. Tasks 5 and 7 therefore locate by path and use `configFor` to confirm. The relocation pass in Task 4 is what establishes that invariant, and it does read `configFor`.

### Cut from the spec

The vault now contains only the three schema notes — all records, configs, bases and `schema-mappings.md` were cleared before implementation. C6's multi-source legacy copy path is dropped as speculation. The single-note flat-to-foldered relocation is kept as cheap insurance.

---

## Task 1: Field name normalisation

**Files:**
- Modify: `.obsidian/plugins/schema-sync/main.js` (add near line 273)
- Test: `.obsidian/plugins/schema-sync/tests/config-identity.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `.obsidian/plugins/schema-sync/tests/config-identity.test.js`:

```js
// Run with:  node .obsidian/plugins/schema-sync/tests/config-identity.test.js
//
// Covers the pure decisions behind README items 2, 3 and 6. See
// docs/2026-09-08-config-identity-and-lifecycle.md.

const Module = require("module");
const assert = require("assert");

// main.js does `require("obsidian")` at load time. Obsidian only exists inside
// the app, so intercept the specifier and hand back inert class stubs.
const obsidian = new Proxy({}, {
  get: (_, name) => {
    const Stub = class {};
    Object.defineProperty(Stub, "name", { value: String(name) });
    return Stub;
  },
});
const load = Module._load;
Module._load = function (request, parent, isMain) {
  return request === "obsidian" ? obsidian : load.call(this, request, parent, isMain);
};

const { generators } = require(require("path").join(__dirname, "..", "main.js"));
const { normalizeFieldName, fieldNameError } = generators;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a bare name is returned trimmed", () => {
  assert.strictEqual(normalizeFieldName("  trait  "), "trait");
});

test("a wikilink is reduced to its target", () => {
  assert.strictEqual(normalizeFieldName("[[Planet]]"), "Planet");
});

test("a path-qualified aliased link reduces to the field name", () => {
  assert.strictEqual(normalizeFieldName("[[LifeForm/trait|trait]]"), "trait");
});

test("a heading anchor is dropped", () => {
  assert.strictEqual(normalizeFieldName("[[trait#Values]]"), "trait");
});

test("a trailing .config is stripped", () => {
  // Asset Renamer used to derive property names from config filenames.
  assert.strictEqual(normalizeFieldName("Cultures.config"), "Cultures");
});

test("null and undefined normalise to empty", () => {
  assert.strictEqual(normalizeFieldName(null), "");
  assert.strictEqual(normalizeFieldName(undefined), "");
});

test("a blank name is an error", () => {
  assert.ok(fieldNameError(""));
});

test("a name that would escape the config folder is an error", () => {
  assert.ok(fieldNameError("a/b"));
  assert.ok(fieldNameError("a\\b"));
  assert.ok(fieldNameError("a:b"));
  assert.ok(fieldNameError("a|b"));
});

test("an ordinary name is not an error", () => {
  assert.strictEqual(fieldNameError("trait"), null);
  assert.strictEqual(fieldNameError("Realm"), null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passing`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: FAIL, every test reporting `normalizeFieldName is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `main.js`, immediately after `configFileNameFor()` (line ~277), add:

```js
const ILLEGAL_FIELD_NAME = /[\\/:#^|[\]]/;

// A field name typed as a wikilink is the user reaching for the value list the
// field points at. Keep the target, drop the brackets: the link belongs in the
// Field Reference cell, which the generator writes, not in `fields:`. A trailing
// ".config" goes too — Asset Renamer used to derive property names from config
// filenames, which is where fields called "Cultures.config" came from.
function normalizeFieldName(raw) {
  let text = String(raw ?? "").trim();
  const link = text.match(/^\[\[([^\]]+)\]\]$/);
  if (link) {
    text = link[1].split("|")[0].split("#")[0];
    text = text.slice(text.lastIndexOf("/") + 1);
  }
  return text.trim().replace(/\.config$/i, "").trim();
}

// A field name is a file name now, so it has to survive being one.
function fieldNameError(name) {
  if (!name) return "A field name cannot be blank.";
  if (ILLEGAL_FIELD_NAME.test(name)) return `"${name}" cannot be a field name: / \\ : # ^ | [ and ] are not allowed in a file name.`;
  return null;
}
```

Add to `module.exports.generators` (line ~2262), after `configFileNameFor`:

```js
  normalizeFieldName,
  fieldNameError,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: `9/9 passing`

- [ ] **Step 5: Verify the item-1 suite still passes**

Run: `node .obsidian/plugins/schema-sync/tests/undeclared-property.test.js`
Expected: `13/13 passing`

- [ ] **Step 6: Commit**

```bash
git add .obsidian/plugins/schema-sync/main.js .obsidian/plugins/schema-sync/tests/config-identity.test.js
git commit -m "Normalise field names typed as wikilinks"
```

---

## Task 2: Config notes move to per-schema folders

**Files:**
- Modify: `.obsidian/plugins/schema-sync/main.js` — replace `configFileNameFor` (line ~273), `renderConfigNote` (line ~191), delete `pluralize` (line ~106), update three call sites
- Test: `.obsidian/plugins/schema-sync/tests/config-identity.test.js`

- [ ] **Step 1: Write the failing test**

Append to `config-identity.test.js`, before the runner block at the bottom:

```js
const { configPathFor } = generators;

const STRING = { type: "string", bind: true };

test("a bound string field gets a config under its schema's folder", () => {
  assert.strictEqual(configPathFor("LifeForm", "trait", STRING), "data/config/LifeForm/trait.md");
});

test("two schemas with the same field name get separate notes", () => {
  assert.strictEqual(configPathFor("Beast", "trait", STRING), "data/config/Beast/trait.md");
  assert.notStrictEqual(configPathFor("Beast", "trait", STRING), configPathFor("LifeForm", "trait", STRING));
});

test("an unbound field has no config", () => {
  assert.strictEqual(configPathFor("LifeForm", "attachment", { type: "string", bind: false }), null);
});

test("a relation field has no config of its own", () => {
  assert.strictEqual(configPathFor("Verse", "Realm", { type: "string", bind: true, relation: { target: "Realm" } }), null);
});

test("an identity field has no config", () => {
  assert.strictEqual(configPathFor("LifeForm", "id", { type: "string", bind: true, required: true }), null);
  assert.strictEqual(configPathFor("LifeForm", "name", STRING), null);
});

test("a non-string field has no config", () => {
  assert.strictEqual(configPathFor("LifeForm", "cover", { type: "attachment", bind: true }), null);
  assert.strictEqual(configPathFor("LifeForm", "count", { type: "number", bind: true }), null);
});

test("the config note heading is the field name, not a plural", () => {
  const note = generators.renderConfigNote("trait", ["LifeForm.trait"], ["bold"], "");
  assert.ok(note.includes("# trait"), note.slice(0, 200));
  assert.ok(!note.includes("# traits"));
});

test("pluralize is gone", () => {
  assert.strictEqual(generators.pluralize, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: FAIL with `configPathFor is not a function`.

- [ ] **Step 3: Replace `configFileNameFor` with `configPathFor`**

In `main.js`, replace the whole `configFileNameFor` function (line ~269-277) with:

```js
// One value list per schema plus field, namespaced by schema so two schemas may
// both declare `trait` without sharing a note. The folder carries the convention
// that `.config.md` used to; the file is named for the field so a link to it
// reads as the field name.
function configPathFor(schemaName, fieldName, definition) {
  if (!definition || definition.type !== "string" || definition.relation?.target || !isBound(definition)) return null;
  if (IDENTITY_FIELDS.has(String(fieldName).toLowerCase())) return null;
  return `${CONFIG_FOLDER}/${schemaName}/${fieldName}.md`;
}
```

- [ ] **Step 4: Drop `pluralize`**

Delete the `pluralize` function (line ~102-108) and its `generators` entry. In `renderConfigNote` (line ~201), change:

```js
    `# ${pluralize(attributeName)}`,
```

to:

```js
    `# ${attributeName}`,
```

Replace `configFileNameFor,` in `module.exports.generators` with `configPathFor,`.

- [ ] **Step 5: Update the three call sites**

**5a.** In `SchemaSyncView.render()` (line ~546), inside the field-row template, replace both `configFileNameFor(name, definition)` occurrences with `configPathFor(schemaName, name, definition)`, and change the button title so it names the full path:

```js
<button data-open-config="${name}" class="schema-sync-row-action ${configPathFor(schemaName, name, definition) ? "" : "is-muted"}" title="${configPathFor(schemaName, name, definition) ? `Open ${configPathFor(schemaName, name, definition)}` : `${name} has no value list`}">☰</button>
```

**5b.** In `openFieldConfig()` (line ~1795), replace:

```js
    const fileName = configFileNameFor(fieldName, definition);
    if (!fileName) {
```

with:

```js
    const path = configPathFor(schemaName, fieldName, definition);
    if (!path) {
```

and delete the now-duplicated line further down:

```js
    const path = normalizePath(`${CONFIG_FOLDER}/${fileName}`);
```

replacing it with nothing — `path` is already the full vault path. The `getAbstractFileByPath(path)` call below is unchanged apart from wrapping: `const file = this.app.vault.getAbstractFileByPath(normalizePath(path));`

**5c.** In `syncConfigLists()` (line ~1960), the `configFileNameFor` call is replaced wholesale in Task 4. Leave it for now by changing only the call so the file parses:

```js
        const fileName = configPathFor(schemaName, fieldName, definition);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: `17/17 passing`

Run: `node .obsidian/plugins/schema-sync/tests/undeclared-property.test.js`
Expected: `13/13 passing`

- [ ] **Step 7: Commit**

```bash
git add .obsidian/plugins/schema-sync/main.js .obsidian/plugins/schema-sync/tests/config-identity.test.js
git commit -m "Namespace config notes by schema"
```

---

## Task 3: Field Reference links to the value list

**Files:**
- Modify: `.obsidian/plugins/schema-sync/main.js` — `renderFieldReference` (line ~278), `parseFieldReferenceRows` (line ~226), `renderSchemaNote` (line ~314), `writeSchemaFile`
- Test: `.obsidian/plugins/schema-sync/tests/config-identity.test.js`

- [ ] **Step 1: Write the failing test**

Append to `config-identity.test.js` before the runner:

```js
const { fieldReferenceLink, renderFieldReference, parseFieldReference } = generators;

const SCHEMAS = new Map([
  ["Realm", { Realm: { type: "string", bind: true, required: true } }],
  ["LifeForm", {
    id: { type: "string", bind: true, required: true },
    cover: { type: "attachment", bind: true },
    trait: { type: "string", bind: true },
    attachment: { type: "string", bind: false },
  }],
]);

test("a field with a config links to it, path-qualified and aliased", () => {
  assert.strictEqual(fieldReferenceLink("LifeForm", "trait", SCHEMAS.get("LifeForm").trait, SCHEMAS), "[[LifeForm/trait|trait]]");
});

test("a relation links to the target schema's own-name config", () => {
  const field = { type: "string", bind: false, relation: { target: "Realm" } };
  assert.strictEqual(fieldReferenceLink("Verse", "Realm", field, SCHEMAS), "[[Realm/Realm|Realm]]");
});

test("a relation whose target has no own-name field links to the schema note", () => {
  const field = { type: "string", bind: true, relation: { target: "LifeForm" } };
  assert.strictEqual(fieldReferenceLink("Pack", "owner", field, SCHEMAS), "[[LifeForm.schema|owner]]");
});

test("a field with no config is plain text", () => {
  assert.strictEqual(fieldReferenceLink("LifeForm", "id", SCHEMAS.get("LifeForm").id, SCHEMAS), "id");
  assert.strictEqual(fieldReferenceLink("LifeForm", "attachment", SCHEMAS.get("LifeForm").attachment, SCHEMAS), "attachment");
});

test("the rendered table round trips back to plain field names", () => {
  const table = renderFieldReference("LifeForm", SCHEMAS.get("LifeForm"), SCHEMAS);
  const parsed = parseFieldReference(`## Field Reference\n\n${table}`);
  assert.deepStrictEqual(Object.keys(parsed), ["id", "cover", "trait", "attachment"]);
});

test("a linked row round trips without keeping the brackets", () => {
  const table = renderFieldReference("Verse", { Realm: { type: "string", bind: false, relation: { target: "Realm" } } }, SCHEMAS);
  assert.ok(table.includes("[[Realm/Realm|Realm]]"), table);
  assert.deepStrictEqual(Object.keys(parseFieldReference(`## Field Reference\n\n${table}`)), ["Realm"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: FAIL with `fieldReferenceLink is not a function`.

- [ ] **Step 3: Add `fieldReferenceLink` and rewrite `renderFieldReference`**

In `main.js`, replace `renderFieldReference` (line ~278-284) with:

```js
// What the Field column points at. A link means "this field has somewhere to
// go"; plain text means it has not. Path-qualified because Obsidian resolves a
// wikilink by basename alone, and two schemas may both declare `trait`. Aliased
// so the cell still reads as the bare field name.
function fieldReferenceLink(schemaName, fieldName, definition, schemas) {
  const target = definition?.relation?.target;
  if (target) {
    // A foreign key never gets a list of its own: it points at the one list the
    // target entity already owns, so the values cannot drift between the two.
    const targetFields = schemas?.get?.(target);
    const ownField = targetFields && Object.prototype.hasOwnProperty.call(targetFields, target) ? targetFields[target] : null;
    if (ownField && configPathFor(target, target, ownField)) return `[[${target}/${target}|${fieldName}]]`;
    // Nothing to point at — `id` is an identity field and excluded from lists —
    // so fall back to the entity's own definition.
    return `[[${target}.schema|${fieldName}]]`;
  }
  return configPathFor(schemaName, fieldName, definition) ? `[[${schemaName}/${fieldName}|${fieldName}]]` : fieldName;
}

// Carries every property a field has, Relation included, so the table is a
// lossless representation of `fields:` and a bottom-to-top pull cannot drop
// anything it is unable to express.
function renderFieldReference(schemaName, fields, schemas) {
  const rows = Object.entries(fields).map(([name, field]) =>
    `| ${fieldReferenceLink(schemaName, name, field, schemas)} | ${field.type} | ${field.hasDefault ? yamlValue(field.defaultValue) : "-"} | ${field.required ? "yes" : "no"} | ${isBound(field) ? "yes" : "no"} | ${field.relation?.target || "-"} |`);
  return `## Field Reference\n\n| Field | Type | Default | Required | Bound | Relation |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
}
```

- [ ] **Step 4: Strip the link when reading the table back**

In `parseFieldReferenceRows` (line ~233), replace:

```js
    const [name, type, defaultCell, required, bound, relation] = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
```

with:

```js
    // The Field cell is a wikilink now, so an aliased link splits on "|" into
    // two cells. Rejoin them before reading the columns.
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells[0].startsWith("[[") && !cells[0].endsWith("]]")) cells.splice(0, 2, `${cells[0]}|${cells[1]}`);
    const [rawName, type, defaultCell, required, bound, relation] = cells;
    const name = normalizeFieldName(rawName);
```

and delete the now-stale guard line that referenced the raw name, replacing:

```js
    if (!name || /^:?-{2,}:?$/.test(name) || name.toLowerCase() === "field") continue;
```

with the same line — it is unchanged, but must now sit *after* the `name` assignment above.

- [ ] **Step 5: Thread the schema name through `renderSchemaNote`**

In `renderSchemaNote` (line ~314), change the signature and the `renderFieldReference` call:

```js
function renderSchemaNote(name, fields, sourcePath, body, existingRaw, schemas) {
```

and inside it, replace `renderFieldReference(fields)` with `renderFieldReference(name, fields, schemas)`.

In `writeSchemaFile`, pass `this.schemas` as the new final argument to `renderSchemaNote(...)`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: `23/23 passing`

Run: `node .obsidian/plugins/schema-sync/tests/undeclared-property.test.js`
Expected: `13/13 passing`

- [ ] **Step 7: Commit**

```bash
git add .obsidian/plugins/schema-sync/main.js .obsidian/plugins/schema-sync/tests/config-identity.test.js
git commit -m "Link each field to its value list from the Field Reference"
```

---

## Task 4: Generate config notes into schema folders

**Files:**
- Modify: `.obsidian/plugins/schema-sync/main.js` — `syncConfigLists` (line ~1954)

- [ ] **Step 1: Rewrite `syncConfigLists`**

Replace the whole method body with:

```js
  // One note per schema plus field. Values found in records are unioned with
  // whatever the file already holds, so hand-added options are never dropped.
  // Deliberately not registered as generated paths: they carry user-curated
  // content and must survive a field being renamed or removed.
  async syncConfigLists() {
    await this.relocateConfigNotes();
    const targets = new Map();
    for (const [schemaName, fields] of this.schemas) {
      for (const [fieldName, definition] of Object.entries(fields)) {
        const path = configPathFor(schemaName, fieldName, definition);
        if (path) targets.set(path, { schemaName, fieldName, values: new Set() });
      }
    }
    if (targets.size === 0) return;
    for (const file of this.dataFiles()) {
      if (file.basename.startsWith(PLACEHOLDER_PREFIX)) continue;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!frontmatter || typeof frontmatter.implements !== "string") continue;
      for (const entry of targets.values()) {
        if (entry.schemaName !== frontmatter.implements) continue;
        const raw = frontmatter[entry.fieldName];
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          const text = typeof value === "string" ? value.trim().replace(/^\[\[|\]\]$/g, "").trim() : "";
          if (text) entry.values.add(text);
        }
      }
    }
    for (const [path, entry] of targets) {
      await this.ensureFolder(`${CONFIG_FOLDER}/${entry.schemaName}`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      const existingRaw = existing instanceof TFile ? await this.app.vault.read(existing) : "";
      await this.writeFile(normalizePath(path), renderConfigNote(entry.fieldName, [`${entry.schemaName}.${entry.fieldName}`], [...entry.values], existingRaw));
    }
  }

  // Notes written by an older version sit flat in data/config/. Move each into
  // its schema's folder before generation runs, so generation does not create an
  // empty note at the new path and leave the old one looking like an orphan.
  async relocateConfigNotes() {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.parent?.path !== CONFIG_FOLDER) continue;
      const sources = this.app.metadataCache.getFileCache(file)?.frontmatter?.configFor;
      const source = Array.isArray(sources) ? sources[0] : null;
      if (typeof source !== "string" || !source.includes(".")) continue;
      const schemaName = source.slice(0, source.indexOf("."));
      const fieldName = source.slice(source.indexOf(".") + 1);
      if (!this.schemas.has(schemaName)) continue;
      const destination = normalizePath(`${CONFIG_FOLDER}/${schemaName}/${fieldName}.md`);
      if (file.path === destination || this.app.vault.getAbstractFileByPath(destination)) continue;
      await this.ensureFolder(`${CONFIG_FOLDER}/${schemaName}`);
      await this.app.fileManager.renameFile(file, destination);
      new Notice(`Moved ${file.name} to ${destination}.`);
    }
  }
```

- [ ] **Step 2: Verify the file still parses**

Run: `node -e "require('module')._load=((l)=>function(r,p,m){return r==='obsidian'?new Proxy({},{get:()=>class{}}):l.call(this,r,p,m)})(require('module')._load); require('d:/1_doc/MyVault/.obsidian/plugins/schema-sync/main.js'); console.log('parses')"`
Expected: `parses`

- [ ] **Step 3: Run both suites**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: `23/23 passing`

Run: `node .obsidian/plugins/schema-sync/tests/undeclared-property.test.js`
Expected: `13/13 passing`

- [ ] **Step 4: Verify in Obsidian**

Reload the plugin, run **Sync schema system**. Expect exactly:

```
data/config/LifeForm/trait.md      configFor: [LifeForm.trait]
data/config/Realm/Realm.md         configFor: [Realm.Realm]
```

and no note for `LifeForm.id`, `LifeForm.cover`, `LifeForm.attachment` or `Verse.Realm`. Open `data/schema/Verse.schema.md` and confirm the Field cell reads `Realm` and links to `data/config/Realm/Realm.md`.

- [ ] **Step 5: Commit**

```bash
git add .obsidian/plugins/schema-sync/main.js
git commit -m "Generate config notes into per-schema folders"
```

---

## Task 5: Keep the config note through a field rename

**Files:**
- Modify: `.obsidian/plugins/schema-sync/main.js` — add pure function near line ~300, `saveSchemaFromDashboard` (line ~1387)
- Test: `.obsidian/plugins/schema-sync/tests/config-identity.test.js`

- [ ] **Step 1: Write the failing test**

Append before the runner:

```js
const { configRenamePlan } = generators;

test("renaming a field renames its config note", () => {
  const paths = new Set(["data/config/LifeForm/trait.md"]);
  assert.deepStrictEqual(configRenamePlan({ schemaName: "LifeForm", oldName: "trait", newName: "feature", existingPaths: paths }), {
    action: "rename",
    from: "data/config/LifeForm/trait.md",
    to: "data/config/LifeForm/feature.md",
    configFor: "LifeForm.feature",
  });
});

test("a field with no config note needs no action", () => {
  assert.deepStrictEqual(configRenamePlan({ schemaName: "LifeForm", oldName: "trait", newName: "feature", existingPaths: new Set() }), { action: "none" });
});

test("an occupied target is reported, never merged", () => {
  const paths = new Set(["data/config/LifeForm/trait.md", "data/config/LifeForm/feature.md"]);
  const plan = configRenamePlan({ schemaName: "LifeForm", oldName: "trait", newName: "feature", existingPaths: paths });
  assert.strictEqual(plan.action, "conflict");
  assert.strictEqual(plan.to, "data/config/LifeForm/feature.md");
});

test("a rename inside one schema never touches another schema's note", () => {
  const paths = new Set(["data/config/Beast/trait.md"]);
  assert.deepStrictEqual(configRenamePlan({ schemaName: "LifeForm", oldName: "trait", newName: "feature", existingPaths: paths }), { action: "none" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: FAIL with `configRenamePlan is not a function`.

- [ ] **Step 3: Add the pure plan**

In `main.js`, after `fieldReferenceLink`, add:

```js
// Merging two config notes would silently discard one side's hand-written Notes
// column, which is the whole reason these files are never auto-deleted. Since
// two fields in one schema cannot share a name, an occupied target can only be a
// leftover from an earlier failed rename — so report it and let the user clear
// it with the orphan cleanup, rather than merging behind their back.
function configRenamePlan({ schemaName, oldName, newName, existingPaths }) {
  const from = `${CONFIG_FOLDER}/${schemaName}/${oldName}.md`;
  if (!existingPaths.has(from)) return { action: "none" };
  const to = `${CONFIG_FOLDER}/${schemaName}/${newName}.md`;
  if (existingPaths.has(to)) return { action: "conflict", from, to };
  return { action: "rename", from, to, configFor: `${schemaName}.${newName}` };
}
```

Add `configRenamePlan,` to `module.exports.generators`.

- [ ] **Step 4: Apply the plan on rename**

In `saveSchemaFromDashboard` (line ~1387), replace:

```js
      const typed = input?.value.trim() || "";
```

with:

```js
      const typed = normalizeFieldName(input?.value);
```

and replace the blank-name guard:

```js
      if (input && !typed) {
        input.value = original;
        new Notice(`A field name cannot be blank. Reverted to "${original}".`);
        return;
      }
```

with:

```js
      const nameError = input ? fieldNameError(typed) : null;
      if (nameError) {
        input.value = original;
        new Notice(`${nameError} Reverted to "${original}".`);
        return;
      }
```

Make the duplicate check case-insensitive — the two names are two file names on a case-insensitive filesystem. Replace:

```js
      if (Object.prototype.hasOwnProperty.call(fields, name)) {
```

with:

```js
      if (Object.keys(fields).some((existing) => existing.toLowerCase() === name.toLowerCase())) {
```

Then replace the rename loop:

```js
    for (const [oldName, newName] of renames) await this.renameRecordField(schemaName, oldName, newName);
```

with:

```js
    // Before writeSchemaFile: renameFile makes Obsidian rewrite every
    // [[Schema/field|field]] in the vault, and our own regeneration of the
    // schema note has to be the last write to land.
    for (const [oldName, newName] of renames) {
      await this.renameRecordField(schemaName, oldName, newName);
      await this.renameFieldConfig(schemaName, oldName, newName);
    }
```

Add the method next to `renameRecordField`:

```js
  async renameFieldConfig(schemaName, oldName, newName) {
    const existingPaths = new Set(this.app.vault.getMarkdownFiles().map((file) => file.path));
    const plan = configRenamePlan({ schemaName, oldName, newName, existingPaths });
    if (plan.action === "none") return;
    if (plan.action === "conflict") {
      return new Notice(`${plan.to} already exists, so "${oldName}" kept its own value list at ${plan.from}. Clear the leftover from 01 / Registry, then rename again.`, 10000);
    }
    const file = this.app.vault.getAbstractFileByPath(plan.from);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.renameFile(file, normalizePath(plan.to));
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.configFor = [plan.configFor];
    });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: `27/27 passing`

Run: `node .obsidian/plugins/schema-sync/tests/undeclared-property.test.js`
Expected: `13/13 passing`

- [ ] **Step 6: Verify in Obsidian**

Reload. In 02/Definition for LifeForm, rename `trait` to `feature` and press Enter. Expect `data/config/LifeForm/trait.md` to become `data/config/LifeForm/feature.md` with `configFor: [LifeForm.feature]`, **one** note in `data/config/LifeForm/`, and the schema note's Field cell reading `feature` linked to the new path. Rename it back to `trait` afterwards.

- [ ] **Step 7: Commit**

```bash
git add .obsidian/plugins/schema-sync/main.js .obsidian/plugins/schema-sync/tests/config-identity.test.js
git commit -m "Rename a field's config note with the field"
```

---

## Task 6: Keep config notes through a schema rename

**Files:**
- Modify: `.obsidian/plugins/schema-sync/main.js` — `handleTrackedRename` (line ~1620)

- [ ] **Step 1: Rename the folder when a schema note is renamed**

In `handleTrackedRename(oldPath, newPath)`, immediately after the existing `schemaSource` loop and before `this.refreshDashboards();`, add:

```js
    // A schema note rename moves the whole folder of value lists with it, so the
    // configFor back-links stay true and nothing is left looking orphaned.
    if (this.isSchemaPath(oldPath) && this.isSchemaPath(newPath)) {
      const oldSchema = oldPath.split("/").pop().replace(/\.schema\.md$/i, "");
      const newSchema = newPath.split("/").pop().replace(/\.schema\.md$/i, "");
      const folder = this.app.vault.getAbstractFileByPath(`${CONFIG_FOLDER}/${oldSchema}`);
      if (oldSchema !== newSchema && folder && !this.app.vault.getAbstractFileByPath(`${CONFIG_FOLDER}/${newSchema}`)) {
        await this.app.fileManager.renameFile(folder, normalizePath(`${CONFIG_FOLDER}/${newSchema}`));
        for (const file of this.app.vault.getMarkdownFiles()) {
          if (file.parent?.path !== `${CONFIG_FOLDER}/${newSchema}`) continue;
          await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            frontmatter.configFor = [`${newSchema}.${file.basename}`];
          });
        }
        new Notice(`Moved ${oldSchema}'s value lists to ${CONFIG_FOLDER}/${newSchema}.`);
      }
    }
```

- [ ] **Step 2: Verify the file still parses**

Run: `node -e "require('module')._load=((l)=>function(r,p,m){return r==='obsidian'?new Proxy({},{get:()=>class{}}):l.call(this,r,p,m)})(require('module')._load); require('d:/1_doc/MyVault/.obsidian/plugins/schema-sync/main.js'); console.log('parses')"`
Expected: `parses`

- [ ] **Step 3: Verify in Obsidian**

Reload. Rename `data/schema/Realm.schema.md` to `data/schema/Domain.schema.md`. Expect `data/config/Realm/` to become `data/config/Domain/` with `configFor: [Domain.Realm]` inside. Rename it back.

- [ ] **Step 4: Commit**

```bash
git add .obsidian/plugins/schema-sync/main.js
git commit -m "Move value lists with a renamed schema"
```

---

## Task 7: Clean orphaned config notes

**Files:**
- Modify: `.obsidian/plugins/schema-sync/main.js` — pure function near line ~300, new modal near `ConfirmDeleteModal` (line ~402), 01/Registry panel in `SchemaSyncView.render()`, new plugin method
- Test: `.obsidian/plugins/schema-sync/tests/config-identity.test.js`

- [ ] **Step 1: Write the failing test**

Append before the runner:

```js
const { orphanedConfigs } = generators;

const NOTES = [
  { path: "data/config/LifeForm/trait.md", schemaName: "LifeForm", fieldName: "trait" },
  { path: "data/config/LifeForm/gone.md", schemaName: "LifeForm", fieldName: "gone" },
  { path: "data/config/Ghost/anything.md", schemaName: "Ghost", fieldName: "anything" },
  { path: "data/config/LifeForm/attachment.md", schemaName: "LifeForm", fieldName: "attachment" },
];

test("a note whose field still exists is live", () => {
  assert.ok(!orphanedConfigs(NOTES, SCHEMAS).some((note) => note.path === "data/config/LifeForm/trait.md"));
});

test("a note whose field was deleted is an orphan", () => {
  assert.ok(orphanedConfigs(NOTES, SCHEMAS).some((note) => note.path === "data/config/LifeForm/gone.md"));
});

test("a note whose schema was deleted is an orphan", () => {
  assert.ok(orphanedConfigs(NOTES, SCHEMAS).some((note) => note.path === "data/config/Ghost/anything.md"));
});

test("an unbound field keeps its list, so unbinding stays reversible", () => {
  assert.ok(!orphanedConfigs(NOTES, SCHEMAS).some((note) => note.path === "data/config/LifeForm/attachment.md"));
});

test("exactly two of the four are orphaned", () => {
  assert.strictEqual(orphanedConfigs(NOTES, SCHEMAS).length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: FAIL with `orphanedConfigs is not a function`.

- [ ] **Step 3: Add the pure rule**

In `main.js`, after `configRenamePlan`, add:

```js
// A value list is orphaned only when its field is gone from the schema entirely,
// or the schema itself is gone. Bind state is deliberately irrelevant: unbinding
// a field is the reversible first press of the x button, and throwing away its
// curated values would make that press destructive after all.
function orphanedConfigs(notes, schemas) {
  return notes.filter(({ schemaName, fieldName }) => {
    const fields = schemas.get(schemaName);
    return !fields || !Object.prototype.hasOwnProperty.call(fields, fieldName);
  });
}
```

Add `orphanedConfigs,` to `module.exports.generators`.

- [ ] **Step 4: Add the picker modal**

After `ConfirmDeleteModal` (line ~437), add:

```js
class OrphanedConfigModal extends Modal {
  constructor(app, orphans, onResolve) {
    super(app);
    this.orphans = orphans;
    this.onResolve = onResolve;
    this.chosen = new Set();
    this.answered = false;
  }

  resolve(paths) {
    if (this.answered) return;
    this.answered = true;
    this.onResolve(paths);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `${this.orphans.length} value list(s) no longer belong to a schema` });
    contentEl.createEl("p", { text: "These carry rows and notes you may have written by hand, so nothing is selected and nothing is deleted until you say so. Selected files go to the trash." });
    const list = contentEl.createDiv({ cls: "schema-sync-orphans" });
    for (const orphan of this.orphans) {
      const row = list.createDiv({ cls: "schema-sync-choice" });
      const box = row.createEl("input", { type: "checkbox" });
      box.addEventListener("change", () => box.checked ? this.chosen.add(orphan.path) : this.chosen.delete(orphan.path));
      row.createEl("span", { text: orphan.path });
      row.createEl("small", { text: `${orphan.schemaName}.${orphan.fieldName} is no longer declared — ${orphan.rows} row(s)` });
    }
    const actions = contentEl.createDiv({ cls: "schema-sync-choices" });
    actions.createEl("button", { text: "Move selected to trash", cls: "mod-warning" })
      .addEventListener("click", () => this.resolve([...this.chosen]));
    actions.createEl("button", { text: "Keep everything" })
      .addEventListener("click", () => this.resolve([]));
  }

  onClose() {
    this.contentEl.empty();
    // Dismissing is not an instruction to delete anything.
    this.resolve([]);
  }
}
```

- [ ] **Step 5: Add the plugin method**

Next to `openFieldConfig`, add:

```js
  // Config notes are never auto-deleted — they hold a hand-curated Notes column —
  // so this is the one path that removes them, and only with the user choosing
  // each file.
  async cleanOrphanedConfigs() {
    const notes = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${CONFIG_FOLDER}/`) || file.path === SCHEMA_MAPPING_FILE) continue;
      const sources = this.app.metadataCache.getFileCache(file)?.frontmatter?.configFor;
      const source = Array.isArray(sources) ? sources[0] : null;
      if (typeof source !== "string" || !source.includes(".")) continue;
      notes.push({
        path: file.path,
        schemaName: source.slice(0, source.indexOf(".")),
        fieldName: source.slice(source.indexOf(".") + 1),
        rows: parseConfigValues(await this.app.vault.read(file)).length,
      });
    }
    const orphans = orphanedConfigs(notes, this.schemas);
    if (orphans.length === 0) return new Notice("Every value list still belongs to a declared field.");
    const chosen = await new Promise((resolve) => new OrphanedConfigModal(this.app, orphans, resolve).open());
    for (const path of chosen) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(file);
      else await this.app.vault.trash(file, true);
    }
    this.refreshDashboards();
    new Notice(chosen.length ? `Moved ${chosen.length} value list(s) to the trash.` : "Nothing was deleted.");
  }
```

- [ ] **Step 6: Add the button to 01/Registry**

In `SchemaSyncView.render()`, find the `01 / Registry` panel markup and append a button to its header:

```js
<button data-clean-orphans class="schema-sync-row-action" title="Find value lists whose field or schema no longer exists">Clean orphaned configs</button>
```

and register the handler alongside the other `querySelectorAll` bindings in that panel:

```js
          containerEl.querySelector("[data-clean-orphans]")?.addEventListener("click", () => void this.plugin.cleanOrphanedConfigs());
```

Add a command so it is reachable without the dashboard, next to the other `addCommand` calls in `onload`:

```js
    this.addCommand({
      id: "clean-orphaned-configs",
      name: "Clean orphaned config notes",
      callback: () => this.cleanOrphanedConfigs(),
    });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node .obsidian/plugins/schema-sync/tests/config-identity.test.js`
Expected: `32/32 passing`

Run: `node .obsidian/plugins/schema-sync/tests/undeclared-property.test.js`
Expected: `13/13 passing`

- [ ] **Step 8: Verify in Obsidian**

Reload. Delete the `trait` field from LifeForm entirely (press × twice), then run **Clean orphaned config notes**. Expect `data/config/LifeForm/trait.md` listed with its row count, nothing preselected, and the file only moved to trash after you tick it and confirm.

- [ ] **Step 9: Commit**

```bash
git add .obsidian/plugins/schema-sync/main.js .obsidian/plugins/schema-sync/tests/config-identity.test.js
git commit -m "Add orphaned config cleanup"
```

---

## Task 8: Update the README

**Files:**
- Modify: `README.md` — the Layout and Naming conventions sections, and problems 2, 3 and 6

- [ ] **Step 1: Update the layout block**

In `README.md`, replace the `data/config/` lines of the layout tree with:

```
│   ├── config/
│   │   ├── <Schema>/<field>.md        Auto-generated value list for one field
│   │   └── schema-mappings.md         Plugin bookkeeping (bindings, tracked paths)
```

- [ ] **Step 2: Update the naming table**

Replace the `.config.md` row of the Naming conventions table with:

```
| `config/<Schema>/<field>.md` | matches the field | Unique values of one field; behaves like a set of enum options |
```

- [ ] **Step 3: Mark problems 1, 2, 3 and 6 done**

Prefix each with `~~` / `~~` strikethrough or move them to a "Done" heading, whichever matches how the user tracks the rest of the list.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document the per-schema config layout"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| C1 config identity | 2 |
| C2 field name normalisation | 1, and wired in 5 |
| C3 Field Reference links | 3 |
| C4 rename sync — field | 5 |
| C4 rename sync — schema | 6 |
| C5 orphan cleanup | 7 |
| C6 migration (reduced) | 4, `relocateConfigNotes` |
| C7 tests | Every task |
| R2 case-insensitive duplicates | 5, step 4 |
| R4 scope additions | 1 (illegal chars, `.config`), 2 (`pluralize`), 3 (FK fallback), 5 (case) |

**Not covered, deliberately:** R1's proposed sync-time basename collision warning. It is listed in the spec as "proposed but not specified", and adding it here would be scope the user has not agreed to. Raise it after Task 7.

**Type consistency:** `configPathFor(schemaName, fieldName, definition)` returns a full vault path in every use — Tasks 2, 3, 4. `configRenamePlan` returns `{action}` with `action` in `none | rename | conflict` — Task 5 only. `orphanedConfigs(notes, schemas)` takes `{path, schemaName, fieldName, rows}` from Task 7 step 5 and the test in step 1 matches. `renderFieldReference(schemaName, fields, schemas)` and `renderSchemaNote(name, fields, sourcePath, body, existingRaw, schemas)` both gain arguments in Task 3 and every caller is updated there.
