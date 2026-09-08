// Tests for the decode budget: the ceiling that refuses, the proxy that
// downscales, and the rule that the two never get confused. Run with:
//
//   node tests/budget.test.js
const { installDom, StubElement } = require("./stub-dom.js");
const dom = installDom();
const { core, EditSession, loadEditSource, DecodeBudgetError } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

/* A decode that a test drives.
 *
 * The real path is an <img> whose load event arrives later; the stub's
 * createElement hands one back immediately, so the test says what it decoded
 * to and fires the event. `fail` is the corrupt-file case.
 */
function decodingTo(width, height, options) {
  const settings = options || {};
  const created = [];
  document.createElement = (tag) => {
    const element = new StubElement(tag);
    if (tag === "img") {
      created.push(element);
      // Assigning src is what starts a decode, so the event is fired from the
      // setter — the same order the browser uses, one tick later.
      Object.defineProperty(element, "src", {
        set(value) {
          element.assignedSrc = value;
          element.naturalWidth = width;
          element.naturalHeight = height;
          setImmediate(() => element.fire(settings.fail ? "error" : "load"));
        },
        get() {
          return element.assignedSrc || "";
        },
        configurable: true,
      });
    }
    return element;
  };
  return created;
}

group("the ceiling", () => {
  test("megapixels are width times height", () => {
    close(core.megapixelsOf(1000, 1000), 1);
    close(core.megapixelsOf(12000, 9000), 108);
    close(core.megapixelsOf(0, 500), 0);
  });

  test("the budget is 40 megapixels", () => {
    equal(core.MAX_DECODE_MEGAPIXELS, 40);
    equal(core.exceedsDecodeBudget(8000, 5000), false, "exactly 40 MP is inside it");
    equal(core.exceedsDecodeBudget(8000, 5001), true);
    equal(core.exceedsDecodeBudget(12000, 9000), true);
    equal(core.exceedsDecodeBudget(4000, 3000), false);
  });

  test("a caller may set its own ceiling", () => {
    equal(core.exceedsDecodeBudget(2000, 2000, 1), true);
    equal(core.exceedsDecodeBudget(2000, 2000, 100), false);
  });

  test("the refusal names the dimensions, because 'too big' is not actionable", () => {
    const message = core.decodeBudgetMessage(12000, 9000);
    ok(message.includes("12000 x 9000"), message);
    ok(message.includes("108"), message);
    ok(message.includes("40 MP"), message);
  });
});

group("the display proxy", () => {
  test("an image inside the edge limit is shown as itself", () => {
    equal(core.proxyScaleFor(1920, 1080), 1);
    deepEqual(core.proxySize(1920, 1080), { width: 1920, height: 1080, scale: 1 });
    equal(core.proxyScaleFor(4096, 4096), 1, "exactly at the limit still needs no proxy");
  });

  test("a long edge over the limit is scaled down to it", () => {
    equal(core.proxyScaleFor(8192, 2048), 0.5);
    deepEqual(core.proxySize(8192, 2048), { width: 4096, height: 1024, scale: 0.5 });
    deepEqual(core.proxySize(2048, 8192), { width: 1024, height: 4096, scale: 0.5 });
  });

  test("a small image is never scaled up to fill the limit", () => {
    equal(core.proxyScaleFor(64, 64), 1);
    equal(core.proxyScaleFor(64, 64, 4096), 1);
  });

  test("an axis never rounds away to nothing", () => {
    const size = core.proxySize(100000, 3, 4096);
    ok(size.height >= 1, "the short edge survives: " + size.height);
  });

  test("the display scale is measured, not accumulated", () => {
    close(core.displayScaleFor(512, 1024), 0.5);
    close(core.displayScaleFor(2048, 1024), 2);
    equal(core.displayScaleFor(0, 1024), 1, "nothing laid out yet reads as 1:1");
    equal(core.displayScaleFor(512, 0), 1);
  });

  test("scaling a rectangle expands it outward", () => {
    deepEqual(core.scaleRect({ x: 3, y: 3, w: 5, h: 5 }, 0.5), { x: 1, y: 1, w: 3, h: 3 });
    deepEqual(core.scaleRect({ x: 10, y: 20, w: 30, h: 40 }, 2), { x: 20, y: 40, w: 60, h: 80 });
    deepEqual(core.scaleRect({ x: 10, y: 20, w: 30, h: 40 }, 0), { x: 10, y: 20, w: 30, h: 40 });
  });
});

