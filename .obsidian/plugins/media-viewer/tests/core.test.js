// Tests for the `core` block of main.js. Run with:
//
//   node tests/core.test.js
//
// These assert the behaviour the design spec states, not whatever the
// implementation happens to do — that distinction is the whole point of the
// crop-mapping tests arriving later in this file's life.
const { core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const FIXED_DATE = new Date(2026, 8, 8, 11, 4, 22); // 2026-09-08 11:04:22 local
const NEVER = () => false;
const takenIn = (paths) => {
  const set = new Set(paths);
  return (path) => set.has(path);
};

group("path pieces", () => {
  test("splits folder, name, stem and extension", () => {
    equal(core.folderOf("data/assets/cover.png"), "data/assets");
    equal(core.baseNameOf("data/assets/cover.png"), "cover.png");
    equal(core.stemOf("data/assets/cover.png"), "cover");
    equal(core.extensionOf("data/assets/cover.png"), "png");
  });

  test("a file at the vault root has an empty folder", () => {
    equal(core.folderOf("cover.png"), "");
    equal(core.stemOf("cover.png"), "cover");
  });

  test("normalises Windows separators", () => {
    equal(core.folderOf("data\\assets\\cover.png"), "data/assets");
    equal(core.baseNameOf("data\\assets\\cover.png"), "cover.png");
  });

  test("extension is lowercased", () => {
    equal(core.extensionOf("COVER.PNG"), "png");
    equal(core.extensionOf("clip.MP4"), "mp4");
  });

  test("a dotfile is a name, not an extension", () => {
    equal(core.extensionOf(".gitignore"), "");
    equal(core.stemOf(".gitignore"), ".gitignore");
  });

  test("no extension, and a trailing dot, both yield none", () => {
    equal(core.extensionOf("README"), "");
    equal(core.extensionOf("odd."), "");
  });

  test("only the last dot separates the extension", () => {
    equal(core.stemOf("cover+clone+260908110422.png"), "cover+clone+260908110422");
    equal(core.extensionOf("archive.tar.gz"), "gz");
    equal(core.stemOf("archive.tar.gz"), "archive.tar");
  });

  test("null and undefined are empty, not a throw", () => {
    equal(core.baseNameOf(null), "");
    equal(core.folderOf(undefined), "");
    equal(core.extensionOf(null), "");
  });

  test("joinPath drops a trailing slash and handles the root", () => {
    equal(core.joinPath("data/assets", "cover.png"), "data/assets/cover.png");
    equal(core.joinPath("data/assets/", "cover.png"), "data/assets/cover.png");
    equal(core.joinPath("", "cover.png"), "cover.png");
  });
});

group("extension classification", () => {
  test("images classify as image", () => {
    for (const extension of ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "avif"]) {
      equal(core.classifyExtension(extension), "image", extension);
    }
  });

  test("videos classify as video", () => {
    for (const extension of ["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"]) {
      equal(core.classifyExtension(extension), "video", extension);
    }
  });

  test("uppercase and a leading dot both classify", () => {
    equal(core.classifyExtension("PNG"), "image");
    equal(core.classifyExtension(".MP4"), "video");
  });

  test("unknown classifies as other rather than throwing", () => {
    equal(core.classifyExtension("psd"), "other");
    equal(core.classifyExtension(""), "other");
    equal(core.classifyExtension(null), "other");
    equal(core.classifyExtension(undefined), "other");
  });

  test("classifyPath reads the extension off a full path", () => {
    equal(core.classifyPath("data/assets/cover.PNG"), "image");
    equal(core.classifyPath("data/assets/clip.mp4"), "video");
    equal(core.classifyPath("data/assets/notes.md"), "other");
  });

  test("isMediaPath is image or video, nothing else", () => {
    equal(core.isMediaPath("a/cover.png"), true);
    equal(core.isMediaPath("a/clip.mov"), true);
    equal(core.isMediaPath("a/cover.instance.md"), false);
    equal(core.isMediaPath("a/README"), false);
  });
});

