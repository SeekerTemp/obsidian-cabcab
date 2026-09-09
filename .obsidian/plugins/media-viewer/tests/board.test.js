// Tests for boards: the placement maths, and the canvas file BoardStore reads
// and writes.
//
//   node tests/board.test.js
//
// A board is an Obsidian canvas — JSON Canvas, an ordinary vault file. What is
// tested here is the small half Obsidian does not do: put a named file on a
// board at a sensible size, and draw the provenance edge when the other end is
// already there. What is deliberately not tested, because it is deliberately
// not done: populating a board from a folder.
const { core, BoardStore } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

group("how big a node is", () => {
  test("a fixed height, so a board reads as a board", () => {
    deepEqual(core.boardNodeSize(1920, 1080, 512), { width: 910, height: 512 });
  });

  test("width follows the picture, because a stretched screenshot misleads", () => {
    deepEqual(core.boardNodeSize(1080, 1920, 512), { width: 288, height: 512 });
    deepEqual(core.boardNodeSize(512, 512, 512), { width: 512, height: 512 });
  });

  test("nothing known about the picture gives a square, not a NaN box", () => {
    deepEqual(core.boardNodeSize(0, 0, 512), { width: 512, height: 512 });
    deepEqual(core.boardNodeSize(NaN, 1080, 512), { width: 512, height: 512 });
    deepEqual(core.boardNodeSize(undefined, undefined), {
      width: core.BOARD_NODE_HEIGHT,
      height: core.BOARD_NODE_HEIGHT,
    });
  });
});

group("where the next node goes", () => {
  const SIZE = { width: 400, height: 512 };

  test("the first one starts at the origin", () => {
    deepEqual(core.boardPlacement([], SIZE), { x: 0, y: 0 });
    deepEqual(core.boardPlacement(null, SIZE), { x: 0, y: 0 });
  });

  test("the next goes to the right of everything already there", () => {
    const placed = [{ x: 0, y: 0, width: 400, height: 512 }];
    deepEqual(core.boardPlacement(placed, SIZE, { gap: 64 }), { x: 464, y: 0 });
  });

  test("a long row wraps below everything, not on top of it", () => {
    const placed = [{ x: 0, y: 0, width: 900, height: 512 }];
    deepEqual(core.boardPlacement(placed, SIZE, { gap: 10, rowWidth: 1000 }), { x: 0, y: 522 });
  });

  test("nothing already on the board is ever moved", () => {
    // Someone arranged that. A plugin tidying it up is the most annoying
    // thing it could do, so placement only ever reads.
    const placed = [{ x: 500, y: 300, width: 100, height: 100 }];
    const before = JSON.stringify(placed);
    core.boardPlacement(placed, SIZE);
    equal(JSON.stringify(placed), before);
  });

  test("nodes with no position are ignored rather than read as zero", () => {
    const placed = [{ x: 0, y: 0, width: 100, height: 100 }, { id: "text-node" }];
    deepEqual(core.boardPlacement(placed, SIZE, { gap: 10 }), { x: 110, y: 0 });
  });
});

group("edges", () => {
  test("an id derived from both ends, so re-adding does not stack a second", () => {
    equal(core.boardEdgeId("a", "b"), core.boardEdgeId("a", "b"));
    ok(core.boardEdgeId("a", "b") !== core.boardEdgeId("b", "a"));
  });

  test("sides follow where the nodes actually are", () => {
    deepEqual(core.boardEdgeSides({ x: 0, y: 0 }, { x: 500, y: 0 }), { fromSide: "right", toSide: "left" });
    deepEqual(core.boardEdgeSides({ x: 500, y: 0 }, { x: 0, y: 0 }), { fromSide: "left", toSide: "right" });
    deepEqual(core.boardEdgeSides({ x: 0, y: 0 }, { x: 0, y: 500 }), { fromSide: "bottom", toSide: "top" });
    deepEqual(core.boardEdgeSides({ x: 0, y: 500 }, { x: 0, y: 0 }), { fromSide: "top", toSide: "bottom" });
  });

  test("the label starts as provenance, because a bare arrow says nothing", () => {
    equal(core.boardEdgeLabel({ op: "capture", sourceTime: 92.4 }), "frame @ 1:32");
    equal(core.boardEdgeLabel({ op: "capture" }), "frame");
    equal(core.boardEdgeLabel({ op: "crop" }), "crop");
    equal(core.boardEdgeLabel({}), "from");
  });
});

