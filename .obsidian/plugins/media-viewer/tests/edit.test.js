// Tests for the edit pipeline: the plain-data state, the matrix that renders
// it, and the session that holds undo around both. Run with:
//
//   node tests/edit.test.js
//
// The session is not pure — it holds a decoded image and draws onto a canvas —
// but everything it decides is a `core` function, so what is asserted here is
// mostly that the right one is called with the right arguments, plus the two
// things only the class knows: the history, and the draw.
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();
const { core, EditSession } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

// A stand-in for a decoded image. EditSession never reads anything off it —
// the dimensions it trusts are the ones it was given — so an empty element is
// enough to be drawn.
function bitmap(width, height) {
  const element = new StubElement("img");
  element.naturalWidth = width;
  element.naturalHeight = height;
  return element;
}

function sessionOn(width, height) {
  return new EditSession({ path: "data/assets/cover.png", image: bitmap(width, height), width, height });
}

// Where a source-space point lands on the output canvas, under a plan.
function through(plan, x, y) {
  const point = core.applyMatrix(plan.matrix, x, y);
  return { x: Math.round(point.x * 1e6) / 1e6, y: Math.round(point.y * 1e6) / 1e6 };
}

group("edit state", () => {
  test("an empty state is the identity", () => {
    deepEqual(core.emptyEditState(), {
      rotate: 0,
      flipH: false,
      flipV: false,
      crop: null,
      resize: null,
    });
    ok(core.isIdentityEdit(core.emptyEditState(), 100, 80), "nothing to do");
  });

  test("normalising refuses rubbish rather than carrying it", () => {
    const state = core.normaliseEditState({ rotate: 37, flipH: 1, flipV: 0, crop: { x: "a" }, resize: {} });
    deepEqual(state, { rotate: 0, flipH: true, flipV: false, crop: { x: 0, y: 0, w: 0, h: 0 }, resize: null });
  });

  test("a crop covering the whole image is still a crop, not nothing", () => {
    const state = core.normaliseEditState({ crop: { x: 0, y: 0, w: 100, h: 80 } });
    ok(state.crop, "the rectangle survives");
    // It renders identically today, and differently after a rotation, which is
    // why the two are not collapsed.
    ok(core.isIdentityEdit(state, 100, 80), "renders as the whole image");
  });

  test("a scale of exactly 1 is no resize at all", () => {
    equal(core.normaliseResize({ scale: 1 }), null);
    deepEqual(core.normaliseResize({ scale: 0.5 }), { scale: 0.5 });
    deepEqual(core.normaliseResize({ width: 800.4, height: 600.6 }), { width: 800, height: 601 });
    equal(core.normaliseResize({ width: 0, height: 10 }), null);
    equal(core.normaliseResize({ scale: -2 }), null);
  });
});

group("output dimensions", () => {
  test("with no transform the output is the source", () => {
    deepEqual(core.outputSize(core.emptyEditState(), 1000, 400), { width: 1000, height: 400 });
  });

  test("a quarter turn swaps them", () => {
    deepEqual(core.outputSize({ rotate: 90 }, 1000, 400), { width: 400, height: 1000 });
  });

  test("a crop measures the crop", () => {
    deepEqual(core.outputSize({ crop: { x: 10, y: 10, w: 300, h: 200 } }, 1000, 400), {
      width: 300,
      height: 200,
    });
  });

  test("a scale multiplies the crop, and never rounds an axis away", () => {
    deepEqual(core.outputSize({ crop: { x: 0, y: 0, w: 300, h: 201 }, resize: { scale: 0.5 } }, 1000, 400), {
      width: 150,
      height: 101,
    });
    deepEqual(core.outputSize({ crop: { x: 0, y: 0, w: 4, h: 4 }, resize: { scale: 0.01 } }, 1000, 400), {
      width: 1,
      height: 1,
    });
  });

  test("absolute dimensions are taken as given", () => {
    deepEqual(core.outputSize({ resize: { width: 640, height: 480 } }, 1000, 400), {
      width: 640,
      height: 480,
    });
  });

  test("a crop rotated out of the image falls back to the whole thing", () => {
    // 400 wide after the turn, so a crop at x=900 has nothing left in it.
    deepEqual(core.outputSize({ rotate: 90, crop: { x: 900, y: 0, w: 100, h: 100 } }, 1000, 400), {
      width: 400,
      height: 1000,
    });
  });
});