group("lineage notes are not media", () => {
  // There is no longer a sidecar suffix to recognise. Lineage notes are
  // markdown records found through metadataCache, and the one rule the grid
  // needs is the one it already had: markdown is not media.
  test("a note never reads as media, whatever it is called", () => {
    equal(core.isMediaPath("MyVault/data/media/cover.md"), false);
    equal(core.isMediaPath("data/assets/cover.instance.md"), false);
    equal(core.isMediaPath("data/assets/cover.png"), true);
  });

  test("and a note never moves the pane", () => {
    equal(core.folderForActiveFile("MyVault/data/media/cover.md"), null);
    equal(core.folderForActiveFile("data/assets/cover.instance.md"), null);
    equal(core.folderForActiveFile("data/assets/cover.png"), "data/assets");
  });
});

group("grid filter", () => {
  test("both admits image and video", () => {
    equal(core.matchesFilter("a/cover.png", "both"), true);
    equal(core.matchesFilter("a/clip.mp4", "both"), true);
    equal(core.matchesFilter("a/notes.md", "both"), false);
  });

  test("image and video each admit only their own kind", () => {
    equal(core.matchesFilter("a/cover.png", "image"), true);
    equal(core.matchesFilter("a/clip.mp4", "image"), false);
    equal(core.matchesFilter("a/clip.mp4", "video"), true);
    equal(core.matchesFilter("a/cover.png", "video"), false);
  });

  test("an unrecognised filter falls back to both", () => {
    equal(core.matchesFilter("a/cover.png", undefined), true);
    equal(core.matchesFilter("a/clip.mp4", "nonsense"), true);
    equal(core.matchesFilter("a/notes.md", "nonsense"), false);
  });
});

group("output format follows the source", () => {
  test("JPEG stays JPEG and WebP stays WebP", () => {
    equal(core.mimeForExtension("jpg"), "image/jpeg");
    equal(core.mimeForExtension("jpeg"), "image/jpeg");
    equal(core.mimeForExtension("webp"), "image/webp");
    equal(core.outputExtensionFor("jpeg"), "jpg", "both JPEG spellings write .jpg");
    equal(core.outputExtensionFor("webp"), "webp");
  });

  test("PNG, BMP and GIF all encode to PNG", () => {
    for (const extension of ["png", "bmp", "gif"]) {
      equal(core.mimeForExtension(extension), "image/png", extension);
      equal(core.outputExtensionFor(extension), "png", extension);
    }
  });

  test("anything unknown encodes to PNG rather than guessing", () => {
    equal(core.mimeForExtension("psd"), "image/png");
    equal(core.outputExtensionFor("svg"), "png");
    equal(core.outputExtensionFor(""), "png");
    equal(core.outputExtensionFor(null), "png");
  });

  test("uppercase is accepted", () => {
    equal(core.outputExtensionFor("JPG"), "jpg");
    equal(core.mimeForExtension(".WEBP"), "image/webp");
  });
});

group("zoom clamping", () => {
  test("holds at both limits", () => {
    equal(core.clampZoom(0.0001), core.ZOOM_MIN);
    equal(core.clampZoom(1000), core.ZOOM_MAX);
    equal(core.clampZoom(core.ZOOM_MIN), core.ZOOM_MIN);
    equal(core.clampZoom(core.ZOOM_MAX), core.ZOOM_MAX);
  });

  test("passes a value inside the range through untouched", () => {
    equal(core.clampZoom(1), 1);
    equal(core.clampZoom(2.5), 2.5);
  });

  test("nonsense clamps to 100% rather than propagating NaN", () => {
    equal(core.clampZoom(NaN), 1);
    equal(core.clampZoom(Infinity), core.ZOOM_MAX, "Infinity is a real bound, not nonsense");
    equal(core.clampZoom(-Infinity), core.ZOOM_MIN);
    equal(core.clampZoom(undefined), 1);
    equal(core.clampZoom("nonsense"), 1);
  });

  test("negative zoom clamps up to the minimum", () => {
    equal(core.clampZoom(-3), core.ZOOM_MIN);
  });
});

