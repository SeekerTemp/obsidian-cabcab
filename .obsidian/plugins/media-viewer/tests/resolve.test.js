// Tests for inheritance: the chain walk, the first-declaring-ancestor rule,
// and the two ways a walk can go wrong without being allowed to go quiet.
//
//   node tests/resolve.test.js
const { installDom } = require("./stub-dom.js");
installDom();

const { core, MetadataResolver } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

/* A chain built out of plain objects. `lookup` is all the walk needs, so the
   tests describe lineage directly rather than through a vault. */
function chainOf(entries) {
  const records = new Map();
  for (const [path, front, source] of entries) {
    records.set(path, {
      notePath: "data/media/" + core.stemOf(path) + ".md",
      frontmatter: Object.assign({ implements: "MediaInstance" }, front),
      sourcePath: source === undefined ? null : source,
      sourceLink: source === undefined ? null : source,
    });
  }
  return (path) => records.get(path) || null;
}

// grandchild -> child -> root, with a value declared at each level.
const FAMILY = chainOf([
  ["a/grandchild.png", { status: "edited" }, "a/child.png"],
  ["a/child.png", { status: "edited", labels: ["wide"] }, "a/root.png"],
  ["a/root.png", { status: "reviewed", labels: ["hero"], photographer: "Ada" }],
]);

group("walking the chain", () => {
  test("it reaches the root and says it got there", () => {
    const walk = core.walkChain("a/grandchild.png", FAMILY);
    deepEqual(
      walk.chain.map((step) => step.path),
      ["a/grandchild.png", "a/child.png", "a/root.png"]
    );
    equal(walk.stopped, core.CHAIN_END);
    ok(walk.ok);
  });

  test("a file with no note is a chain of one, and not a break", () => {
    const walk = core.walkChain("a/loose.png", FAMILY);
    deepEqual(walk.chain.map((step) => step.path), ["a/loose.png"]);
    equal(walk.chain[0].record, null);
    equal(walk.stopped, core.CHAIN_END);
  });

  test("a root is a chain of one too", () => {
    const walk = core.walkChain("a/root.png", FAMILY);
    equal(walk.chain.length, 1);
    ok(walk.ok);
  });

  test("nothing to walk from walks nowhere", () => {
    const walk = core.walkChain(null, FAMILY);
    equal(walk.chain.length, 0);
    ok(walk.ok);
  });
});

group("the first declaring ancestor wins", () => {
  test("a value declared here is not inherited", () => {
    const answer = core.resolveField("status", "a/grandchild.png", FAMILY);
    equal(answer.value, "edited");
    equal(answer.from, "a/grandchild.png");
    equal(answer.inherited, false);
  });

  test("a value not declared here comes from the nearest ancestor that has it", () => {
    const answer = core.resolveField("labels", "a/grandchild.png", FAMILY);
    deepEqual(answer.value, ["wide"]);
    equal(answer.from, "a/child.png", "the child, not the root");
    equal(answer.inherited, true);
  });

  test("a value only the root has reaches the grandchild", () => {
    const answer = core.resolveField("photographer", "a/grandchild.png", FAMILY);
    equal(answer.value, "Ada");
    equal(answer.from, "a/root.png");
  });

  test("editing a parent field changes what a grandchild resolves", () => {
    // The entire reason for tracking lineage, stated as a test.
    const before = core.resolveField("photographer", "a/grandchild.png", FAMILY);
    equal(before.value, "Ada");
    const corrected = chainOf([
      ["a/grandchild.png", { status: "edited" }, "a/child.png"],
      ["a/child.png", { status: "edited" }, "a/root.png"],
      ["a/root.png", { photographer: "Grace" }],
    ]);
    equal(core.resolveField("photographer", "a/grandchild.png", corrected).value, "Grace");
  });

  test("a field nobody declares resolves to nothing, not to an error", () => {
    const answer = core.resolveField("nowhere", "a/grandchild.png", FAMILY);
    equal(answer.value, undefined);
    equal(answer.from, null);
  });

  test("a field present but empty is walked through", () => {
    const chain = chainOf([
      ["a/child.png", { status: "", labels: [] }, "a/root.png"],
      ["a/root.png", { status: "reviewed", labels: ["hero"] }],
    ]);
    // Schema Sync fills a record's bound fields out with blanks; a blank that
    // stopped the walk would break inheritance for every record it touched.
    equal(core.resolveField("status", "a/child.png", chain).from, "a/root.png");
    deepEqual(core.resolveField("labels", "a/child.png", chain).value, ["hero"]);
  });

  test("a false or zero value is a value someone meant", () => {
    const chain = chainOf([
      ["a/child.png", { keep: false, count: 0 }, "a/root.png"],
      ["a/root.png", { keep: true, count: 99 }],
    ]);
    equal(core.resolveField("keep", "a/child.png", chain).value, false);
    equal(core.resolveField("count", "a/child.png", chain).value, 0);
  });
});

