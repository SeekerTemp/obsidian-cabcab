/* MediaInstance records.
 *
 * The point of the plugin, in note form: a clip that cannot name its video and
 * the seconds it covers has failed at the main job. The rule under test
 * throughout is that a note is found by the `media:` link it declares, never
 * by its filename.
 */
require("./stub-dom.js").installDom();
const { LineageStore, core } = require("./load-plugin.js");
const { createFakeApp } = require("./fake-vault.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

function storeWith(build) {
  const vault = createFakeApp();
  if (build) build(vault);
  const store = new LineageStore(vault.app, { noteFolder: "data/media" });
  store.build();
  return { vault, store };
}

group("rendering a record", () => {
  test("writes the fields in a fixed order", () => {
    // So that rewriting an unchanged record produces an unchanged file, and a
    // diff shows only what actually moved.
    const text = core.renderInstanceNote(
      { media: "[[a/walk+trim.mp4]]", source: "[[a/walk.mp4]]", op: "trim", sourceStart: 10, sourceEnd: 40 },
      ""
    );
    const keys = text
      .split("\n")
      .filter((line) => /^[a-zA-Z]+:/.test(line))
      .map((line) => line.slice(0, line.indexOf(":")));
    deepEqual(keys, ["implements", "media", "source", "op", "sourceStart", "sourceEnd"]);
  });

  test("a wikilink is quoted, because unquoted it reads as a YAML list", () => {
    ok(core.renderInstanceNote({ media: "[[a/walk.mp4]]" }, "").includes('media: "[[a/walk.mp4]]"'));
  });

  test("absent fields are omitted, never written empty", () => {
    // A blank `source:` on a root would claim a parent nobody can find.
    const text = core.renderInstanceNote({ media: "[[a/walk.mp4]]", source: null }, "");
    equal(text.includes("source:"), false);
  });

  test("keeps a field it does not know about", () => {
    const text = core.renderInstanceNote({ media: "[[a.mp4]]", reviewer: "sam" }, "");
    ok(text.includes("reviewer: sam"), "someone else's field is not ours to drop");
  });

  test("carries the clip recipe as a list", () => {
    const text = core.renderInstanceNote({ media: "[[a.mp4]]", clips: ["a.mp4 00:00:10.000-00:00:40.000"] }, "");
    ok(text.includes('clips: ["a.mp4 00:00:10.000-00:00:40.000"]'));
  });
});

group("the notes marker", () => {
  test("prose below it survives a rewrite", () => {
    const original = core.renderInstanceNote({ media: "[[a.mp4]]" }, "The moment the payment fails.\n");
    const body = core.notesBodyOf(original);
    equal(body, "The moment the payment fails.\n");
    const rewritten = core.renderInstanceNote({ media: "[[a.mp4]]", op: "trim" }, body);
    ok(rewritten.includes("The moment the payment fails."));
  });

  test("a note without a marker yet has an empty body, not a broken one", () => {
    equal(core.notesBodyOf("---\nimplements: MediaInstance\n---\n"), "");
  });

  test("uses Media Viewer's marker, so a note edited in either keeps its prose", () => {
    equal(core.NOTES_MARKER, "<!-- media-viewer:notes -->");
  });
});

group("reading a record", () => {
  test("pulls the trim's span back out", () => {
    const record = core.instanceRecordFrom(
      { media: "[[a/walk+trim.mp4]]", source: "[[a/walk.mp4]]", op: "trim", sourceStart: 10.5, sourceEnd: 40.25 },
      "data/media/walk+trim.md"
    );
    equal(record.mediaLink, "a/walk+trim.mp4");
    equal(record.sourceLink, "a/walk.mp4");
    equal(record.op, "trim");
    close(record.sourceStart, 10.5, 1e-9);
    close(record.sourceEnd, 40.25, 1e-9);
  });

  test("an alias or a heading is display, not identity", () => {
    equal(core.linkTargetOf("[[a/walk.mp4|the walkthrough]]"), "a/walk.mp4");
    equal(core.linkTargetOf("[[a/walk.mp4#top]]"), "a/walk.mp4");
    equal(core.linkTargetOf("a/walk.mp4"), "a/walk.mp4", "a bare path meant the path");
  });

  test("a field Obsidian parsed into a Date comes back as the string that was written", () => {
    const record = core.instanceRecordFrom({ created: new Date("2026-09-09T10:00:00.000Z") }, "n.md");
    equal(record.created, "2026-09-09T10:00:00Z");
  });

  test("a zero is a value; an empty string is not", () => {
    equal(core.instanceRecordFrom({ sourceStart: 0 }, "n.md").sourceStart, 0);
    equal(core.instanceRecordFrom({ sourceStart: "" }, "n.md").sourceStart, null);
  });
});

group("what a trim records", () => {
  test("names the source and the seconds it covers", () => {
    const fields = core.trimFields({
      sourcePath: "data/walk.mp4",
      start: 718.2504,
      end: 800.5,
      width: 1920,
      height: 1080,
    });
    equal(fields.source, "[[data/walk.mp4]]");
    equal(fields.op, "trim");
    close(fields.sourceStart, 718.25, 1e-9, "rounded to the millisecond it was cut at");
    close(fields.sourceEnd, 800.5, 1e-9);
    equal(fields.width, 1920);
    equal(fields.status, core.STATUS_EDITED);
  });
});

group("what an export records", () => {
  const clips = [
    { path: "data/walk.mp4", start: 718, end: 800.5 },
    { path: "data/login.mp4", start: 31, end: 53.4 },
  ];

  test("a join names its first parent and lists all of them", () => {
    // `source:` holds exactly one file, and a concatenation has more than one,
    // so the chain resolves through the first and `clips:` says the rest.
    const fields = core.cutFields({ clips });
    equal(fields.source, "[[data/walk.mp4]]");
    equal(fields.op, "cut");
    deepEqual(fields.clips, [
      "data/walk.mp4 00:11:58.000-00:13:20.500",
      "data/login.mp4 00:00:31.000-00:00:53.400",
    ]);
  });

  test("a one-clip export says where it came from the way a trim does", () => {
    const fields = core.cutFields({ clips: [clips[0]] });
    close(fields.sourceStart, 718, 1e-9);
    close(fields.sourceEnd, 800.5, 1e-9);
  });

  test("a multi-clip export declares no single span, because it has none", () => {
    equal(core.cutFields({ clips }).sourceStart, undefined);
  });

  test("the recipe is readable without this plugin", () => {
    deepEqual(core.clipRecipeLines([{ path: "a/b.mp4", start: 5, end: 65.25 }]), [
      "a/b.mp4 00:00:05.000-00:01:05.250",
    ]);
  });
});

group("inheritance", () => {
  test("a span is intrinsic, so a child never claims a second it did not start at", () => {
    // The same reason a crop rectangle is intrinsic in Media Viewer.
    ok(core.isIntrinsicField("sourceStart"));
    ok(core.isIntrinsicField("sourceEnd"));
    ok(core.isIntrinsicField("clips"));
  });

  test("what the evidence is about still inherits", () => {
    equal(core.isIntrinsicField("useCase"), false);
    equal(core.isIntrinsicField("shows"), false);
    equal(core.isIntrinsicField("labels"), false);
  });
});

group("finding a note", () => {
  test("by what it declares, not by where it sits or what it is called", () => {
    const { store } = storeWith((vault) => {
      vault.addFile("data/media/walk.mp4");
      // Deliberately somewhere else, and deliberately misnamed.
      vault.addNote("archive/notes/some-other-name.md", {
        implements: "MediaInstance",
        media: "[[data/media/walk.mp4]]",
      });
    });
    equal(store.isTracked("data/media/walk.mp4"), true);
    equal(store.recordFor("data/media/walk.mp4").notePath, "archive/notes/some-other-name.md");
  });

  test("a note for a different schema is not ours", () => {
    const { store } = storeWith((vault) => {
      vault.addFile("data/media/walk.mp4");
      vault.addNote("data/media/walk.md", { implements: "Something", media: "[[data/media/walk.mp4]]" });
    });
    equal(store.isTracked("data/media/walk.mp4"), false);
  });

  test("two notes claiming one file: the first wins and the second is reported", () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      const { store } = storeWith((vault) => {
        vault.addFile("a/walk.mp4");
        vault.addNote("data/media/one.md", { implements: "MediaInstance", media: "[[a/walk.mp4]]" });
        vault.addNote("data/media/two.md", { implements: "MediaInstance", media: "[[a/walk.mp4]]" });
      });
      equal(store.recordFor("a/walk.mp4").notePath, "data/media/one.md");
      ok(warnings.some((line) => line.includes("claimed by two notes")));
    } finally {
      console.warn = originalWarn;
    }
  });
});

