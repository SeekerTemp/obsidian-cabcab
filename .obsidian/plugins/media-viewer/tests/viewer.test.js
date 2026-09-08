// Tests for the image viewer: the pan and zoom geometry in `core`, then the
// surface that holds the state — zoom about the cursor, panning, fit, reset,
// and A/D sibling navigation.
//
//   node tests/viewer.test.js
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const MediaViewerPlugin = require("./load-plugin.js");
const { MediaViewerView, core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

group("pan limits", () => {
  test("an image larger than the pane can move by half its overhang each way", () => {
    equal(core.panLimit(1000, 400), 300);
  });

  test("an image that fits cannot move at all, so it stays centred", () => {
    equal(core.panLimit(200, 400), 0);
    equal(core.panLimit(400, 400), 0);
  });

  test("a degenerate size pins the pan rather than producing a NaN limit", () => {
    equal(core.panLimit(0, 400), 0);
    equal(core.panLimit(1000, 0), 0);
    equal(core.panLimit(NaN, 400), 0);
  });

  test("clampPan holds at both edges and passes the middle through", () => {
    equal(core.clampPan(500, 1000, 400), 300);
    equal(core.clampPan(-500, 1000, 400), -300);
    equal(core.clampPan(100, 1000, 400), 100);
  });

  test("clampPan centres an image that fits, whatever it is handed", () => {
    equal(core.clampPan(250, 200, 400), 0);
    equal(core.clampPan(-250, 200, 400), 0);
  });

  test("clampPan turns nonsense into a centred image, not a NaN transform", () => {
    equal(core.clampPan(NaN, 1000, 400), 0);
    equal(core.clampPan(undefined, 1000, 400), 0);
  });
});

group("zooming about a point", () => {
  test("what is under the cursor stays under the cursor", () => {
    // Cursor 100px right of centre, image at 1x centred. Doubling the zoom
    // moves that image point to 200px, so the pan pulls back by 100.
    equal(core.panAfterZoom(0, 100, 1, 2), -100);
  });

  test("zooming about the centre needs no pan correction", () => {
    equal(core.panAfterZoom(0, 0, 1, 4), 0);
    equal(core.panAfterZoom(50, 0, 1, 2), 100, "an off-centre image still scales about the centre");
  });

  test("zooming in and back out returns the pan where it started", () => {
    const zoomedIn = core.panAfterZoom(30, 120, 1, 2.5);
    close(core.panAfterZoom(zoomedIn, 120, 2.5, 1), 30, 1e-9);
  });

  test("a zero or negative zoom is refused rather than dividing by it", () => {
    equal(core.panAfterZoom(40, 100, 0, 2), 40);
    equal(core.panAfterZoom(40, 100, 1, 0), 40);
    equal(core.panAfterZoom(NaN, 100, 1, 2), 0);
  });
});

group("stepping through siblings", () => {
  const paths = ["a.png", "b.png", "c.png"];

  test("moves one either way", () => {
    equal(core.siblingPath(paths, "b.png", 1), "c.png");
    equal(core.siblingPath(paths, "b.png", -1), "a.png");
  });

  test("stops at the ends rather than wrapping", () => {
    // Wrapping from the last file to the first reads as a jump to somewhere
    // else, and from the keyboard there is no way to tell the two apart.
    equal(core.siblingPath(paths, "c.png", 1), null);
    equal(core.siblingPath(paths, "a.png", -1), null);
  });

  test("with nothing selected, a step starts at the near end", () => {
    equal(core.siblingPath(paths, null, 1), "a.png");
    equal(core.siblingPath(paths, null, -1), "c.png");
  });

  test("an empty list has no siblings", () => {
    equal(core.siblingPath([], "a.png", 1), null);
    equal(core.siblingPath(null, "a.png", 1), null);
  });

  test("a step of zero stays put", () => {
    equal(core.siblingPath(paths, "b.png", 0), "b.png");
  });
});

/* The viewer surface. */

function fakeApp(paths) {
  const files = paths.map((path) => ({ path }));
  const on = () => ({});
  return {
    files,
    vault: {
      getFiles: () => files,
      on,
      version: 0,
      getResourcePath(file) {
        return "app://local/" + file.path + "?v=" + this.version;
      },
    },
    workspace: {
      on,
      getActiveFile: () => null,
      getLeavesOfType() {
        return this.leaves || [];
      },
      onLayoutReady: (fn) => fn(),
    },
    metadataCache: { on },
  };
}

const STAGE = { width: 400, height: 300 };

async function paneOver(paths) {
  dom.clearTimers();
  const app = fakeApp(paths);
  const plugin = new MediaViewerPlugin(app, {});
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  await plugin.onload();

  const view = new MediaViewerView({}, plugin);
  view.contentEl = dom.root.createDiv({ cls: "view-content" });
  app.workspace.leaves = [{ view }];
  await view.onOpen();
  view.stageEl.clientWidth = STAGE.width;
  view.stageEl.clientHeight = STAGE.height;

  plugin.pinFolder("data/assets");
  return { plugin, view, app };
}

// Stands in for a decode finishing: the browser reports the natural size, then
// fires load.
function decode(view, width, height) {
  const img = view.imageEl;
  img.naturalWidth = width;
  img.naturalHeight = height;
  img.fire("load");
  return img;
}

const image = (view) => view.stageEl.querySelector(".mv-image");
const message = (view) => {
  const el = view.stageEl.querySelector(".mv-stage-message");
  return el ? el.textContent : null;
};

const FILES = ["data/assets/a.png", "data/assets/b.png", "data/assets/c.png", "data/assets/d.mp4"];

group("what the stage shows", () => {
  test("nothing selected asks for a selection", async () => {
    const { view } = await paneOver(FILES);
    equal(message(view), "Select a file to view it.");
    equal(image(view), null);
  });

  test("selecting an image loads it from the resource path", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/b.png");
    ok(image(view));
    equal(image(view).src, "app://local/data/assets/b.png?v=0");
    equal(view.viewerNameEl.textContent, "b.png");
  });

  test("a video opens in the video element, not as an image", async () => {
    // What the video viewer then does with it is tests/video.test.js.
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/d.mp4");
    equal(image(view), null);
    ok(view.videoEl, "a video element on the stage");
    equal(view.videoEl.src, "app://local/data/assets/d.mp4?v=0");
  });

  test("an image that will not decode says so, and the pane survives it", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    view.imageEl.fire("error");
    equal(message(view), "This image could not be decoded.");
    ok(view.stageEl.hasClass("is-broken"));
    equal(view.imageEl, null);
    plugin.select("data/assets/b.png");
    ok(image(view), "the next file still loads");
    equal(view.stageEl.hasClass("is-broken"), false);
  });

  test("re-rendering the grid does not reload the image under the user", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    const img = decode(view, 800, 600);
    view.setZoom(3);
    view.render();
    ok(image(view) === img, "same element");
    equal(view.zoom, 3, "and the zoom the user set");
  });
});

