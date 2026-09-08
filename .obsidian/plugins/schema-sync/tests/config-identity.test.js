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

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passing`);
process.exit(failed ? 1 : 0);