group("writing a note", () => {
  test("creates one, in the record folder", async () => {
    const { vault, store } = storeWith((v) => v.addFile("data/media/walk+trim.mp4"));
    const file = await store.write("data/media/walk+trim.mp4", core.trimFields({
      sourcePath: "data/media/walk.mp4",
      start: 10,
      end: 40,
    }));
    equal(file.path, "data/media/walk+trim.md");
    const text = vault.textAt(file.path);
    ok(text.includes('media: "[[data/media/walk+trim.mp4]]"'));
    ok(text.includes('source: "[[data/media/walk.mp4]]"'));
    ok(text.includes("op: trim"));
  });

  test("a written note is findable immediately, not after the cache catches up", async () => {
    // An export writes the root note and the output's note in the same breath,
    // and the second must not be told the first does not exist.
    const { store } = storeWith((v) => v.addFile("a/out.mp4"));
    await store.write("a/out.mp4", { op: "trim" });
    equal(store.isTracked("a/out.mp4"), true);
  });

  test("updating keeps the prose and the fields the caller did not name", async () => {
    const { vault, store } = storeWith((v) => {
      v.addFile("a/walk.mp4");
      v.addNote(
        "data/media/walk.md",
        { implements: "MediaInstance", media: "[[a/walk.mp4]]", useCase: "Checkout", reviewer: "sam" },
        core.renderInstanceNote(
          { media: "[[a/walk.mp4]]", useCase: "Checkout", reviewer: "sam" },
          "Why this matters.\n"
        )
      );
    });
    store.build();
    await store.write("a/walk.mp4", { op: "trim" });
    const text = vault.textAt("data/media/walk.md");
    ok(text.includes("Why this matters."), "the prose survived");
    ok(text.includes("useCase: Checkout"), "a known field survived");
    ok(text.includes("reviewer: sam"), "an unknown field survived");
    ok(text.includes("op: trim"), "and the new field landed");
  });

  test("a name that is taken gets a suffix rather than an overwrite", async () => {
    const { store } = storeWith((v) => {
      v.addFile("a/walk.mp4");
      v.addFile("data/media/walk.md");
    });
    const file = await store.write("a/walk.mp4", { op: "trim" });
    equal(file.path, "data/media/walk-2.md");
  });
});