group("zoom stepping", () => {
  test("a step up then a step down returns where it started", () => {
    const up = core.stepZoom(1, 1);
    close(core.stepZoom(up, -1), 1, 1e-12);
  });

  test("steps compound at the given ratio", () => {
    close(core.stepZoom(1, 2, 2), 4, 1e-12);
    close(core.stepZoom(1, -2, 2), 0.25, 1e-12);
  });

  test("zero steps is a no-op, but still clamps", () => {
    equal(core.stepZoom(2, 0), 2);
    equal(core.stepZoom(1000, 0), core.ZOOM_MAX);
  });

  test("stepping past a limit stops at it", () => {
    equal(core.stepZoom(core.ZOOM_MAX, 5), core.ZOOM_MAX);
    equal(core.stepZoom(core.ZOOM_MIN, -5), core.ZOOM_MIN);
  });

  test("a ratio at or below 1 falls back to the default rather than shrinking on zoom-in", () => {
    equal(core.stepZoom(1, 1, 1), core.stepZoom(1, 1));
    equal(core.stepZoom(1, 1, 0.5), core.stepZoom(1, 1));
    ok(core.stepZoom(1, 1) > 1, "a step up magnifies");
  });
});

group("fit to pane", () => {
  test("fits the constraining edge", () => {
    close(core.fitZoom(1000, 500, 500, 500), 0.5, 1e-12, "width constrains");
    close(core.fitZoom(500, 1000, 500, 500), 0.5, 1e-12, "height constrains");
  });

  test("never magnifies past 100%", () => {
    equal(core.fitZoom(100, 100, 1000, 1000), 1);
  });

  test("a degenerate size falls back to 100% instead of dividing by zero", () => {
    equal(core.fitZoom(0, 100, 500, 500), 1);
    equal(core.fitZoom(100, 100, 0, 500), 1);
    equal(core.fitZoom(NaN, 100, 500, 500), 1);
  });

  test("an enormous image still fits, down to the zoom floor", () => {
    equal(core.fitZoom(100000, 100000, 100, 100), core.ZOOM_MIN);
  });
});

group("timestamps", () => {
  test("formats yymmddHHMMSS", () => {
    equal(core.timestampFor(FIXED_DATE), "260908110422");
  });

  test("pads every field", () => {
    equal(core.timestampFor(new Date(2026, 0, 2, 3, 4, 5)), "260102030405");
  });

  test("an invalid date falls back to now rather than producing NaNs", () => {
    const stamp = core.timestampFor(new Date("nonsense"));
    equal(stamp.length, 12);
    ok(/^[0-9]{12}$/.test(stamp), "all digits");
  });
});

group("unique paths", () => {
  test("returns the plain name when nothing holds it", () => {
    equal(core.uniquePath("a", "cover", "png", NEVER), "a/cover.png");
  });

  test("numbers before the extension, so the file keeps a usable one", () => {
    equal(core.uniquePath("a", "cover", "png", takenIn(["a/cover.png"])), "a/cover.1.png");
  });

  test("walks the sequence past a run of collisions", () => {
    const taken = takenIn(["a/cover.png", "a/cover.1.png", "a/cover.2.png"]);
    equal(core.uniquePath("a", "cover", "png", taken), "a/cover.3.png");
  });

  test("works at the vault root and with no extension", () => {
    equal(core.uniquePath("", "cover", "png", NEVER), "cover.png");
    equal(core.uniquePath("a", "cover", "", takenIn(["a/cover"])), "a/cover.1");
  });

  test("a missing `taken` is treated as nothing being taken", () => {
    equal(core.uniquePath("a", "cover", "png"), "a/cover.png");
  });
});

group("clone paths", () => {
  test("names the file beside its source, carrying the timestamp", () => {
    equal(
      core.clonePathFor("data/assets/cover.png", NEVER, FIXED_DATE),
      "data/assets/cover+clone+260908110422.png"
    );
  });

  test("the extension follows the source, so a JPEG crop stays a JPEG", () => {
    equal(
      core.clonePathFor("data/assets/photo.jpeg", NEVER, FIXED_DATE),
      "data/assets/photo+clone+260908110422.jpg"
    );
    equal(
      core.clonePathFor("data/assets/art.webp", NEVER, FIXED_DATE),
      "data/assets/art+clone+260908110422.webp"
    );
    equal(
      core.clonePathFor("data/assets/old.bmp", NEVER, FIXED_DATE),
      "data/assets/old+clone+260908110422.png",
      "BMP encodes to PNG"
    );
  });

  test("a clone of a clone stacks its provenance rather than flattening it", () => {
    equal(
      core.clonePathFor("data/assets/cover+clone+260908110422.png", NEVER, FIXED_DATE),
      "data/assets/cover+clone+260908110422+clone+260908110422.png"
    );
  });

  test("two clones in the same second collide and number", () => {
    const first = core.clonePathFor("a/cover.png", NEVER, FIXED_DATE);
    const second = core.clonePathFor("a/cover.png", takenIn([first]), FIXED_DATE);
    equal(second, "a/cover+clone+260908110422.1.png");
  });

  test("a source at the vault root writes to the vault root", () => {
    equal(core.clonePathFor("cover.png", NEVER, FIXED_DATE), "cover+clone+260908110422.png");
  });
});