group("opening an image", () => {
  test("opens at fit, so a large image arrives whole", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    decode(view, 800, 600);
    // 400/800 = 0.5, 300/600 = 0.5.
    close(view.zoom, 0.5, 1e-9);
    equal(view.panX, 0);
    equal(view.panY, 0);
  });

  test("fits the constraining edge", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    decode(view, 4000, 600);
    close(view.zoom, 0.1, 1e-9, "width is the tighter of the two");
  });

  test("a small image opens at 100%, never magnified to fill the pane", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    decode(view, 100, 80);
    equal(view.zoom, 1);
  });

  test("the zoom readout shows the percentage once something has loaded", async () => {
    const { plugin, view } = await paneOver(FILES);
    equal(view.zoomEl.textContent, "");
    plugin.select("data/assets/a.png");
    decode(view, 800, 600);
    equal(view.zoomEl.textContent, "50%");
  });

  test("the image is sized from its natural size times the zoom", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    decode(view, 800, 600);
    equal(image(view).style.width, "400px");
    equal(image(view).style.height, "300px");
    equal(image(view).style.transform, "translate(0px, 0px)");
  });
});

group("zooming", () => {
  async function openLarge() {
    const pane = await paneOver(FILES);
    pane.plugin.select("data/assets/a.png");
    decode(pane.view, 800, 600);
    return pane;
  }

  test("W zooms in and S zooms back out to where it started", async () => {
    const { view } = await openLarge();
    const start = view.zoom;
    view.handleKey({ key: "w" });
    ok(view.zoom > start);
    view.handleKey({ key: "s" });
    close(view.zoom, start, 1e-12);
  });

  test("the wheel zooms in on scroll up and out on scroll down", async () => {
    const { view } = await openLarge();
    const start = view.zoom;
    view.handleWheel({ deltaY: -100, clientX: 200, clientY: 150 });
    ok(view.zoom > start);
    const zoomedIn = view.zoom;
    view.handleWheel({ deltaY: 100, clientX: 200, clientY: 150 });
    ok(view.zoom < zoomedIn);
  });

  test("the wheel steps finer than the keyboard", async () => {
    const { view } = await openLarge();
    const start = view.zoom;
    view.handleWheel({ deltaY: -100, clientX: 200, clientY: 150 });
    const byWheel = view.zoom / start;
    view.fitToPane();
    view.handleKey({ key: "w" });
    const byKey = view.zoom / start;
    ok(byWheel < byKey, "wheel " + byWheel.toFixed(3) + " vs key " + byKey.toFixed(3));
  });

  test("wheel zoom keeps the point under the cursor in place", async () => {
    const { view } = await openLarge();
    // Cursor 100px right of the stage centre. The stage rect is at the origin,
    // so its centre is (200, 150).
    const cursor = { clientX: 300, clientY: 150 };
    const before = view.zoom;
    const imagePointBefore = (100 - view.panX) / before;
    view.handleWheel(Object.assign({ deltaY: -100 }, cursor));
    const imagePointAfter = (100 - view.panX) / view.zoom;
    close(imagePointAfter, imagePointBefore, 1e-9, "same image coordinate under the cursor");
  });

  test("zoom holds at the limits rather than running away", async () => {
    const { view } = await openLarge();
    for (let n = 0; n < 100; n += 1) view.handleKey({ key: "w" });
    equal(view.zoom, core.ZOOM_MAX);
    for (let n = 0; n < 200; n += 1) view.handleKey({ key: "s" });
    equal(view.zoom, core.ZOOM_MIN);
  });

  test("the wheel is prevented from scrolling the pane instead", async () => {
    const { view } = await openLarge();
    let prevented = false;
    view.handleWheel({ deltaY: -100, clientX: 200, clientY: 150, preventDefault: () => (prevented = true) });
    ok(prevented);
  });

  test("the wheel does nothing before an image has loaded", async () => {
    const { view } = await paneOver(FILES);
    view.handleWheel({ deltaY: -100, clientX: 200, clientY: 150 });
    equal(view.zoom, 1);
  });
});

