// TrimSession — the model behind the pane. It holds the file, the in/out
// points and the clip list, and delegates every decision to `core`.
require("./stub-dom.js").installDom();
const { TrimSession, core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const HOUR = 3600;

function open(duration, fps) {
  const changes = [];
  const session = new TrimSession({ onChange: () => changes.push(1) });
  session.open("data/walk.mp4", { duration: duration === undefined ? HOUR : duration, fps: fps || null });
  return { session, changes };
}

group("opening", () => {
  test("a new file selects all of itself", () => {
    const { session } = open(HOUR);
    deepEqual(session.range, { start: 0, end: HOUR });
    equal(session.duration, HOUR);
  });

  test("the clip list survives opening another video", () => {
    // A list is built across several walkthroughs on purpose — that is what
    // makes an export a cut rather than a trim.
    const { session } = open(HOUR);
    session.setRange({ start: 10, end: 20 });
    session.addClip();
    session.open("data/login.mp4", { duration: 60 });
    equal(session.clips.length, 1);
    equal(session.clips[0].path, "data/walk.mp4");
    deepEqual(session.range, { start: 0, end: 60 }, "but the selection resets to the new file");
  });

  test("a file whose duration is unknown does not produce NaN anywhere", () => {
    const { session } = open(0);
    equal(session.duration, 0);
    ok(Number.isFinite(session.range.start) && Number.isFinite(session.range.end));
  });

  test("reports the probed frame rate, and null when there was none", () => {
    equal(open(HOUR, 29.97).session.fps, 29.97);
    equal(open(HOUR).session.fps, null);
  });
});

group("in and out points", () => {
  test("setting one end leaves the other where it was", () => {
    const { session } = open(HOUR);
    session.setStart(600);
    session.setEnd(900);
    deepEqual(session.range, { start: 600, end: 900 });
  });

  test("an out point before the in point swaps them rather than refusing", () => {
    const { session } = open(HOUR);
    session.setStart(600);
    session.setEnd(300);
    deepEqual(session.range, { start: 300, end: 600 });
  });

  test("every change is announced exactly once", () => {
    // The pane redraws on this, so a change that fired twice would redraw
    // twice on every drag frame.
    const { session, changes } = open(HOUR);
    const before = changes.length;
    session.setStart(10);
    equal(changes.length, before + 1);
  });
});

group("splitting", () => {
  test("both halves become clips and the selection moves to the second", () => {
    const { session } = open(HOUR);
    session.setRange({ start: 100, end: 200 });
    equal(session.split(150), true);
    equal(session.clips.length, 2);
    deepEqual({ start: session.clips[0].start, end: session.clips[0].end }, { start: 100, end: 150 });
    deepEqual({ start: session.clips[1].start, end: session.clips[1].end }, { start: 150, end: 200 });
    deepEqual(session.range, { start: 150, end: 200 });
  });

  test("refuses a split outside the selection, and adds nothing", () => {
    const { session } = open(HOUR);
    session.setRange({ start: 100, end: 200 });
    equal(session.split(500), false);
    equal(session.clips.length, 0, "a refused split leaves no half-clip behind");
  });
});

group("the clip list", () => {
  function withClips() {
    const { session } = open(HOUR);
    session.setRange({ start: 10, end: 20 });
    session.addClip();
    session.setRange({ start: 30, end: 60 });
    session.addClip();
    session.setRange({ start: 100, end: 105 });
    session.addClip();
    return session;
  }

  test("clips carry ids, because a row is dragged and an index is not a name", () => {
    const session = withClips();
    const ids = session.clips.map((clip) => clip.id);
    equal(new Set(ids).size, 3, "every id is distinct");
  });

  test("totals what will be exported", () => {
    close(withClips().totalClipSeconds(), 45, 1e-9);
  });

  test("reordering moves one row and keeps the rest", () => {
    const session = withClips();
    session.moveClip(0, 2);
    deepEqual(session.clips.map((clip) => clip.start), [30, 100, 10]);
    equal(session.selected, 2, "selection follows the row that moved");
  });

  test("removing selects the row that took its place", () => {
    const session = withClips();
    session.removeClip(0);
    equal(session.clips.length, 2);
    equal(session.selected, 0);
  });

  test("removing the last row selects the new last", () => {
    const session = withClips();
    session.removeClip(2);
    equal(session.selected, 1);
  });

  test("removing the only row selects nothing", () => {
    const { session } = open(HOUR);
    session.setRange({ start: 1, end: 5 });
    session.addClip();
    session.removeClip(0);
    equal(session.selected, -1);
    equal(session.selectedClip(), null);
  });

  test("a clip cannot be added before a file is open", () => {
    const session = new TrimSession({});
    equal(session.addClip(), null);
    equal(session.clips.length, 0);
  });

  test("clearing empties the list and says whether it did anything", () => {
    const session = withClips();
    equal(session.clearClips(), true);
    equal(session.clearClips(), false, "clearing an empty list is not a change");
  });
});

group("a sixty-minute file", () => {
  test("holds full precision an hour in", () => {
    // 3540.983 is a real frame on an hour-long 60 fps capture, and rounding it
    // to the second would lose the click it was cut for.
    const { session } = open(HOUR, 60);
    session.setStart(3540.983);
    close(session.range.start, 3540.983, 1e-9);
    ok(session.range.end <= HOUR, "and never runs past the file");
  });

  test("an in point with no room left is pulled back, not pushed past the end", () => {
    const { session } = open(HOUR, 60);
    session.setStart(HOUR - 0.017);
    equal(session.range.end, HOUR, "the file is still the limit");
    ok(session.range.start < HOUR - 0.017, "the start gave way instead");
    ok(core.normaliseClip({ path: "a.mp4", start: session.range.start, end: session.range.end }));
  });

  test("a clip at the very end is still a clip", () => {
    const { session } = open(HOUR, 60);
    session.setRange({ start: HOUR - 0.02, end: HOUR });
    const clip = session.addClip();
    ok(clip, "not silently dropped for being short");
    ok(core.normaliseClip(clip), "and it survives the export planner");
  });
});

report("video-editor session");