group("intrinsic fields do not inherit", () => {
  const chain = chainOf([
    ["a/child.png", { status: "edited" }, "a/root.png"],
    ["a/root.png", { crop: { x: 1, y: 2, w: 3, h: 4 }, width: 4000, op: "crop" }],
  ]);

  test("a child does not borrow its parent's crop", () => {
    // Inheriting one would claim the file was cut from a rectangle it was not.
    equal(core.resolveField("crop", "a/child.png", chain).value, undefined);
    equal(core.resolveField("width", "a/child.png", chain).value, undefined);
    equal(core.resolveField("op", "a/child.png", chain).value, undefined);
  });

  test("its own intrinsic fields still resolve", () => {
    const own = chainOf([
      ["a/child.png", { crop: { x: 5, y: 5, w: 5, h: 5 }, width: 100 }, "a/root.png"],
      ["a/root.png", { crop: { x: 1, y: 1, w: 1, h: 1 }, width: 4000 }],
    ]);
    deepEqual(core.resolveField("crop", "a/child.png", own).value, { x: 5, y: 5, w: 5, h: 5 });
    equal(core.resolveField("crop", "a/child.png", own).inherited, false);
  });
});

group("resolving every field at once", () => {
  test("the answer says where each value came from", () => {
    const { fields } = core.resolveFields("a/grandchild.png", FAMILY);
    equal(fields.status.from, "a/grandchild.png");
    equal(fields.status.inherited, false);
    equal(fields.labels.from, "a/child.png");
    ok(fields.labels.inherited);
    equal(fields.photographer.from, "a/root.png");
  });

  test("a field nobody here was taught about still inherits", () => {
    const { fields } = core.resolveFields("a/grandchild.png", FAMILY);
    ok(fields.photographer, "nothing in the plugin knows what a photographer is");
  });

  test("implements is not a field anyone inherits", () => {
    const { fields } = core.resolveFields("a/grandchild.png", FAMILY);
    equal(fields.implements, undefined);
  });

  test("an ancestor's intrinsic fields are left where they are", () => {
    const chain = chainOf([
      ["a/child.png", {}, "a/root.png"],
      ["a/root.png", { width: 4000, height: 3000, status: "reviewed" }],
    ]);
    const { fields } = core.resolveFields("a/child.png", chain);
    equal(fields.width, undefined, "the root's dimensions are the root's");
    equal(fields.status.from, "a/root.png");
  });
});