group("the render matrix", () => {
  test("identity maps the source onto the canvas one to one", () => {
    const plan = core.renderPlan(core.emptyEditState(), 1000, 400);
    equal(plan.width, 1000);
    equal(plan.height, 400);
    deepEqual(through(plan, 0, 0), { x: 0, y: 0 });
    deepEqual(through(plan, 1000, 400), { x: 1000, y: 400 });
  });

  test("a quarter turn clockwise sends the top-left corner to the top-right", () => {
    const plan = core.renderPlan({ rotate: 90 }, 1000, 400);
    equal(plan.width, 400);
    equal(plan.height, 1000);
    deepEqual(through(plan, 0, 0), { x: 400, y: 0 });
    deepEqual(through(plan, 1000, 0), { x: 400, y: 1000 });
    deepEqual(through(plan, 0, 400), { x: 0, y: 0 });
  });

  test("a half turn sends it to the bottom-right", () => {
    const plan = core.renderPlan({ rotate: 180 }, 1000, 400);
    deepEqual(through(plan, 0, 0), { x: 1000, y: 400 });
    deepEqual(through(plan, 1000, 400), { x: 0, y: 0 });
  });

  test("a horizontal flip mirrors across the canvas", () => {
    const plan = core.renderPlan({ flipH: true }, 1000, 400);
    deepEqual(through(plan, 0, 0), { x: 1000, y: 0 });
    deepEqual(through(plan, 1000, 400), { x: 0, y: 400 });
  });

  test("a vertical flip mirrors the other way", () => {
    const plan = core.renderPlan({ flipV: true }, 1000, 400);
    deepEqual(through(plan, 0, 0), { x: 0, y: 400 });
  });

  test("rotate then flip is not flip then rotate, and the pipeline is the former", () => {
    // Oriented space is 400x1000 after the turn; flipH mirrors in that space,
    // so the source's top-left corner ends at the origin.
    const plan = core.renderPlan({ rotate: 90, flipH: true }, 1000, 400);
    equal(plan.width, 400);
    equal(plan.height, 1000);
    deepEqual(through(plan, 0, 0), { x: 0, y: 0 });
    deepEqual(through(plan, 0, 400), { x: 400, y: 0 });
  });

  test("a crop puts its own top-left corner at the origin", () => {
    const plan = core.renderPlan({ crop: { x: 120, y: 40, w: 800, h: 300 } }, 1000, 400);
    equal(plan.width, 800);
    equal(plan.height, 300);
    deepEqual(through(plan, 120, 40), { x: 0, y: 0 });
    deepEqual(through(plan, 920, 340), { x: 800, y: 300 });
  });

  test("a crop under a rotation still lands on the origin", () => {
    const plan = core.renderPlan({ rotate: 270, crop: { x: 10, y: 20, w: 100, h: 50 } }, 1000, 400);
    equal(plan.width, 100);
    equal(plan.height, 50);
    // The oriented rect's corners, mapped back through the same maths the crop
    // was expressed in, have to arrive at the canvas corners.
    const back = core.sourceRectFor({ x: 10, y: 20, w: 100, h: 50 }, 1000, 400, 270, false, false);
    const corners = [
      through(plan, back.x, back.y),
      through(plan, back.x + back.w, back.y),
      through(plan, back.x, back.y + back.h),
      through(plan, back.x + back.w, back.y + back.h),
    ];
    for (const corner of corners) {
      ok(corner.x === 0 || corner.x === 100, "x on an edge: " + corner.x);
      ok(corner.y === 0 || corner.y === 50, "y on an edge: " + corner.y);
    }
  });

  test("a scale stretches the crop onto the canvas", () => {
    const plan = core.renderPlan({ crop: { x: 100, y: 100, w: 400, h: 200 }, resize: { scale: 2 } }, 1000, 400);
    equal(plan.width, 800);
    equal(plan.height, 400);
    deepEqual(through(plan, 100, 100), { x: 0, y: 0 });
    deepEqual(through(plan, 500, 300), { x: 800, y: 400 });
  });

  test("every rotation and flip keeps the image inside the canvas", () => {
    for (const rotate of [0, 90, 180, 270]) {
      for (const flipH of [false, true]) {
        for (const flipV of [false, true]) {
          const plan = core.renderPlan({ rotate, flipH, flipV }, 1000, 400);
          const corners = [
            through(plan, 0, 0),
            through(plan, 1000, 0),
            through(plan, 0, 400),
            through(plan, 1000, 400),
          ];
          const xs = corners.map((c) => c.x);
          const ys = corners.map((c) => c.y);
          equal(Math.min(...xs), 0, "left edge at " + rotate + "/" + flipH + "/" + flipV);
          equal(Math.max(...xs), plan.width, "right edge at " + rotate);
          equal(Math.min(...ys), 0, "top edge at " + rotate);
          equal(Math.max(...ys), plan.height, "bottom edge at " + rotate);
        }
      }
    }
  });

  test("matrix multiplication applies the right-hand one first", () => {
    const move = [1, 0, 0, 1, 10, 0];
    const double = [2, 0, 0, 2, 0, 0];
    // Scale after moving: (1,0) -> (11,0) -> (22,0)
    deepEqual(core.applyMatrix(core.multiplyMatrix(double, move), 1, 0), { x: 22, y: 0 });
    // Move after scaling: (1,0) -> (2,0) -> (12,0)
    deepEqual(core.applyMatrix(core.multiplyMatrix(move, double), 1, 0), { x: 12, y: 0 });
  });
});