group("a root for the chain", () => {
  test("is written when the source has none", async () => {
    const { store } = storeWith((v) => v.addFile("data/media/walk.mp4"));
    await store.ensureRoot("data/media/walk.mp4", { status: "edited" });
    equal(store.isTracked("data/media/walk.mp4"), true);
    equal(store.recordFor("data/media/walk.mp4").sourceLink, null, "a root declares no source");
  });

  test("an existing record is the user's, and a trim is no reason to rewrite it", async () => {
    const { vault, store } = storeWith((v) => {
      v.addFile("a/walk.mp4");
      v.addNote("data/media/walk.md", { implements: "MediaInstance", media: "[[a/walk.mp4]]", useCase: "Checkout" });
    });
    const before = vault.log.length;
    await store.ensureRoot("a/walk.mp4", { status: "edited" });
    equal(vault.log.length, before, "nothing was written");
  });
});

group("files that move", () => {
  test("a note renamed by hand keeps its pairing", () => {
    const { vault, store } = storeWith((v) => {
      v.addFile("a/walk.mp4");
      v.addNote("data/media/walk.md", { implements: "MediaInstance", media: "[[a/walk.mp4]]" });
    });
    const moved = vault.addFile("elsewhere/renamed.md");
    store.handleRename(moved, "data/media/walk.md");
    equal(store.recordFor("a/walk.mp4").notePath, "elsewhere/renamed.md");
  });

  test("a deleted note stops being tracked", () => {
    const { vault, store } = storeWith((v) => {
      v.addFile("a/walk.mp4");
      v.addNote("data/media/walk.md", { implements: "MediaInstance", media: "[[a/walk.mp4]]" });
    });
    store.handleDelete(vault.files.get("data/media/walk.md"));
    equal(store.isTracked("a/walk.mp4"), false);
  });

  test("re-reading a note is idempotent, not additive", () => {
    const { vault, store } = storeWith((v) => {
      v.addFile("a/walk.mp4");
      v.addNote("data/media/walk.md", { implements: "MediaInstance", media: "[[a/walk.mp4]]" });
    });
    const file = vault.files.get("data/media/walk.md");
    const front = vault.frontmatterAt("data/media/walk.md");
    store.handleMetadataChange(file, null, { frontmatter: front });
    store.handleMetadataChange(file, null, { frontmatter: front });
    equal(store.records.size, 1);
  });
});

report("video-editor lineage");