group("chains that go wrong", () => {
  test("a cycle is broken and reported", () => {
    const loop = chainOf([
      ["a/one.png", { status: "edited" }, "a/two.png"],
      ["a/two.png", {}, "a/one.png"],
    ]);
    const walk = core.walkChain("a/one.png", loop);
    equal(walk.stopped, core.CHAIN_CYCLE);
    equal(walk.chain.length, 2, "each file visited once");
    ok(!walk.ok);
    ok(core.chainProblemMessage(walk, "a/one.png").includes("loops back"));
  });

  test("a value found before the loop is still answered", () => {
    const loop = chainOf([
      ["a/one.png", {}, "a/two.png"],
      ["a/two.png", { status: "reviewed" }, "a/one.png"],
    ]);
    const answer = core.resolveField("status", "a/one.png", loop);
    equal(answer.value, "reviewed");
    equal(answer.walk.stopped, core.CHAIN_CYCLE, "and the problem is still reported");
  });

  test("a chain longer than the cap is abandoned at it", () => {
    const entries = [];
    for (let n = 0; n < 100; n += 1) entries.push(["a/" + n + ".png", {}, "a/" + (n + 1) + ".png"]);
    const deep = chainOf(entries);
    const walk = core.walkChain("a/0.png", deep);
    equal(walk.chain.length, core.CHAIN_HOP_LIMIT);
    equal(walk.stopped, core.CHAIN_LIMIT);
    ok(core.chainProblemMessage(walk, "a/0.png").includes("32"));
  });

  test("the cap can be lowered, which is how the test above stays quick", () => {
    const entries = [];
    for (let n = 0; n < 10; n += 1) entries.push(["a/" + n + ".png", {}, "a/" + (n + 1) + ".png"]);
    const walk = core.walkChain("a/0.png", chainOf(entries), 3);
    equal(walk.chain.length, 3);
    equal(walk.stopped, core.CHAIN_LIMIT);
  });

  test("a source naming a file that is not here stops the walk and names it", () => {
    const broken = chainOf([["a/child.png", { status: "edited" }, undefined]]);
    // sourceLink present, sourcePath null: the dangling case.
    const lookup = (path) => {
      const record = broken(path);
      if (!record) return null;
      return Object.assign({}, record, { sourcePath: null, sourceLink: "deleted.png" });
    };
    const walk = core.walkChain("a/child.png", lookup);
    equal(walk.stopped, core.CHAIN_MISSING);
    equal(walk.missing, "deleted.png");
    ok(core.chainProblemMessage(walk, "a/child.png").includes("deleted.png"));
  });

  test("a healthy walk has no problem to report", () => {
    equal(core.chainProblemMessage(core.walkChain("a/root.png", FAMILY), "a/root.png"), null);
  });
});

group("the resolver against a store", () => {
  function resolverOver(entries) {
    const records = new Map();
    for (const [path, front, source] of entries) {
      records.set(path, {
        notePath: "data/media/" + core.stemOf(path) + ".md",
        frontmatter: Object.assign({ implements: "MediaInstance" }, front),
        sourcePath: source === undefined ? null : source,
        sourceLink: source === undefined ? null : source,
      });
    }
    const store = { recordFor: (path) => records.get(path) || null };
    return new MetadataResolver(store);
  }

  test("it resolves through the store's records", () => {
    const resolver = resolverOver([
      ["a/child.png", { status: "edited" }, "a/root.png"],
      ["a/root.png", { labels: ["hero"] }],
    ]);
    deepEqual(resolver.resolve("labels", "a/child.png").value, ["hero"]);
    deepEqual(resolver.ancestry("a/child.png"), ["a/child.png", "a/root.png"]);
  });

  test("a problem is logged once per file, not once per field", () => {
    const resolver = resolverOver([
      ["a/one.png", {}, "a/two.png"],
      ["a/two.png", {}, "a/one.png"],
    ]);
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      resolver.resolve("status", "a/one.png");
      resolver.resolve("labels", "a/one.png");
      resolver.resolveAll("a/one.png");
    } finally {
      console.warn = realWarn;
    }
    equal(warnings.length, 1, "the panel resolves every field on every render");
    ok(warnings[0].includes("loops back"), warnings[0]);
  });

  test("a chain that comes right is reported again if it breaks again", () => {
    const resolver = resolverOver([["a/root.png", { status: "reviewed" }]]);
    resolver.reported.add("a/root.png");
    resolver.resolve("status", "a/root.png");
    equal(resolver.reported.has("a/root.png"), false, "a healthy walk clears the mark");
  });
});

report("resolve");