group("the session", () => {
  test("a fresh session is clean and has nothing to undo", () => {
    const session = sessionOn(1000, 400);
    equal(session.dirty, false);
    equal(session.canUndo, false);
    equal(session.canRedo, false);
    deepEqual(session.outputSize, { width: 1000, height: 400 });
  });

  test("rotating swaps the output and marks the session dirty", () => {
    const session = sessionOn(1000, 400);
    ok(session.rotateBy(90), "the rotation was accepted");
    equal(session.state.rotate, 90);
    deepEqual(session.outputSize, { width: 400, height: 1000 });
    equal(session.dirty, true);
    equal(session.canUndo, true);
  });

  test("a rotation of nothing is not a history entry", () => {
    const session = sessionOn(1000, 400);
    equal(session.rotateBy(0), false);
    equal(session.rotateBy(360), false);
    equal(session.canUndo, false);
  });

  test("four rotations return to the start, and each is undoable", () => {
    const session = sessionOn(1000, 400);
    for (let i = 0; i < 4; i += 1) session.rotateBy(90);
    equal(session.state.rotate, 0);
    equal(session.past.length, 4);
  });

  test("rotating with a crop set keeps the same region selected", () => {
    const session = sessionOn(1000, 400);
    session.setCrop({ x: 0, y: 0, w: 100, h: 400 });
    const before = core.sourceRectFor(session.state.crop, 1000, 400, 0, false, false);
    session.rotateBy(90);
    const after = core.sourceRectFor(session.state.crop, 1000, 400, 90, false, false);
    deepEqual(after, before, "the same source pixels");
    deepEqual(session.outputSize, { width: 400, height: 100 });
  });

  test("rotating with a flip set turns the stored rect the other way", () => {
    const session = sessionOn(1000, 400);
    session.toggleFlip("h");
    session.setCrop({ x: 0, y: 0, w: 100, h: 400 });
    const before = core.sourceRectFor(session.state.crop, 1000, 400, 0, true, false);
    session.rotateBy(90);
    const after = core.sourceRectFor(session.state.crop, 1000, 400, 90, true, false);
    deepEqual(after, before, "the same source pixels");
  });

  test("an absolute resize swaps its axes on a quarter turn", () => {
    const session = sessionOn(1000, 400);
    session.setResize(800, 600);
    session.rotateBy(90);
    deepEqual(session.state.resize, { width: 600, height: 800 });
    session.rotateBy(180);
    deepEqual(session.state.resize, { width: 600, height: 800 }, "a half turn changes nothing");
  });

  test("a scale survives a rotation untouched", () => {
    const session = sessionOn(1000, 400);
    session.setScale(0.5);
    session.rotateBy(90);
    deepEqual(session.state.resize, { scale: 0.5 });
    deepEqual(session.outputSize, { width: 200, height: 500 });
  });

  test("flipping twice is not dirty", () => {
    const session = sessionOn(1000, 400);
    session.toggleFlip("v");
    session.toggleFlip("v");
    equal(session.dirty, false);
    equal(session.past.length, 2, "but both steps are still in history");
  });

  test("setting a crop drops absolute dimensions and keeps a scale", () => {
    const session = sessionOn(1000, 400);
    session.setResize(800, 600);
    session.setCrop({ x: 0, y: 0, w: 500, h: 200 });
    equal(session.state.resize, null);

    const other = sessionOn(1000, 400);
    other.setScale(0.5);
    other.setCrop({ x: 0, y: 0, w: 500, h: 200 });
    deepEqual(other.state.resize, { scale: 0.5 });
    deepEqual(other.outputSize, { width: 250, height: 100 });
  });

  test("a crop is clamped to the oriented image", () => {
    const session = sessionOn(1000, 400);
    session.rotateBy(90);
    session.setCrop({ x: -50, y: 0, w: 1000, h: 200 });
    deepEqual(session.state.crop, { x: 0, y: 0, w: 400, h: 200 });
  });

  test("a crop with nothing in it is refused", () => {
    const session = sessionOn(1000, 400);
    equal(session.setCrop({ x: 2000, y: 0, w: 10, h: 10 }), false);
    equal(session.state.crop, null);
  });

  test("crop then rotate then undo behaves predictably", () => {
    const session = sessionOn(1000, 400);
    session.setCrop({ x: 100, y: 50, w: 300, h: 200 });
    session.rotateBy(90);
    deepEqual(session.outputSize, { width: 200, height: 300 });

    ok(session.undo(), "the rotation comes off");
    equal(session.state.rotate, 0);
    deepEqual(session.state.crop, { x: 100, y: 50, w: 300, h: 200 }, "and the crop is back where it was");
    deepEqual(session.outputSize, { width: 300, height: 200 });

    ok(session.undo(), "the crop comes off");
    equal(session.state.crop, null);
    equal(session.dirty, false);
    equal(session.undo(), false, "and there is nothing before that");
  });

  test("redo replays what undo took off, until a new edit lands", () => {
    const session = sessionOn(1000, 400);
    session.rotateBy(90);
    session.toggleFlip("h");
    session.undo();
    session.undo();
    equal(session.canRedo, true);
    ok(session.redo());
    equal(session.state.rotate, 90);
    ok(session.redo());
    equal(session.state.flipH, true);
    equal(session.redo(), false);

    session.undo();
    session.rotateBy(180);
    equal(session.canRedo, false, "the branch not taken stops existing");
  });

  test("history is capped, and the cap drops the oldest step", () => {
    const session = sessionOn(1000, 400);
    for (let i = 0; i < core.EDIT_HISTORY_LIMIT + 10; i += 1) {
      session.setCrop({ x: 0, y: 0, w: 100 + i, h: 100 });
    }
    equal(session.past.length, core.EDIT_HISTORY_LIMIT);
  });

  test("reset is one undoable step back to nothing", () => {
    const session = sessionOn(1000, 400);
    session.rotateBy(90);
    session.setCrop({ x: 0, y: 0, w: 100, h: 100 });
    ok(session.reset());
    equal(session.dirty, false);
    ok(session.undo());
    equal(session.state.rotate, 90);
  });

  test("onChange fires for every accepted change, including undo", () => {
    const session = sessionOn(1000, 400);
    let calls = 0;
    session.onChange = () => {
      calls += 1;
    };
    session.rotateBy(90);
    session.rotateBy(0);
    session.undo();
    session.redo();
    equal(calls, 3);
  });
});

