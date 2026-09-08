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

group("sidecar recognition", () => {
  test("recognises a sidecar by suffix, case-insensitively", () => {
    equal(core.isSidecarPath("data/assets/cover.instance.md"), true);
    equal(core.isSidecarPath("data/assets/cover.mp4.instance.md"), true);
    equal(core.isSidecarPath("data/assets/COVER.INSTANCE.MD"), true);
  });

  test("an ordinary note is not a sidecar", () => {
    equal(core.isSidecarPath("data/assets/cover.md"), false);
    equal(core.isSidecarPath("data/assets/instance.md"), false, "bare instance.md has no stem");
    equal(core.isSidecarPath("data/assets/cover.png"), false);
  });

  test("mediaStemForSidecar strips the suffix, and refuses a non-sidecar", () => {
    equal(core.mediaStemForSidecar("data/assets/cover.instance.md"), "cover");
    equal(core.mediaStemForSidecar("data/assets/cover.mp4.instance.md"), "cover.mp4");
    equal(core.mediaStemForSidecar("data/assets/cover.md"), null);
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
  test("carries the position in milliseconds and always writes PNG", () => {
    equal(
      core.framePathFor("data/assets/clip.mp4", 1500, NEVER, FIXED_DATE),
      "data/assets/clip+frame+1500ms+260908110422.png"
    );
  });

  test("floors fractional milliseconds to a frame that was actually shown", () => {
    equal(
      core.framePathFor("a/clip.mp4", 1500.99, NEVER, FIXED_DATE),
      "a/clip+frame+1500ms+260908110422.png"
    );
  });

  test("a negative or unreadable position becomes zero", () => {
    equal(core.framePathFor("a/clip.mp4", -5, NEVER, FIXED_DATE), "a/clip+frame+0ms+260908110422.png");
    equal(core.framePathFor("a/clip.mp4", NaN, NEVER, FIXED_DATE), "a/clip+frame+0ms+260908110422.png");
  });

  test("two captures of the same frame collide and number", () => {
    const first = core.framePathFor("a/clip.mp4", 1500, NEVER, FIXED_DATE);
    equal(
      core.framePathFor("a/clip.mp4", 1500, takenIn([first]), FIXED_DATE),
      "a/clip+frame+1500ms+260908110422.1.png"
    );
  });
});

group("sidecar paths", () => {
  test("the plain form is the default", () => {
    equal(core.sidecarPathFor("data/assets/cover.png", NEVER), "data/assets/cover.instance.md");
  });

  test("both forms are offered for discovery", () => {
    deepEqual(core.sidecarCandidatesFor("data/assets/cover.png"), [
      "data/assets/cover.instance.md",
      "data/assets/cover.png.instance.md",
    ]);
  });

  test("cover.png and cover.mp4 in one folder do not fight over one note", () => {
    const png = core.sidecarPathFor("data/assets/cover.png", NEVER);
    equal(png, "data/assets/cover.instance.md");
    equal(
      core.sidecarPathFor("data/assets/cover.mp4", takenIn([png])),
      "data/assets/cover.mp4.instance.md",
      "the extension is folded in once the plain stem is taken"
    );
  });

  test("with both forms taken it numbers rather than overwriting", () => {
    const taken = takenIn(["a/cover.instance.md", "a/cover.png.instance.md"]);
    equal(core.sidecarPathFor("a/cover.png", taken), "a/cover.png.1.instance.md");
  });

  test("a media file with no extension has only the plain form", () => {
    deepEqual(core.sidecarCandidatesFor("a/cover"), ["a/cover.instance.md"]);
    equal(core.sidecarPathFor("a/cover", takenIn(["a/cover.instance.md"])), "a/cover.1.instance.md");
  });

  test("a sidecar path round-trips back to the media stem", () => {
    const path = core.sidecarPathFor("data/assets/cover.mp4", takenIn(["data/assets/cover.instance.md"]));
    equal(core.mediaStemForSidecar(path), "cover.mp4");
  });
});

report("core");
