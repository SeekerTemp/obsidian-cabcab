// Run with:  node .obsidian/plugins/schema-sync/tests/base-view-merge.test.js
//
// A .base is created once and then belongs to the user. These cover the one
// thing sync still owns inside it: the <field>Image formulas.

const Module = require("module");
const assert = require("assert");

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
const { mergeBaseYaml, managedImageFormulas, renderBaseYaml } = generators;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const attachment = { type: "attachment" };
const string = { type: "string" };

// --- what the merge considers its own ---------------------------------------

test("a bound attachment field is managed, a string field is not wanted", () => {
  const managed = managedImageFormulas({ cover: attachment, trait: string });
  assert.strictEqual(managed.get("coverImage"), "image(cover)");
  assert.strictEqual(managed.get("traitImage"), null);
});

test("an unbound attachment field is not wanted either", () => {
  const managed = managedImageFormulas({ cover: { type: "attachment", bind: false } });
  assert.strictEqual(managed.get("coverImage"), null);
});

// --- leaving a correct file alone -------------------------------------------

test("a freshly rendered view needs no merge", () => {
  const fields = { id: string, cover: attachment };
  const raw = renderBaseYaml("LifeForm", fields, "data/record/lifeforms", new Map());
  assert.strictEqual(mergeBaseYaml(raw, fields), null);
});

test("a view that already says the right thing is not rewritten", () => {
  const raw = [
    "formulas:",
    "  coverImage: image(cover)",
    "views:",
    "  - type: table",
    "    name: LifeForm",
    "    order:",
    "      - file.name",
    "      - formula.coverImage",
    "    sort: []",
    "",
  ].join("\n");
  assert.strictEqual(mergeBaseYaml(raw, { cover: attachment }), null);
});

// --- adding ------------------------------------------------------------------

test("a new attachment field gains a formula and a column", () => {
  const raw = [
    "formulas:",
    "  coverImage: image(cover)",
    "views:",
    "  - type: table",
    "    order:",
    "      - file.name",
    "      - formula.coverImage",
    "    sort: []",
    "",
  ].join("\n");
  const merged = mergeBaseYaml(raw, { cover: attachment, portrait: attachment });
  assert.match(merged, /^ {2}portraitImage: image\(portrait\)$/m);
  assert.match(merged, /^ {6}- formula\.portraitImage$/m);
});

test("a view with no formulas block gains one above views:", () => {
  const raw = [
    "views:",
    "  - type: table",
    "    order:",
    "      - file.name",
    "    sort: []",
    "",
  ].join("\n");
  const merged = mergeBaseYaml(raw, { cover: attachment });
  const lines = merged.split("\n");
  assert.ok(lines.indexOf("formulas:") < lines.indexOf("views:"));
  assert.strictEqual(lines[lines.indexOf("formulas:") + 1], "  coverImage: image(cover)");
});

test("a column the user removed by hand is not put back", () => {
  const raw = [
    "formulas:",
    "  coverImage: image(cover)",
    "views:",
    "  - type: table",
    "    order:",
    "      - file.name",
    "    sort: []",
    "",
  ].join("\n");
  assert.strictEqual(mergeBaseYaml(raw, { cover: attachment }), null);
});

// --- removing ----------------------------------------------------------------

test("a field that stopped being an attachment loses its formula and column", () => {
  const raw = [
    "formulas:",
    "  coverImage: image(cover)",
    "views:",
    "  - type: table",
    "    order:",
    "      - file.name",
    "      - formula.coverImage",
    "    sort: []",
    "",
  ].join("\n");
  const merged = mergeBaseYaml(raw, { cover: string });
  assert.ok(!merged.includes("coverImage"));
  assert.ok(!merged.includes("formula.coverImage"));
  assert.match(merged, /^ {6}- file\.name$/m);
});

test("the formulas key goes when its last managed entry does", () => {
  const raw = ["formulas:", "  coverImage: image(cover)", "views:", "  - type: table", ""].join("\n");
  const merged = mergeBaseYaml(raw, { cover: string });
  assert.ok(!merged.includes("formulas:"));
  assert.ok(merged.includes("views:"));
});

// --- leaving everything else alone -------------------------------------------

test("a hand-written formula, filter and sort all survive", () => {
  const raw = [
    "# my notes",
    "formulas:",
    "  ageBand: if(age > 100, \"old\", \"young\")",
    "views:",
    "  - type: table",
    "    name: Renamed by hand",
    "    filters:",
    "      and:",
    "        - file.hasTag(\"live\")",
    "    order:",
    "      - formula.ageBand",
    "      - file.name",
    "    sort:",
    "      - property: file.name",
    "",
  ].join("\n");
  const merged = mergeBaseYaml(raw, { cover: attachment, age: { type: "number" } });
  assert.match(merged, /^ {2}ageBand: if\(age > 100, "old", "young"\)$/m);
  assert.match(merged, /^ {4}name: Renamed by hand$/m);
  assert.match(merged, /^ {8}- file\.hasTag\("live"\)$/m);
  assert.match(merged, /^ {6}- property: file\.name$/m);
  assert.match(merged, /^# my notes$/m);
  // The hand-written column order is untouched; the new one is appended.
  const lines = merged.split("\n");
  const from = lines.indexOf("    order:") + 1;
  const order = lines.slice(from, lines.indexOf("    sort:"));
  assert.deepStrictEqual(order, ["      - formula.ageBand", "      - file.name", "      - formula.coverImage"]);
});

test("a formula named like a field the schema does not have is left alone", () => {
  const raw = ["formulas:", "  legacyImage: image(legacy)", "views:", "  - type: table", ""].join("\n");
  assert.strictEqual(mergeBaseYaml(raw, { cover: string }), null);
});

test("CRLF line endings are preserved", () => {
  const raw = ["formulas:", "  coverImage: image(cover)", "views:", "  - type: table", ""].join("\r\n");
  const merged = mergeBaseYaml(raw, { cover: attachment, portrait: attachment });
  assert.ok(merged.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(merged));
});

// --- runner ------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passing`);
process.exit(failed ? 1 : 0);