group("fit and reset", () => {
  async function openLarge() {
    const pane = await paneOver(FILES);
    pane.plugin.select("data/assets/a.png");
    decode(pane.view, 800, 600);
    return pane;
  }

  test("100% goes to actual size and recentres", async () => {
    const { view } = await openLarge();
    view.setZoom(4);
    view.panX = 50;
    view.zoomToActualSize();
    equal(view.zoom, 1);
    equal(view.panX, 0);
    equal(view.panY, 0);
  });

  test("fit goes back to the whole image", async () => {
    const { view } = await openLarge();
    view.zoomToActualSize();
    view.fitToPane();
    close(view.zoom, 0.5, 1e-9);
  });

  test("the F and 0 keys do the same as the buttons", async () => {
    const { view } = await openLarge();
    view.handleKey({ key: "0" });
    equal(view.zoom, 1);
    view.handleKey({ key: "f" });
    close(view.zoom, 0.5, 1e-9);
  });

  test("a double-click toggles between fit and full size", async () => {
    const { view } = await openLarge();
    close(view.zoom, 0.5, 1e-9, "starts at fit");
    view.toggleFit();
    equal(view.zoom, 1, "to full size");
    view.toggleFit();
    close(view.zoom, 0.5, 1e-9, "and back");
  });

  test("for an image that already fits, the toggle magnifies instead of doing nothing", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    decode(view, 100, 80);
    equal(view.zoom, 1, "fit and 100% are the same here");
    view.toggleFit();
    equal(view.zoom, 2);
  });
});

