/* ExportRunner — a plan turned into files, and files turned into records.
 *
 * Driven against a fake ffmpeg and a fake filesystem, because what matters here
 * is the orchestration: how many passes a multi-clip export takes, what the
 * concat list says, that temp files are cleared even when a run fails, and that
 * two notes come out of one cut.
 */
require("./stub-dom.js").installDom();
const { ExportRunner, LineageStore, CancelledError, core } = require("./load-plugin.js");
const { createFakeApp } = require("./fake-vault.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

const nodePath = { join: (...parts) => parts.join("/"), sep: "/" };

/* A filesystem that remembers what it was asked to do and nothing else.
   ffmpeg's outputs never really appear, which is exactly the situation the
   vault-settle wait exists for. */
function fakeFs() {
  const written = new Map();
  const dirs = [];
  const removed = [];
  return {
    written,
    dirs,
    removed,
    mkdtempSync(prefix) {
      const dir = prefix + String(dirs.length);
      dirs.push(dir);
      return dir;
    },
    writeFileSync(path, text) {
      written.set(path, text);
    },
    rmSync(path) {
      removed.push(path);
    },
  };
}

/* An ffmpeg that succeeds instantly and records every argument list, so a test
   can count the passes and read what each one was asked to do.
 *
 * It also puts its output into the fake vault, because that is what really
 * happens: ffmpeg writes to the disk under the vault folder and Obsidian's
 * watcher notices. Without that the records have nothing to point at, which
 * would make the lineage assertions pass or fail for the wrong reason. */
function fakeRunner(options) {
  const settings = options || {};
  const runs = [];
  return {
    runs,
    available: true,
    async run(which, args, opts) {
      runs.push({ which, args });
      const output = args[args.length - 1];
      if (settings.onOutput && typeof output === "string" && output.startsWith("/vault/")) {
        settings.onOutput(output.slice("/vault/".length));
      }
      if (settings.failOn && settings.failOn(runs.length, args)) {
        throw new Error(settings.failMessage || "ffmpeg exited 1: Invalid data");
      }
      if (opts && typeof opts.onProgress === "function") {
        opts.onProgress({ seconds: 1, speed: 4, done: true });
      }
      return { stdout: "", stderr: "", stdoutBuffer: null };
    },
  };
}

function makeExporter(options) {
  const settings = options || {};
  const vault = createFakeApp({ basePath: "/vault" });
  for (const path of settings.files || []) vault.addFile(path);
  const store = new LineageStore(vault.app, { noteFolder: "data/media" });
  store.build();
  const runner = fakeRunner(
    Object.assign({ onOutput: (path) => vault.addFile(path) }, settings.runner)
  );
  const fs = fakeFs();
  const progress = [];
  const exporter = new ExportRunner({
    app: vault.app,
    runner,
    store,
    fs,
    os: { tmpdir: () => "/tmp" },
    nodePath,
    getSettings: () => Object.assign({}, core.DEFAULT_SETTINGS, settings.settings || {}),
    onProgress: (update) => progress.push(update),
  });
  // The vault-settle wait is 20 seconds of polling for a file the fake ffmpeg
  // never writes. Tests that do not care about it say so.
  if (!settings.wait) exporter.waitForVaultFile = async (path) => vault.app.vault.getAbstractFileByPath(path);
  return { vault, store, runner, fs, exporter, progress };
}

group("absolute paths", () => {
  test("ffmpeg is given a real path, because it has never heard of a vault", () => {
    const { exporter } = makeExporter();
    equal(exporter.absolute("data/media/walk.mp4"), "/vault/data/media/walk.mp4");
  });

  test("a vault that is not on a disk says so rather than handing over a bad path", () => {
    const { exporter } = makeExporter();
    exporter.basePath = () => null;
    let message = "";
    try {
      exporter.absolute("a.mp4");
    } catch (error) {
      message = error.message;
    }
    ok(message.includes("not on a local filesystem"));
  });
});

group("one trim", () => {
  test("is a single pass, with the source and the span it was given", async () => {
    const { exporter, runner } = makeExporter({ files: ["data/walk.mp4"] });
    const result = await exporter.trim("data/walk.mp4", { start: 718, end: 800.5 });
    equal(runner.runs.length, 1);
    const args = runner.runs[0].args;
    equal(args[args.indexOf("-ss") + 1], "718");
    equal(args[args.indexOf("-i") + 1], "/vault/data/walk.mp4");
    close(Number(args[args.indexOf("-t") + 1]), 82.5, 1e-6);
    ok(result.path.startsWith("data/walk+trim+"));
  });

  test("keeps the source's container on a copy and takes mp4 on a re-encode", async () => {
    const copy = makeExporter({ files: ["data/walk.mkv"] });
    equal(core.extensionOf((await copy.exporter.trim("data/walk.mkv", { start: 0, end: 5 })).path), "mkv");
    const encode = makeExporter({ files: ["data/walk.mkv"], settings: { mode: core.MODE_ENCODE } });
    equal(core.extensionOf((await encode.exporter.trim("data/walk.mkv", { start: 0, end: 5 })).path), "mp4");
  });

  test("writes to the output folder when one is set", async () => {
    const { exporter } = makeExporter({ files: ["data/walk.mp4"], settings: { outputFolder: "data/cuts" } });
    const result = await exporter.trim("data/walk.mp4", { start: 0, end: 5 });
    equal(core.folderOf(result.path), "data/cuts");
  });
});

group("what a trim records", () => {
  test("two notes: one for the clip, one for the video it came from", async () => {
    // Without the root, `source:` on the child dangles the moment anyone looks.
    const { exporter, store, vault } = makeExporter({ files: ["data/walk.mp4"] });
    const result = await exporter.trim("data/walk.mp4", { start: 718, end: 800.5 });
    equal(store.isTracked("data/walk.mp4"), true, "the source has a root note");
    equal(store.isTracked(result.path), true, "and the clip has its own");
  });

  test("the clip's note names the video and the seconds it covers", async () => {
    const { exporter, store, vault } = makeExporter({ files: ["data/walk.mp4"] });
    const result = await exporter.trim("data/walk.mp4", { start: 718, end: 800.5 });
    const note = store.byMedia.get(result.path);
    const text = vault.textAt(note);
    ok(text.includes('source: "[[data/walk.mp4]]"'), "names its video");
    ok(text.includes("sourceStart: 718"), "and the second it starts at");
    ok(text.includes("sourceEnd: 800.5"));
    ok(text.includes("op: trim"));
  });

  test("an existing record for the source is left alone", async () => {
    const { exporter, store, vault } = makeExporter();
    vault.addFile("data/walk.mp4");
    vault.addNote("data/media/walk.md", {
      implements: "MediaInstance",
      media: "[[data/walk.mp4]]",
      useCase: "Checkout",
    });
    store.build();
    await exporter.trim("data/walk.mp4", { start: 0, end: 5 });
    const modified = vault.log.filter((entry) => entry.path === "data/media/walk.md");
    equal(modified.length, 0, "the user's record is theirs");
  });
});

group("an export of several clips", () => {
  const clips = [
    { id: "a", path: "data/walk.mp4", start: 10, end: 40 },
    { id: "b", path: "data/walk.mp4", start: 100, end: 130 },
  ];

  test("is one pass per clip plus one join", async () => {
    const { exporter, runner } = makeExporter({ files: ["data/walk.mp4"] });
    await exporter.exportClips(clips);
    equal(runner.runs.length, 3);
    ok(runner.runs[2].args.includes("concat"), "the last pass is the join");
  });

  test("the join is a copy, because the pieces already match each other", async () => {
    // They were produced by the pass above, so re-encoding them again would be
    // a second generation loss for nothing.
    const { exporter, runner } = makeExporter({
      files: ["data/walk.mp4"],
      settings: { mode: core.MODE_ENCODE },
    });
    await exporter.exportClips(clips);
    ok(runner.runs[2].args.join(" ").includes("-c copy"));
  });

  test("the list names the temp files it just wrote, in order", async () => {
    const { exporter, fs } = makeExporter({ files: ["data/walk.mp4"] });
    await exporter.exportClips(clips);
    const list = Array.from(fs.written.values())[0];
    deepEqual(list.split("\n").filter(Boolean), [
      "file '/tmp/obsidian-video-editor-0/ve-seg-000.mp4'",
      "file '/tmp/obsidian-video-editor-0/ve-seg-001.mp4'",
    ]);
  });

  test("temp files are cleared afterwards", async () => {
    const { exporter, fs } = makeExporter({ files: ["data/walk.mp4"] });
    await exporter.exportClips(clips);
    deepEqual(fs.removed, ["/tmp/obsidian-video-editor-0"]);
  });

  test("and cleared even when a pass fails", async () => {
    const { exporter, fs } = makeExporter({
      files: ["data/walk.mp4"],
      runner: { failOn: (n) => n === 2 },
    });
    try {
      await exporter.exportClips(clips);
    } catch (error) {
      /* expected */
    }
    deepEqual(fs.removed, ["/tmp/obsidian-video-editor-0"], "a failed export does not leave gigabytes in the temp folder");
  });

  test("one clip needs no temp files and no join at all", async () => {
    const { exporter, runner, fs } = makeExporter({ files: ["data/walk.mp4"] });
    await exporter.exportClips([clips[0]]);
    equal(runner.runs.length, 1);
    equal(fs.dirs.length, 0);
  });

  test("progress is reported for every pass", async () => {
    const { exporter, progress } = makeExporter({ files: ["data/walk.mp4"] });
    await exporter.exportClips(clips);
    equal(progress.length, 3);
    ok(progress[0].label.includes("Clip 1 of 2"));
    ok(progress[2].label.includes("Joining"));
  });

  test("an empty list is refused before a process is spawned", async () => {
    const { exporter, runner } = makeExporter();
    let message = "";
    try {
      await exporter.exportClips([]);
    } catch (error) {
      message = error.message;
    }
    ok(message.includes("no clips"));
    equal(runner.runs.length, 0);
  });
});

group("what an export records", () => {
  test("names its first parent and lists the whole recipe", async () => {
    const { exporter, store, vault } = makeExporter({ files: ["data/walk.mp4", "data/login.mp4"] });
    const result = await exporter.exportClips([
      { path: "data/walk.mp4", start: 718, end: 800.5 },
      { path: "data/login.mp4", start: 31, end: 53.4 },
    ]);
    const text = vault.textAt(store.byMedia.get(result.path));
    ok(text.includes('source: "[[data/walk.mp4]]"'));
    ok(text.includes("op: cut"));
    ok(text.includes("data/walk.mp4 00:11:58.000-00:13:20.500"));
    ok(text.includes("data/login.mp4 00:00:31.000-00:00:53.400"));
  });
});

group("mixed sources", () => {
  const mixed = [
    { path: "data/walk.mp4", start: 0, end: 10 },
    { path: "data/login.mkv", start: 0, end: 10 },
  ];

  test("each piece is trimmed into its own container, so the copies cannot fail", async () => {
    const { exporter, fs } = makeExporter({ files: ["data/walk.mp4", "data/login.mkv"] });
    try {
      await exporter.exportClips(mixed);
    } catch (error) {
      /* the join may still fail; the trims are the point here */
    }
    const list = Array.from(fs.written.values())[0];
    ok(list.includes("ve-seg-000.mp4"));
    ok(list.includes("ve-seg-001.mkv"));
  });

  test("a copy-join that fails says which setting fixes it", async () => {
    // ffmpeg's own message is in codec terms and does not name the fix.
    const { exporter } = makeExporter({
      files: ["data/walk.mp4", "data/login.mkv"],
      runner: { failOn: (n, args) => args.includes("concat") },
    });
    let message = "";
    try {
      await exporter.exportClips(mixed);
    } catch (error) {
      message = error.message;
    }
    ok(message.includes("2 different files"));
    ok(message.includes("Re-encode"));
  });

  test("a clip that fails to trim is not answered with advice about joining", async () => {
    // The advice is about the join. Attaching it to any failure in the export
    // would send someone to re-encode over a file that is simply unreadable.
    const { exporter } = makeExporter({
      files: ["data/walk.mp4", "data/login.mkv"],
      runner: { failOn: (n, args) => !args.includes("concat") },
    });
    let message = "";
    try {
      await exporter.exportClips(mixed);
    } catch (error) {
      message = error.message;
    }
    equal(message.includes("Re-encode"), false);
    ok(message.includes("Invalid data"), "ffmpeg's own reason came through");
  });

  test("the same failure while re-encoding is left as ffmpeg wrote it", async () => {
    const { exporter } = makeExporter({
      files: ["data/walk.mp4", "data/login.mkv"],
      settings: { mode: core.MODE_ENCODE },
      runner: { failOn: (n, args) => args.includes("concat") },
    });
    let message = "";
    try {
      await exporter.exportClips(mixed);
    } catch (error) {
      message = error.message;
    }
    equal(message.includes("Re-encode"), false, "advice that would not help is not given");
  });
});

group("cancelling", () => {
  test("stops between passes rather than running the rest", async () => {
    const signal = { cancelled: false };
    const { exporter, runner } = makeExporter({
      files: ["data/walk.mp4"],
      runner: {
        failOn: () => {
          signal.cancelled = true;
          return false;
        },
      },
    });
    let caught = null;
    try {
      await exporter.exportClips(
        [
          { path: "data/walk.mp4", start: 0, end: 10 },
          { path: "data/walk.mp4", start: 20, end: 30 },
        ],
        { signal }
      );
    } catch (error) {
      caught = error;
    }
    ok(caught instanceof CancelledError);
    equal(runner.runs.length, 1, "the second clip was never started");
  });
});

group("audio", () => {
  test("drops the video, changes the container, and records the span", async () => {
    const { exporter, runner, store, vault } = makeExporter({ files: ["data/walk.mp4"] });
    const result = await exporter.extractAudio("data/walk.mp4", { start: 10, end: 70 });
    ok(runner.runs[0].args.includes("-vn"));
    equal(core.extensionOf(result.path), "m4a");
    const text = vault.textAt(store.byMedia.get(result.path));
    ok(text.includes("op: audio"));
    ok(text.includes("sourceStart: 10"));
  });
});

group("when the vault has not caught up", () => {
  test("the export still succeeds and simply cannot hand back a file", async () => {
    // ffmpeg wrote it; Obsidian's watcher will notice. Failing the export over
    // a watcher's timing would be failing over nothing.
    const { exporter } = makeExporter({ files: ["data/walk.mp4"] });
    exporter.waitForVaultFile = async () => null;
    const result = await exporter.trim("data/walk.mp4", { start: 0, end: 5 });
    ok(result.path, "a path came back");
    equal(result.file, null, "but nothing to select yet");
  });
});

report("video-editor export");
