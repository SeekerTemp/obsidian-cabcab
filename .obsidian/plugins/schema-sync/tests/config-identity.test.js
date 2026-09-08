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

// --- Task 1: field name normalisation --------------------------------------

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

// --- Task 2: per-schema config folders -------------------------------------

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

// --- Task 3: Field Reference links -----------------------------------------

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
  const parsed = parseFieldReference(table);
  assert.deepStrictEqual(Object.keys(parsed), ["id", "cover", "trait", "attachment"]);
});

test("a linked row round trips without keeping the brackets", () => {
  const table = renderFieldReference("Verse", { Realm: { type: "string", bind: false, relation: { target: "Realm" } } }, SCHEMAS);
  assert.ok(table.includes("[[Realm/Realm|Realm]]"), table);
  assert.deepStrictEqual(Object.keys(parseFieldReference(table)), ["Realm"]);
});

test("a linked row keeps its other columns intact", () => {
  const table = renderFieldReference("LifeForm", SCHEMAS.get("LifeForm"), SCHEMAS);
  const parsed = parseFieldReference(table);
  assert.strictEqual(parsed.trait.type, "string");
  assert.strictEqual(parsed.trait.bind, true);
  assert.strictEqual(parsed.id.required, true);
  assert.strictEqual(parsed.attachment.bind, false);
});

// --- Task 5: field rename ---------------------------------------------------

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

// --- Task 7: orphan cleanup -------------------------------------------------

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

// --- README item 9: attachment as an image column ---------------------------

const { renderBaseYaml } = generators;

test("an attachment field is shown through image(), not as a raw path", () => {
  const yaml = renderBaseYaml("LifeForm", { id: { type: "string" }, cover: { type: "attachment" } }, "data/record/lifeforms");
  assert.ok(yaml.includes("formulas:"), yaml);
  assert.ok(yaml.includes("coverImage: image(cover.path)"), yaml);
  assert.ok(yaml.includes("- formula.coverImage"), yaml);
});

test("the raw attachment column is replaced, not duplicated", () => {
  const yaml = renderBaseYaml("LifeForm", { cover: { type: "attachment" } }, "data/record/lifeforms");
  assert.ok(!/^ *- cover$/m.test(yaml), yaml);
});

test("a schema with no attachment field gets no formulas block", () => {
  const yaml = renderBaseYaml("Realm", { Realm: { type: "string" } }, "data/record/realms");
  assert.ok(!yaml.includes("formulas:"), yaml);
});

test("an unbound attachment is left out entirely", () => {
  const yaml = renderBaseYaml("LifeForm", { cover: { type: "attachment", bind: false } }, "data/record/lifeforms");
  assert.ok(!yaml.includes("formulas:"), yaml);
  assert.ok(!yaml.includes("cover"), yaml);
});

// --- README item 8: config rows become records ------------------------------

const { recordFromConfigValue, recordFileNameFor } = generators;

test("a config row becomes a record carrying that value", () => {
  const fields = { Realm: { type: "string", required: true } };
  assert.deepStrictEqual(recordFromConfigValue("Realm", fields, "Realm", "Aetheria"), {
    implements: "Realm",
    Realm: "Aetheria",
  });
});

test("the schema's identity field takes the item name too", () => {
  const fields = { id: { type: "string", required: true }, trait: { type: "string" } };
  const record = recordFromConfigValue("LifeForm", fields, "trait", "bold");
  assert.strictEqual(record.id, "bold");
  assert.strictEqual(record.trait, "bold");
});

test("unbound fields stay out of the new record", () => {
  const fields = { Realm: { type: "string" }, note: { type: "string", bind: false } };
  assert.ok(!("note" in recordFromConfigValue("Realm", fields, "Realm", "Umbra")));
});

test("other bound fields start empty", () => {
  const fields = { Realm: { type: "string" }, size: { type: "number" } };
  assert.strictEqual(recordFromConfigValue("Realm", fields, "Realm", "Umbra").size, 0);
});

test("a value becomes a file name, brackets stripped", () => {
  assert.strictEqual(recordFileNameFor("Aetheria"), "Aetheria.md");
  assert.strictEqual(recordFileNameFor("[[Umbra]]"), "Umbra.md");
  assert.strictEqual(recordFileNameFor("  Spaced  "), "Spaced.md");
});

test("a value that cannot be a file name is refused", () => {
  assert.strictEqual(recordFileNameFor("a/b"), null);
  assert.strictEqual(recordFileNameFor("a:b"), null);
  assert.strictEqual(recordFileNameFor(""), null);
  assert.strictEqual(recordFileNameFor("   "), null);
});

// --- README item 7: foreign fields pulled through a relation ----------------

const FK_SCHEMAS = new Map([
  ["Realm", { Realm: { type: "string", required: true }, size: { type: "number" }, ruler: { type: "string", relation: { target: "LifeForm" } } }],
  ["LifeForm", { id: { type: "string", required: true } }],
]);

test("a bound relation exposes the target's fields as formulas", () => {
  const yaml = renderBaseYaml("Verse", { home: { type: "string", relation: { target: "Realm" } } }, "data/record/verses", FK_SCHEMAS);
  assert.ok(yaml.includes("home_Realm: home.Realm"), yaml);
  assert.ok(yaml.includes("home_size: home.size"), yaml);
  assert.ok(yaml.includes("- formula.home_Realm"), yaml);
});

test("the target's own relations are not pulled through a second hop", () => {
  const yaml = renderBaseYaml("Verse", { home: { type: "string", relation: { target: "Realm" } } }, "data/record/verses", FK_SCHEMAS);
  assert.ok(!yaml.includes("home_ruler"), yaml);
});

test("an unbound relation pulls nothing", () => {
  const yaml = renderBaseYaml("Verse", { home: { type: "string", bind: false, relation: { target: "Realm" } } }, "data/record/verses", FK_SCHEMAS);
  assert.ok(!yaml.includes("formulas:"), yaml);
});

test("a relation to an unknown schema pulls nothing", () => {
  const yaml = renderBaseYaml("Verse", { home: { type: "string", relation: { target: "Ghost" } } }, "data/record/verses", FK_SCHEMAS);
  assert.ok(!yaml.includes("formulas:"), yaml);
});

test("foreign fields do not become schema fields", () => {
  // The whole point of item 7: query and labelling only, never bound back.
  const fields = { home: { type: "string", relation: { target: "Realm" } } };
  renderBaseYaml("Verse", fields, "data/record/verses", FK_SCHEMAS);
  assert.deepStrictEqual(Object.keys(fields), ["home"]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passing`);
process.exit(failed ? 1 : 0);