group("panning", () => {
  async function openZoomed() {
    const pane = await paneOver(FILES);
    pane.plugin.select("data/assets/a.png");
    decode(pane.view, 800, 600);
    pane.view.zoomToActualSize(); // 800x600 in a 400x300 stage
    return pane;
  }

  test("dragging moves the image with the pointer", async () => {
    const { view } = await openZoomed();
    view.handlePointerDown({ pointerId: 1, clientX: 200, clientY: 150 });
    view.handlePointerMove({ pointerId: 1, clientX: 260, clientY: 190 });
    equal(view.panX, 60);
    equal(view.panY, 40);
    equal(image(view).style.transform, "translate(60px, 40px)");
  });

  test("the drag cannot pull the image past its own edge", async () => {
    const { view } = await openZoomed();
    view.handlePointerDown({ pointerId: 1, clientX: 200, clientY: 150 });
    view.handlePointerMove({ pointerId: 1, clientX: 5000, clientY: 5000 });
    equal(view.panX, 200, "half the 400px horizontal overhang");
    equal(view.panY, 150, "half the 300px vertical overhang");
  });

  test("releasing ends the drag, and later movement does nothing", async () => {
    const { view } = await openZoomed();
    view.handlePointerDown({ pointerId: 1, clientX: 200, clientY: 150 });
    view.handlePointerMove({ pointerId: 1, clientX: 240, clientY: 150 });
    view.handlePointerUp({ pointerId: 1 });
    view.handlePointerMove({ pointerId: 1, clientX: 400, clientY: 150 });
    equal(view.panX, 40);
    equal(view.stageEl.hasClass("is-panning"), false);
  });

  test("an image that fits cannot be dragged at all", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    decode(view, 100, 80);
    view.handlePointerDown({ pointerId: 1, clientX: 200, clientY: 150 });
    equal(view.dragging, null, "no drag starts, so the cursor never lies about it");
    view.handlePointerMove({ pointerId: 1, clientX: 300, clientY: 150 });
    equal(view.panX, 0);
  });

  test("the pointer is captured, so a drag leaving the pane still ends", async () => {
    const { view } = await openZoomed();
    view.handlePointerDown({ pointerId: 7, clientX: 200, clientY: 150 });
    equal(view.stageEl.capturedPointer, 7);
    view.handlePointerUp({ pointerId: 7 });
    equal(view.stageEl.capturedPointer, null);
  });

  test("a second pointer does not hijack the drag in progress", async () => {
    const { view } = await openZoomed();
    view.handlePointerDown({ pointerId: 1, clientX: 200, clientY: 150 });
    view.handlePointerMove({ pointerId: 2, clientX: 380, clientY: 150 });
    equal(view.panX, 0);
    view.handlePointerUp({ pointerId: 2 });
    ok(view.dragging, "the first drag is still live");
  });

  test("zooming back out pulls the pan back inside the new bounds", async () => {
    const { view } = await openZoomed();
    view.handlePointerDown({ pointerId: 1, clientX: 200, clientY: 150 });
    view.handlePointerMove({ pointerId: 1, clientX: 5000, clientY: 5000 });
    view.handlePointerUp({ pointerId: 1 });
    equal(view.panX, 200);
    view.fitToPane();
    equal(view.panX, 0, "the whole image fits, so it is centred again");
  });

  test("shrinking the pane pulls the pan back inside too", async () => {
    const { view } = await openZoomed();
    view.handlePointerDown({ pointerId: 1, clientX: 200, clientY: 150 });
    view.handlePointerMove({ pointerId: 1, clientX: 5000, clientY: 5000 });
    view.handlePointerUp({ pointerId: 1 });
    view.stageEl.clientWidth = 900;
    view.stageEl.clientHeight = 700;
    view.handleResize();
    equal(view.panX, 0, "the image now fits, so it centres");
  });
});

