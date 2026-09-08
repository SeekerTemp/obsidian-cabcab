// Regression test for README item 1: the undeclared-property prompt went silent.
//
// Root cause: checkUndeclaredProperties() and validateFile() shared one
// `basename.startsWith("_placeholder.")` guard. Once the last numbered record
// (id2.LifeForm.md) was deleted in 298598a, every remaining record was a
// template and the prompt had nothing left to fire on.
//
// The two skips answer different questions. A template is deliberately blank,
// so validating it would report every required field as missing on every pass —
// that skip stays. But adding a property to a template is the plainest
// statement of schema intent there is, so the offer must still run on it.

// Run with:  node .obsidian/plugins/schema-sync/tests/undeclared-property.test.js

const Module = require("module");
const assert = require("assert");

// main.js does `require("obsidian")` at load time. Obsidian only exists inside
// the app, so intercept the specifier and hand back inert class stubs. Every
// function under test is pure; none of these are ever constructed.
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

const MAIN = require("path").join(__dirname, "..", "main.js");
const { generators } = require(MAIN);
const { undeclaredPropertyFor, shouldValidateNote } = generators;

const LIFEFORM = {
  id: { type: "string", required: true },
  cover: { type: "attachment" },
  trait: { type: "string" },
};

// The three notes actually in the vault are all templates.
const TEMPLATE = "_placeholder.LifeForm";
// implementEntity() numbers from 2, sitting alongside the unnumbered template.
const RECORD = "_placeholder2.LifeForm";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const offer = (frontmatter, options = {}) => undeclaredPropertyFor({
  schemaName: "LifeForm",
  frontmatter,
  fields: LIFEFORM,
  ignored: options.ignored || new Set(),
  asking: options.asking || new Set(),
});

// --- the regression ---------------------------------------------------------
//
// Together these two say: validation still skips the template, the offer no
// longer does. Note-kind is not an input to undeclaredPropertyFor at all — that
// absence is the fix.

test("the template is still never validated", () => {
  assert.strictEqual(shouldValidateNote(TEMPLATE), false);
});

test("a new property on the template's own frontmatter is offered", () => {
  // Exactly what data/record/lifeforms/_placeholder.LifeForm.md holds, plus one.
  const template = { implements: "LifeForm", id: "", cover: "", trait: "", habitat: "reef" };
  assert.strictEqual(offer(template), "habitat");
});

// --- behaviour that must not regress ---------------------------------------

test("a numbered record is still validated", () => {
  assert.strictEqual(shouldValidateNote(RECORD), true);
});

test("a new property on a real record is still offered", () => {
  assert.strictEqual(offer({ implements: "LifeForm", id: "TODO", habitat: "reef" }), "habitat");
});

test("a note carrying only declared fields offers nothing", () => {
  assert.strictEqual(offer({ implements: "LifeForm", id: "", cover: "", trait: "" }), null);
});

test("position, injected by the metadata cache, is never reported", () => {
  assert.strictEqual(offer({ implements: "LifeForm", id: "", cover: "", trait: "", position: { start: 0, end: 4 } }), null);
});

test("implements is never reported as undeclared", () => {
  assert.strictEqual(offer({ implements: "LifeForm" }), null);
});

test("a property answered 'leave it alone' is never re-offered", () => {
  const ignored = new Set(["Cultures.config"]);
  assert.strictEqual(offer({ implements: "LifeForm", "Cultures.config": "[[Culture]]" }, { ignored }), null);
});

test("a property whose modal is already open is not offered twice", () => {
  const asking = new Set(["LifeForm.habitat"]);
  assert.strictEqual(offer({ implements: "LifeForm", habitat: "reef" }, { asking }), null);
});

test("an in-flight question about another schema does not mask this one", () => {
  const asking = new Set(["Realm.habitat"]);
  assert.strictEqual(offer({ implements: "LifeForm", habitat: "reef" }, { asking }), "habitat");
});

test("the first undeclared property wins, in document order", () => {
  const frontmatter = { implements: "LifeForm", id: "", "Architectures.config": "[[A]]", "Cultures.config": "[[C]]" };
  assert.strictEqual(offer(frontmatter), "Architectures.config");
});

test("a note with no frontmatter offers nothing", () => {
  assert.strictEqual(offer(null), null);
});

test("a note whose schema is unknown offers nothing", () => {
  assert.strictEqual(undeclaredPropertyFor({
    schemaName: "Ghost", frontmatter: { implements: "Ghost", habitat: "reef" },
    fields: undefined, ignored: new Set(), asking: new Set(),
  }), null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passing`);
process.exit(failed ? 1 : 0);