group("frame-capture paths", () => {
  test("named for when it was taken, and always PNG", () => {
    equal(
      core.framePathFor("data/assets/clip.mp4", NEVER, FIXED_DATE),
      "data/assets/clip+frame+260908110422.png"
    );
  });

  test("the position in the source is not in the name", () => {
    // It used to be, as +frame+1500ms+ — data encoded into a filename by an
    // app with nowhere else to put it. The note records it exactly, and
    // nothing ever read it back out of the name.
    const path = core.framePathFor("a/clip.mp4", NEVER, FIXED_DATE);
    equal(path.includes("ms+"), false);
  });

  test("two captures in the same second collide and number", () => {
    const first = core.framePathFor("a/clip.mp4", NEVER, FIXED_DATE);
    equal(
      core.framePathFor("a/clip.mp4", takenIn([first]), FIXED_DATE),
      "a/clip+frame+260908110422.1.png"
    );
  });

  test("a capture of a source at the vault root writes to the vault root", () => {
    equal(core.framePathFor("clip.mp4", NEVER, FIXED_DATE), "clip+frame+260908110422.png");
  });
});

/* Gone with the mechanism: the sidecar-path group.
 *
 * It verified a collision sequence — cover.instance.md, then
 * cover.png.instance.md when cover.png and cover.mp4 shared a folder, then
 * numbered forms beyond that — for finding a note beside its media by name.
 * MV-STORE finds notes through metadataCache instead, so there is no name to
 * build and no collision to sequence. What replaces these tests is MV-STORE's
 * own: that a note is still found after being moved and renamed by hand. */

/* ------------------------------------------------------------------------ *
 * MV-CROPMATH
 *
 * Written from the design spec rather than from the implementation, which is
 * the whole reason this task exists: divide by the display scale, floor the
 * top-left, ceil the bottom-right, clamp to the image, refuse anything that
 * resolves to less than 1x1. Expanding outward never discards a pixel the user
 * could see inside their selection; rounding to nearest sometimes does.
 * ------------------------------------------------------------------------ */

group("rectangles", () => {
  test("a drag up and to the left normalises to a positive rectangle", () => {
    deepEqual(core.normaliseRect({ x: 100, y: 80, w: -40, h: -30 }), { x: 60, y: 50, w: 40, h: 30 });
  });

  test("a rectangle already positive is unchanged", () => {
    deepEqual(core.normaliseRect({ x: 5, y: 6, w: 7, h: 8 }), { x: 5, y: 6, w: 7, h: 8 });
  });

  test("nonsense coordinates collapse to an empty rectangle at the origin", () => {
    deepEqual(core.normaliseRect(null), { x: 0, y: 0, w: 0, h: 0 });
    deepEqual(core.normaliseRect({ x: NaN, y: 3, w: "x", h: 2 }), { x: 0, y: 3, w: 0, h: 2 });
  });

  test("clamping keeps a rectangle inside the image", () => {
    deepEqual(core.clampRect({ x: -10, y: -10, w: 40, h: 40 }, 100, 50), { x: 0, y: 0, w: 30, h: 30 });
    deepEqual(core.clampRect({ x: 90, y: 40, w: 40, h: 40 }, 100, 50), { x: 90, y: 40, w: 10, h: 10 });
  });

  test("a rectangle entirely outside the image clamps to nothing", () => {
    deepEqual(core.clampRect({ x: 200, y: 0, w: 10, h: 10 }, 100, 50), { x: 100, y: 0, w: 0, h: 10 });
  });
});