group("drawing", () => {
  test("the canvas is sized to the output and drawn once under the plan", () => {
    const session = sessionOn(1000, 400);
    session.setCrop({ x: 100, y: 50, w: 300, h: 200 });
    const canvas = session.render();
    equal(canvas.width, 300);
    equal(canvas.height, 200);
    const context = canvas.getContext("2d");
    equal(context.drawn.length, 1);
    equal(context.drawn[0].source, session.image);
    // Drawn at the source's own size, so a proxy handed here by mistake would
    // be visibly wrong rather than quietly wrong.
    equal(context.drawn[0].width, 1000);
    equal(context.drawn[0].height, 400);
    deepEqual(context.transforms[0], core.renderPlan(session.state, 1000, 400).matrix);
    deepEqual(context.transforms[1], [1, 0, 0, 1, 0, 0], "and the transform is left clean");
  });

  test("a session with no decoded source refuses to draw", () => {
    const session = new EditSession({ path: "a.png", width: 10, height: 10 });
    let threw = false;
    try {
      session.render();
    } catch (error) {
      threw = true;
    }
    ok(threw, "rendering without an image is an error, not an empty canvas");
  });

  test("what the note will record", () => {
    const session = sessionOn(1000, 400);
    session.rotateBy(90);
    session.setCrop({ x: 10, y: 20, w: 100, h: 50 });
    deepEqual(session.describe(), {
      crop: { x: 10, y: 20, w: 100, h: 50 },
      transform: { rotate: 90, flipH: false, flipV: false },
      width: 100,
      height: 50,
    });
  });

  test("a whole-image crop records no crop at all", () => {
    const session = sessionOn(1000, 400);
    session.toggleFlip("h");
    deepEqual(session.describe(), {
      crop: null,
      transform: { rotate: 0, flipH: true, flipV: false },
      width: 1000,
      height: 400,
    });
  });
});

report("edit");