/* The canvas file. */

function fakeApp(files) {
  const store = new Map(Object.entries(files || {}));
  return {
    store,
    vault: {
      getAbstractFileByPath: (path) => (store.has(path) ? { path } : null),
      getFiles: () => [...store.keys()].map((path) => ({ path })),
      async read(file) {
        return store.get(file.path);
      },
      async modify(file, text) {
        store.set(file.path, text);
      },
      async create(path, text) {
        store.set(path, text);
        return { path };
      },
      async createFolder() {},
    },
  };
}

const boardOf = (app, path) => JSON.parse(app.store.get(path));

function fakeLineage(records, children) {
  return {
    recordFor: (path) => records[path] || null,
    childrenOf: (path) => (children || {})[path] || [],
  };
}

group("adding a file to a board", () => {
  test("writes a file node, and creates the canvas if it is not there", async () => {
    const app = fakeApp({});
    const store = new BoardStore(app);
    await store.add("boards/walk.canvas", "assets/frame.png", { width: 1920, height: 1080 });
    const board = boardOf(app, "boards/walk.canvas");
    equal(board.nodes.length, 1);
    equal(board.nodes[0].type, "file");
    equal(board.nodes[0].file, "assets/frame.png");
    equal(board.nodes[0].height, core.BOARD_NODE_HEIGHT);
  });

  test("a second file lands beside the first, and the first does not move", async () => {
    const app = fakeApp({});
    const store = new BoardStore(app);
    await store.add("b.canvas", "a.png", { width: 100, height: 100 });
    const first = boardOf(app, "b.canvas").nodes[0];
    await store.add("b.canvas", "b.png", { width: 100, height: 100 });
    const board = boardOf(app, "b.canvas");
    equal(board.nodes.length, 2);
    deepEqual({ x: board.nodes[0].x, y: board.nodes[0].y }, { x: first.x, y: first.y });
    ok(board.nodes[1].x > board.nodes[0].x);
  });

  test("everything already on the board survives the write", async () => {
    // Sticky notes, groups and the labels a person retyped are the whole
    // value of the board; a plugin that dropped them on every add would be
    // unusable.
    const app = fakeApp({
      "b.canvas": JSON.stringify({
        nodes: [{ id: "sticky", type: "text", text: "the bug is here", x: 0, y: 0, width: 200, height: 100 }],
        edges: [{ id: "hand-drawn", fromNode: "sticky", toNode: "sticky", label: "mine" }],
        somethingElse: true,
      }),
    });
    const store = new BoardStore(app);
    await store.add("b.canvas", "a.png", { width: 100, height: 100 });
    const board = boardOf(app, "b.canvas");
    equal(board.nodes.length, 2);
    ok(board.nodes.some((node) => node.id === "sticky"), "the sticky note is still there");
    equal(board.edges[0].label, "mine", "and so is the edge somebody labelled");
    equal(board.somethingElse, true, "and whatever else the format carries");
  });

  test("the same file can be added twice, in two flows", async () => {
    const app = fakeApp({});
    const store = new BoardStore(app);
    await store.add("b.canvas", "a.png", { width: 100, height: 100 });
    await store.add("b.canvas", "a.png", { width: 100, height: 100 });
    const board = boardOf(app, "b.canvas");
    equal(board.nodes.length, 2);
    ok(board.nodes[0].id !== board.nodes[1].id, "two nodes, not one shared id");
  });

  test("a canvas that will not parse is refused, not replaced", async () => {
    // Overwriting it would delete somebody's board to fix a typo in it.
    const app = fakeApp({ "b.canvas": "{ not json" });
    const store = new BoardStore(app);
    let failed = false;
    try {
      await store.add("b.canvas", "a.png", {});
    } catch (error) {
      failed = true;
    }
    equal(failed, true);
    equal(app.store.get("b.canvas"), "{ not json", "left exactly as it was");
  });
});