group("stepping through the folder from the keyboard", () => {
  test("D moves to the next file and A back", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    view.handleKey({ key: "d" });
    equal(plugin.selectedPath, "data/assets/b.png");
    view.handleKey({ key: "a" });
    equal(plugin.selectedPath, "data/assets/a.png");
  });

  test("the viewer follows, and the new file opens at fit", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    decode(view, 800, 600);
    view.setZoom(4);
    view.handleKey({ key: "d" });
    equal(view.viewerPath, "data/assets/b.png");
    equal(view.zoom, 1, "reset, awaiting the new decode");
    equal(image(view).src, "app://local/data/assets/b.png?v=0");
  });

  test("stepping stops at the ends", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    equal(view.handleKey({ key: "a" }), true, "the key is still handled");
    equal(plugin.selectedPath, "data/assets/a.png", "but nothing moved");
    plugin.select("data/assets/d.mp4");
    view.handleKey({ key: "d" });
    equal(plugin.selectedPath, "data/assets/d.mp4");
  });

  test("the bar's buttons are disabled at the ends", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    equal(view.prevEl.disabled, true);
    equal(view.nextEl.disabled, false);
    plugin.select("data/assets/d.mp4");
    equal(view.prevEl.disabled, false);
    equal(view.nextEl.disabled, true);
  });

  test("stepping walks the filtered list, skipping what is not on screen", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.setFilter("image");
    plugin.select("data/assets/c.png");
    view.handleKey({ key: "d" });
    equal(plugin.selectedPath, "data/assets/c.png", "the mp4 is filtered out, so c is the last");
    plugin.setFilter("both");
    view.handleKey({ key: "d" });
    equal(plugin.selectedPath, "data/assets/d.mp4");
  });

  test("stepping with nothing selected starts at the near end", async () => {
    const { plugin, view } = await paneOver(FILES);
    view.handleKey({ key: "d" });
    equal(plugin.selectedPath, "data/assets/a.png");
  });

  test("stepping scrolls the grid to the new tile", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    view.handleKey({ key: "d" });
    ok(view.tiles.get("data/assets/b.png").scrolledIntoView);
  });
});

group("keyboard scope", () => {
  test("a modified press is left for Obsidian", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    equal(view.handleKey({ key: "d", ctrlKey: true }), false);
    equal(view.handleKey({ key: "a", metaKey: true }), false);
    equal(plugin.selectedPath, "data/assets/a.png");
  });

  test("an unrelated key is not swallowed", async () => {
    const { view } = await paneOver(FILES);
    equal(view.handleKey({ key: "q" }), false);
    equal(view.handleKey({ key: "Enter" }), false);
  });

  test("uppercase works, so caps lock and shift do not break navigation", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    view.handleKey({ key: "D" });
    equal(plugin.selectedPath, "data/assets/b.png");
  });

  test("a handled key is prevented from also doing whatever it normally would", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    let prevented = false;
    view.handleKey({ key: "d", preventDefault: () => (prevented = true) });
    ok(prevented);
  });
});

group("the file changing underneath the viewer", () => {
  test("a modify re-reads the image but keeps the zoom and pan", async () => {
    const { plugin, view, app } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    const img = decode(view, 800, 600);
    view.zoomToActualSize();
    view.handlePointerDown({ pointerId: 1, clientX: 200, clientY: 150 });
    view.handlePointerMove({ pointerId: 1, clientX: 260, clientY: 150 });
    view.handlePointerUp({ pointerId: 1 });

    app.vault.version = 1;
    plugin.index.handleModify({ path: "data/assets/a.png" });

    ok(view.imageEl === img, "same element");
    equal(img.src, "app://local/data/assets/a.png?v=1", "fresh pixels");
    equal(view.zoom, 1);
    equal(view.panX, 60, "the user is still looking at the same part of it");
  });

  test("a modify to some other file leaves the viewer alone", async () => {
    const { plugin, view, app } = await paneOver(FILES);
    plugin.select("data/assets/a.png");
    decode(view, 800, 600);
    app.vault.version = 1;
    plugin.index.handleModify({ path: "data/assets/b.png" });
    equal(view.imageEl.src, "app://local/data/assets/a.png?v=0");
  });

  test("deleting the viewed file moves the viewer to its neighbour", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/b.png");
    plugin.index.handleDelete({ path: "data/assets/b.png" });
    equal(view.viewerPath, "data/assets/c.png");
    equal(image(view).src, "app://local/data/assets/c.png?v=0");
  });

  test("renaming the viewed file keeps it in the viewer", async () => {
    const { plugin, view } = await paneOver(FILES);
    plugin.select("data/assets/b.png");
    plugin.index.handleRename({ path: "data/assets/hero.png" }, "data/assets/b.png");
    equal(view.viewerPath, "data/assets/hero.png");
  });

  test("changing folder empties the viewer", async () => {
    const { plugin, view } = await paneOver(FILES.concat(["other/x.png"]));
    plugin.select("data/assets/a.png");
    plugin.pinFolder("other");
    equal(view.viewerPath, null);
    equal(message(view), "Select a file to view it.");
  });
});

report("viewer");