group("loading a source", () => {
  test("a normal image loads at full size with no proxy", async () => {
    decodingTo(1600, 1200);
    const source = await loadEditSource("app://cover.png");
    equal(source.width, 1600);
    equal(source.height, 1200);
    equal(source.preview.scale, 1);
    equal(source.preview.image, source.image, "the preview is the image itself");
  });

  test("an image over the edge limit gets a downscaled preview", async () => {
    decodingTo(8192, 4096);
    const source = await loadEditSource("app://huge.png");
    equal(source.width, 8192, "the source dimensions are the file's, not the proxy's");
    equal(source.preview.width, 4096);
    equal(source.preview.height, 2048);
    equal(source.preview.scale, 0.5);
    ok(source.preview.image !== source.image, "and the preview is a canvas");
    const context = source.preview.image.getContext("2d");
    deepEqual(context.drawn[0], { source: source.image, x: 0, y: 0, width: 4096, height: 2048 });
  });

  test("an image over the ceiling is refused, naming its dimensions", async () => {
    decodingTo(12000, 9000);
    let error = null;
    try {
      await loadEditSource("app://enormous.png");
    } catch (thrown) {
      error = thrown;
    }
    ok(error, "it refused");
    equal(error.name, "DecodeBudgetError");
    ok(error instanceof DecodeBudgetError);
    equal(error.width, 12000);
    ok(error.message.includes("12000 x 9000"), error.message);
  });

  test("a file the browser cannot decode fails as a plain error", async () => {
    decodingTo(0, 0, { fail: true });
    let error = null;
    try {
      await loadEditSource("app://broken.png");
    } catch (thrown) {
      error = thrown;
    }
    ok(error, "it failed");
    ok(error.name !== "DecodeBudgetError", "and not as a budget refusal");
  });

  test("a decode that reports no dimensions is an error, not a zero-pixel session", async () => {
    decodingTo(0, 0);
    let error = null;
    try {
      await loadEditSource("app://sizeless.svg");
    } catch (thrown) {
      error = thrown;
    }
    ok(error, "it failed");
  });
});

group("editing through a proxy", () => {
  function proxiedSession() {
    const image = new StubElement("img");
    const preview = new StubElement("canvas");
    return new EditSession({
      path: "data/assets/huge.png",
      image,
      width: 8192,
      height: 4096,
      preview: { image: preview, width: 4096, height: 2048, scale: 0.5 },
    });
  }

  test("the maths runs in full source coordinates", () => {
    const session = proxiedSession();
    session.setCrop({ x: 1000, y: 500, w: 4000, h: 2000 });
    deepEqual(session.outputSize, { width: 4000, height: 2000 }, "full-resolution pixels");
  });

  test("the preview draws the proxy at proxy scale", () => {
    const session = proxiedSession();
    session.setCrop({ x: 1000, y: 500, w: 4000, h: 2000 });
    const canvas = session.renderPreviewTo(new StubElement("canvas"), 4096);
    equal(canvas.width, 2000, "half of the crop's width");
    equal(canvas.height, 1000);
    const context = canvas.getContext("2d");
    equal(context.drawn[0].source, session.preview.image);
    equal(context.drawn[0].width, 4096, "drawn at the proxy's own size");
  });

  test("the preview is capped again on the way out", () => {
    const session = proxiedSession();
    const canvas = session.renderPreviewTo(new StubElement("canvas"), 1024);
    equal(Math.max(canvas.width, canvas.height), 1024);
    equal(canvas.width, 1024);
    equal(canvas.height, 512);
  });

  test("the preview ignores a resize, which is a number rather than a picture", () => {
    const session = proxiedSession();
    session.setScale(0.25);
    deepEqual(session.outputSize, { width: 2048, height: 1024 });
    const canvas = session.renderPreviewTo(new StubElement("canvas"), 4096);
    equal(canvas.width, 4096, "still the whole proxy");
  });

  test("saving renders from the source, never from the proxy", () => {
    const session = proxiedSession();
    session.setCrop({ x: 1000, y: 500, w: 4000, h: 2000 });
    const canvas = session.render();
    equal(canvas.width, 4000);
    const context = canvas.getContext("2d");
    equal(context.drawn[0].source, session.image, "the full-resolution decode");
    equal(context.drawn[0].width, 8192);
  });

  test("a session with no proxy given treats the image as its own preview", () => {
    const image = new StubElement("img");
    const session = new EditSession({ path: "a.png", image, width: 100, height: 80 });
    equal(session.preview.image, image);
    equal(session.preview.scale, 1);
    equal(session.preview.width, 100);
  });
});

report("budget");