group("the graph draws itself, as far as the board allows", () => {
  const RECORDS = {
    "assets/frame.png": {
      sourcePath: "assets/walk.mp4",
      frontmatter: { op: "capture", sourceTime: 92.4 },
    },
    "assets/walk.mp4": { sourcePath: null, frontmatter: {} },
  };
  const CHILDREN = { "assets/walk.mp4": ["assets/frame.png"] };

  test("adding a child joins it to a parent already on the board", async () => {
    const app = fakeApp({});
    const store = new BoardStore(app);
    const lineage = fakeLineage(RECORDS, CHILDREN);
    await store.add("b.canvas", "assets/walk.mp4", { width: 1920, height: 1080, lineage });
    await store.add("b.canvas", "assets/frame.png", { width: 1920, height: 1080, lineage });
    const board = boardOf(app, "b.canvas");
    equal(board.edges.length, 1);
    equal(board.edges[0].label, "frame @ 1:32");
  });

  test("and adding the parent later joins up what is already there", async () => {
    const app = fakeApp({});
    const store = new BoardStore(app);
    const lineage = fakeLineage(RECORDS, CHILDREN);
    await store.add("b.canvas", "assets/frame.png", { width: 100, height: 100, lineage });
    equal(boardOf(app, "b.canvas").edges.length, 0, "nothing to join yet");
    await store.add("b.canvas", "assets/walk.mp4", { width: 100, height: 100, lineage });
    equal(boardOf(app, "b.canvas").edges.length, 1, "the backfill");
  });

  test("a parent that is not on the board is not added to it", async () => {
    // Curation is the constraint: nothing appears that was not asked for.
    const app = fakeApp({});
    const store = new BoardStore(app);
    await store.add("b.canvas", "assets/frame.png", {
      width: 100,
      height: 100,
      lineage: fakeLineage(RECORDS, CHILDREN),
    });
    const board = boardOf(app, "b.canvas");
    equal(board.nodes.length, 1);
    equal(board.edges.length, 0);
  });

  test("an edge that already exists is left alone, label and all", async () => {
    const app = fakeApp({});
    const store = new BoardStore(app);
    const lineage = fakeLineage(RECORDS, CHILDREN);
    await store.add("b.canvas", "assets/walk.mp4", { width: 100, height: 100, lineage });
    await store.add("b.canvas", "assets/frame.png", { width: 100, height: 100, lineage });

    // Somebody retypes the label, which is the point of the board.
    const board = boardOf(app, "b.canvas");
    board.edges[0].label = "When Settings button → set ID";
    app.store.set("b.canvas", JSON.stringify(board));

    // Adding the file again places a second node — the same frame in another
    // flow is legitimate — so that node gets its own edge. What must not
    // happen is the first edge being rewritten.
    await store.add("b.canvas", "assets/frame.png", { width: 100, height: 100, lineage });
    const after = boardOf(app, "b.canvas");
    equal(after.edges.length, 2, "the new node earned its own edge");
    equal(after.edges[0].label, "When Settings button → set ID", "and the first is still theirs");
  });

  test("re-reading a board and writing it again adds no edges at all", async () => {
    // The idempotence that matters: a sync must not stack a duplicate edge on
    // the same pair of nodes every time it runs.
    const app = fakeApp({});
    const store = new BoardStore(app);
    const lineage = fakeLineage(RECORDS, CHILDREN);
    await store.add("b.canvas", "assets/walk.mp4", { width: 100, height: 100, lineage });
    await store.add("b.canvas", "assets/frame.png", { width: 100, height: 100, lineage });

    const board = await store.read("b.canvas");
    const frameNode = store.nodesFor(board, "assets/frame.png")[0];
    const before = board.edges.length;
    equal(store.connect(board, frameNode, "assets/frame.png", { lineage }).length, 0);
    equal(board.edges.length, before, "nothing was added the second time");
  });

  test("with no lineage to consult, a node is added and nothing is joined", async () => {
    const app = fakeApp({});
    const store = new BoardStore(app);
    const added = await store.add("b.canvas", "a.png", { width: 100, height: 100 });
    deepEqual(added.edges, []);
  });
});

report("board");