group("rotation bookkeeping", () => {
  test("rotations normalise into the four quarter turns", () => {
    equal(core.normaliseRotation(0), 0);
    equal(core.normaliseRotation(90), 90);
    equal(core.normaliseRotation(-90), 270);
    equal(core.normaliseRotation(450), 90);
    equal(core.normaliseRotation(-450), 270);
    equal(core.normaliseRotation("180"), 180);
    equal(core.normaliseRotation(37), 0, "anything not a quarter turn is refused, not rounded");
  });

  test("a quarter turn swaps the oriented dimensions", () => {
    deepEqual(core.orientedSize(1000, 400, 0), { width: 1000, height: 400 });
    deepEqual(core.orientedSize(1000, 400, 90), { width: 400, height: 1000 });
    deepEqual(core.orientedSize(1000, 400, 180), { width: 1000, height: 400 });
    deepEqual(core.orientedSize(1000, 400, 270), { width: 400, height: 1000 });
  });
});

group("crop mapping", () => {
  test("at 100% the selection is the crop", () => {
    deepEqual(core.cropFromSelection({ x: 120, y: 40, w: 800, h: 600 }, 1, 1000, 700), {
      x: 120,
      y: 40,
      w: 800,
      h: 600,
    });
  });

  test("the top-left floors and the bottom-right ceils", () => {
    // At 3x, 10..37 CSS px is 3.333..12.333 source px. Floor 3, ceil 13.
    deepEqual(core.cropFromSelection({ x: 10, y: 10, w: 27, h: 27 }, 3, 1000, 1000), {
      x: 3,
      y: 3,
      w: 10,
      h: 10,
    });
  });

  test("expanding outward never loses a visible pixel", () => {
    // Rounding to nearest would give x=4 here and drop the leftmost column the
    // user could see inside their selection.
    const rect = core.cropFromSelection({ x: 11, y: 11, w: 26, h: 26 }, 3, 1000, 1000);
    deepEqual(rect, { x: 3, y: 3, w: 10, h: 10 });
    ok(rect.x <= 11 / 3, "left edge is at or outside the selection");
    ok(rect.x + rect.w >= 37 / 3, "right edge is at or outside the selection");
  });

  test("a zoomed-out selection still maps to full-resolution pixels", () => {
    deepEqual(core.cropFromSelection({ x: 50, y: 25, w: 100, h: 50 }, 0.25, 4000, 3000), {
      x: 200,
      y: 100,
      w: 400,
      h: 200,
    });
  });

  test("the rule holds across a spread of zoom levels", () => {
    for (const zoom of [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4.5, 8, 16, 32]) {
      const selection = { x: 17.3, y: 9.1, w: 61.7, h: 44.9 };
      const rect = core.cropFromSelection(selection, zoom, 5000, 5000);
      equal(rect.x, Math.floor(selection.x / zoom), "left at zoom " + zoom);
      equal(rect.y, Math.floor(selection.y / zoom), "top at zoom " + zoom);
      equal(rect.x + rect.w, Math.ceil((selection.x + selection.w) / zoom), "right at zoom " + zoom);
      equal(rect.y + rect.h, Math.ceil((selection.y + selection.h) / zoom), "bottom at zoom " + zoom);
    }
  });

  test("a selection overhanging the edge is clamped, not refused", () => {
    deepEqual(core.cropFromSelection({ x: -30, y: -30, w: 200, h: 200 }, 1, 100, 80), {
      x: 0,
      y: 0,
      w: 100,
      h: 80,
    });
  });

  test("a selection overhanging one edge keeps the part that is on the image", () => {
    deepEqual(core.cropFromSelection({ x: 80, y: 60, w: 100, h: 100 }, 1, 100, 80), {
      x: 80,
      y: 60,
      w: 20,
      h: 20,
    });
  });

  test("a selection overhanging at zoom still lands on whole source pixels", () => {
    deepEqual(core.cropFromSelection({ x: -12.5, y: 197, w: 60, h: 40 }, 2, 100, 100), {
      x: 0,
      y: 98,
      w: 24,
      h: 2,
    });
  });

  test("a selection entirely off the image is refused", () => {
    equal(core.cropFromSelection({ x: 500, y: 0, w: 40, h: 40 }, 1, 100, 80), null);
    equal(core.cropFromSelection({ x: -500, y: 0, w: 40, h: 40 }, 1, 100, 80), null);
  });

  test("a selection resolving to less than 1x1 is refused", () => {
    equal(core.cropFromSelection({ x: 0, y: 0, w: 0, h: 0 }, 1, 100, 80), null);
    // A whole source pixel wide, but zero high: still nothing to cut.
    equal(core.cropFromSelection({ x: 10, y: 10, w: 40, h: 0 }, 1, 100, 80), null);
  });

  test("a hair of a selection still rounds out to a whole pixel", () => {
    deepEqual(core.cropFromSelection({ x: 10.2, y: 10.2, w: 0.4, h: 0.4 }, 1, 100, 80), {
      x: 10,
      y: 10,
      w: 1,
      h: 1,
    });
  });

  test("a backwards drag maps the same as the forwards one", () => {
    deepEqual(
      core.cropFromSelection({ x: 120, y: 90, w: -60, h: -40 }, 2, 200, 200),
      core.cropFromSelection({ x: 60, y: 50, w: 60, h: 40 }, 2, 200, 200)
    );
  });

  test("a missing or absurd display scale is treated as 100%", () => {
    deepEqual(core.cropFromSelection({ x: 4, y: 4, w: 8, h: 8 }, 0, 100, 100), {
      x: 4,
      y: 4,
      w: 8,
      h: 8,
    });
    deepEqual(core.cropFromSelection({ x: 4, y: 4, w: 8, h: 8 }, NaN, 100, 100), {
      x: 4,
      y: 4,
      w: 8,
      h: 8,
    });
  });

  test("a crop maps back to the selection that would draw it", () => {
    deepEqual(core.selectionFromCrop({ x: 10, y: 20, w: 30, h: 40 }, 2), {
      x: 20,
      y: 40,
      w: 60,
      h: 80,
    });
  });
});

group("carrying a crop through a rotation", () => {
  // The image is 1000x400 in oriented space; the crop is the left-hand strip.
  const strip = { x: 0, y: 0, w: 100, h: 400 };

  test("a quarter turn clockwise moves the strip to the top", () => {
    deepEqual(core.rotateRect(strip, 1000, 400, 90), { x: 0, y: 0, w: 400, h: 100 });
  });

  test("a half turn moves the strip to the right", () => {
    deepEqual(core.rotateRect(strip, 1000, 400, 180), { x: 900, y: 0, w: 100, h: 400 });
  });

  test("a quarter turn anticlockwise moves the strip to the bottom", () => {
    deepEqual(core.rotateRect(strip, 1000, 400, 270), { x: 0, y: 900, w: 400, h: 100 });
  });

  test("four quarter turns come back to where they started", () => {
    let rect = { x: 37, y: 11, w: 120, h: 63 };
    let width = 1000;
    let height = 400;
    for (let turn = 0; turn < 4; turn += 1) {
      rect = core.rotateRect(rect, width, height, 90);
      const size = core.orientedSize(width, height, 90);
      width = size.width;
      height = size.height;
    }
    deepEqual(rect, { x: 37, y: 11, w: 120, h: 63 });
    equal(width, 1000);
    equal(height, 400);
  });

  test("the same region stays selected when rotation changes", () => {
    deepEqual(core.cropAfterRotation(strip, 1000, 400, 90, false, false), {
      x: 0,
      y: 0,
      w: 400,
      h: 100,
    });
  });

  test("with one flip set, the stored rect turns the other way", () => {
    // The crop lives after the flip, so the flip conjugates the rotation:
    // turning the image clockwise turns the stored rectangle anticlockwise.
    deepEqual(core.cropAfterRotation(strip, 1000, 400, 90, true, false), {
      x: 0,
      y: 900,
      w: 400,
      h: 100,
    });
    deepEqual(core.cropAfterRotation(strip, 1000, 400, 90, false, true), {
      x: 0,
      y: 900,
      w: 400,
      h: 100,
    });
  });

  test("with both flips set, the conjugation cancels out", () => {
    deepEqual(core.cropAfterRotation(strip, 1000, 400, 90, true, true), {
      x: 0,
      y: 0,
      w: 400,
      h: 100,
    });
  });

  test("every rotation and flip combination keeps the same source pixels", () => {
    /* The check that matters, stated in the space the answer lives in: take a
       crop, change the rotation under it, and confirm it still names the same
       rectangle of the *source* image. Every other test in this group is one
       instance of this one. */
    const sourceWidth = 1000;
    const sourceHeight = 400;
    const rect = { x: 120, y: 40, w: 300, h: 200 };
    let checked = 0;
    for (const flipH of [false, true]) {
      for (const flipV of [false, true]) {
        for (const from of [0, 90, 180, 270]) {
          for (const to of [0, 90, 180, 270]) {
            const before = core.orientedSize(sourceWidth, sourceHeight, from);
            const start = core.clampRect(rect, before.width, before.height);
            if (start.w < 1 || start.h < 1) continue;
            const moved = core.cropAfterRotation(
              start,
              before.width,
              before.height,
              to - from,
              flipH,
              flipV
            );
            const wanted = core.sourceRectFor(start, sourceWidth, sourceHeight, from, flipH, flipV);
            const got = core.sourceRectFor(moved, sourceWidth, sourceHeight, to, flipH, flipV);
            deepEqual(got, wanted, from + "->" + to + " flipH=" + flipH + " flipV=" + flipV);
            checked += 1;
          }
        }
      }
    }
    equal(checked, 64, "every combination was actually reached");
  });

  test("toggling a flip mirrors the rect in oriented space", () => {
    deepEqual(core.cropAfterFlip(strip, 1000, 400, "h"), { x: 900, y: 0, w: 100, h: 400 });
    deepEqual(core.cropAfterFlip(strip, 1000, 400, "v"), { x: 0, y: 0, w: 100, h: 400 });
    deepEqual(core.cropAfterFlip({ x: 0, y: 0, w: 100, h: 40 }, 1000, 400, "v"), {
      x: 0,
      y: 360,
      w: 100,
      h: 40,
    });
  });

  test("toggling a flip twice is the identity", () => {
    const rect = { x: 37, y: 11, w: 120, h: 63 };
    deepEqual(core.cropAfterFlip(core.cropAfterFlip(rect, 1000, 400, "h"), 1000, 400, "h"), rect);
    deepEqual(core.cropAfterFlip(core.cropAfterFlip(rect, 1000, 400, "v"), 1000, 400, "v"), rect);
  });

  test("a flip toggle keeps the same source pixels in every rotation", () => {
    const rect = { x: 120, y: 40, w: 300, h: 200 };
    for (const rotate of [0, 90, 180, 270]) {
      for (const axis of ["h", "v"]) {
        for (const flipH of [false, true]) {
          for (const flipV of [false, true]) {
            const size = core.orientedSize(1000, 400, rotate);
            const start = core.clampRect(rect, size.width, size.height);
            if (start.w < 1 || start.h < 1) continue;
            const nextH = axis === "h" ? !flipH : flipH;
            const nextV = axis === "v" ? !flipV : flipV;
            const moved = core.cropAfterFlip(start, size.width, size.height, axis);
            deepEqual(
              core.sourceRectFor(moved, 1000, 400, rotate, nextH, nextV),
              core.sourceRectFor(start, 1000, 400, rotate, flipH, flipV),
              "rotate=" + rotate + " axis=" + axis + " " + flipH + "/" + flipV
            );
          }
        }
      }
    }
  });
});

group("oriented and source space", () => {
  test("with no transform the two spaces are the same", () => {
    deepEqual(core.sourceRectFor({ x: 10, y: 20, w: 30, h: 40 }, 1000, 400, 0, false, false), {
      x: 10,
      y: 20,
      w: 30,
      h: 40,
    });
  });

  test("a quarter turn maps the oriented rect back onto the source", () => {
    // Oriented space is 400x1000 after the turn; the top strip there is the
    // left strip of the source.
    deepEqual(core.sourceRectFor({ x: 0, y: 0, w: 400, h: 100 }, 1000, 400, 90, false, false), {
      x: 0,
      y: 0,
      w: 100,
      h: 400,
    });
  });

  test("a horizontal flip mirrors the rect back onto the source", () => {
    deepEqual(core.sourceRectFor({ x: 0, y: 0, w: 100, h: 400 }, 1000, 400, 0, true, false), {
      x: 900,
      y: 0,
      w: 100,
      h: 400,
    });
  });
});

report("core");
