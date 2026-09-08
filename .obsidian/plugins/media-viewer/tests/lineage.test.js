// Tests for LineageStore: reading and writing MediaInstance records, and
// finding them through metadataCache rather than through their names.
//
//   node tests/lineage.test.js
const { installDom } = require("./stub-dom.js");
installDom();

const { core, LineageStore } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

/* A vault that holds files and a metadata cache that holds their frontmatter.
 *
 * getFirstLinkpathDest is the piece that matters: it is what Obsidian uses for
 * its own links, so the stub resolves a bare name against every file's
 * basename the way the real one does, and a link to a file that is not there
 * comes back null — the dangling case, which is a normal one.
 */
function fakeVault(entries) {
  const files = new Map();
  const cache = new Map();
  const written = [];
  for (const entry of entries || []) addFile(entry);

  function addFile(entry) {
    const file = { path: entry.path, basename: core.stemOf(entry.path), extension: core.extensionOf(entry.path) };
    files.set(entry.path, file);
    if (entry.frontmatter) cache.set(entry.path, { frontmatter: entry.frontmatter });
    if (entry.body !== undefined) file.body = entry.body;
    return file;
  }

  const app = {
    files,
    written,
    addFile,
    vault: {
      getAbstractFileByPath: (path) => files.get(path) || null,
      getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === "md"),
      async read(file) {
        return file.body === undefined ? "" : file.body;
      },
      async modify(file, text) {
        file.body = text;
        written.push({ path: file.path, text, kind: "modify" });
        return file;
      },
      async create(path, text) {
        if (files.has(path)) throw new Error("already exists: " + path);
        const file = addFile({ path, body: text });
        written.push({ path, text, kind: "create" });
        return file;
      },
      async createFolder(path) {
        addFile({ path });
      },
    },
    metadataCache: {
      on: () => ({}),
      getFileCache: (file) => cache.get(file.path) || null,
      setFrontmatter(path, frontmatter) {
        cache.set(path, { frontmatter });
      },
      // Nearest match by full path first, then by basename with extension,
      // then by basename alone — the order the real resolver works in.
      getFirstLinkpathDest(link, fromPath) {
        if (files.has(link)) return files.get(link);
        for (const file of files.values()) {
          if (core.baseNameOf(file.path) === link) return file;
        }
        for (const file of files.values()) {
          if (file.basename === link) return file;
        }
        return null;
      },
    },
  };
  return app;
}

const instance = (path, frontmatter, body) => ({
  path,
  frontmatter: Object.assign({ implements: "MediaInstance" }, frontmatter),
  body,
});

group("wikilinks", () => {
  test("a link is read down to its target", () => {
    equal(core.linkTargetOf("[[cover.png]]"), "cover.png");
    equal(core.linkTargetOf("[[data/assets/cover.png]]"), "data/assets/cover.png");
    equal(core.linkTargetOf("[[cover.png|the cover]]"), "cover.png");
    equal(core.linkTargetOf("[[note#heading]]"), "note");
  });

  test("a bare path is taken as itself, not refused", () => {
    equal(core.linkTargetOf("cover.png"), "cover.png");
  });

  test("an array is read from its first entry, which is how Obsidian hands one back", () => {
    equal(core.linkTargetOf(["[[cover.png]]"]), "cover.png");
  });

  test("nothing is nothing", () => {
    equal(core.linkTargetOf(null), null);
    equal(core.linkTargetOf(""), null);
    equal(core.linkTargetOf("   "), null);
    equal(core.linkTargetOf("[[]]"), null);
  });

  test("a link is written round the path", () => {
    equal(core.wikilinkFor("data/assets/cover.png"), "[[data/assets/cover.png]]");
    equal(core.wikilinkFor(""), "");
  });
});

group("rendering a note", () => {
  const FIELDS = {
    media: "[[cover+clone+260908110422.png]]",
    source: "[[cover.png]]",
    op: "crop",
    crop: { x: 120, y: 40, w: 800, h: 600 },
    transform: { rotate: 0, flipH: false, flipV: false },
    width: 800,
    height: 600,
    created: "2026-09-08T11:04:22Z",
    status: "edited",
    labels: [],
  };

  test("it looks like the schema note says it should", () => {
    const text = core.renderInstanceNote(FIELDS, "");
    const lines = text.split("\n");
    deepEqual(lines.slice(0, 13), [
      "---",
      "implements: MediaInstance",
      'media: "[[cover+clone+260908110422.png]]"',
      'source: "[[cover.png]]"',
      "op: crop",
      "crop: { x: 120, y: 40, w: 800, h: 600 }",
      "transform: { rotate: 0, flipH: false, flipV: false }",
      "width: 800",
      "height: 600",
      "created: 2026-09-08T11:04:22Z",
      "status: edited",
      "labels: []",
      "---",
    ]);
    ok(text.includes(core.NOTES_MARKER));
  });

  test("a root declares no source rather than an empty one", () => {
    const text = core.renderInstanceNote({ media: "[[cover.png]]", status: "reviewed" }, "");
    ok(!text.includes("source:"), text);
    ok(!text.includes("crop:"), "and no crop it does not have");
  });

  test("the field order is fixed, so an unchanged record rewrites unchanged", () => {
    const shuffled = {};
    for (const key of [...core.INSTANCE_FIELD_ORDER].reverse()) shuffled[key] = FIELDS[key];
    equal(core.renderInstanceNote(shuffled, ""), core.renderInstanceNote(FIELDS, ""));
  });

  test("a field nobody here knows about is kept, after the ones we do", () => {
    const text = core.renderInstanceNote(Object.assign({ photographer: "Ada" }, FIELDS), "");
    const lines = text.split("\n");
    ok(lines.includes("photographer: Ada"), text);
    ok(lines.indexOf("photographer: Ada") > lines.indexOf("labels: []"), "after the known ones");
  });

  test("values that would parse as something else are quoted", () => {
    equal(core.yamlScalar("yes"), '"yes"');
    equal(core.yamlScalar("12:30"), '"12:30"');
    equal(core.yamlScalar("[[link]]"), '"[[link]]"');
    equal(core.yamlScalar(""), '""');
    equal(core.yamlScalar("plain text"), "plain text");
    equal(core.yamlScalar(true), "true");
    equal(core.yamlScalar(42), "42");
  });

  test("labels come out as a list", () => {
    ok(core.renderInstanceNote({ media: "[[a.png]]", labels: ["hero", "wide"] }, "").includes('labels: [hero, wide]'));
  });
});

group("the notes marker", () => {
  test("everything below it is the user's", () => {
    const raw = "---\nimplements: MediaInstance\n---\n\n" + core.NOTES_MARKER + "\n\nMy own notes.\n";
    equal(core.notesBodyOf(raw), "\nMy own notes.\n");
  });

  test("a note with no marker yet has no body, which is what a new one has", () => {
    equal(core.notesBodyOf("---\nimplements: MediaInstance\n---\n"), "");
    equal(core.notesBodyOf(""), "");
  });

  test("a rewrite carries the body across untouched", () => {
    const first = core.renderInstanceNote({ media: "[[a.png]]" }, "");
    const edited = first + "\nSomething I wrote.\n";
    const second = core.renderInstanceNote({ media: "[[a.png]]", status: "reviewed" }, core.notesBodyOf(edited));
    ok(second.includes("Something I wrote."), second);
    ok(second.includes("status: reviewed"));
  });
});

group("reading a record", () => {
  test("the fields come back typed", () => {
    const record = core.instanceRecordFrom(
      {
        implements: "MediaInstance",
        media: "[[a+clone+1.png]]",
        source: "[[a.png]]",
        op: "crop",
        crop: { x: 1, y: 2, w: 3, h: 4 },
        transform: { rotate: 90, flipH: true, flipV: false },
        width: 3,
        height: 4,
        created: "2026-09-08T11:04:22Z",
        status: "edited",
        labels: ["hero"],
      },
      "data/media/a+clone+1.md"
    );
    equal(record.mediaLink, "a+clone+1.png");
    equal(record.sourceLink, "a.png");
    deepEqual(record.crop, { x: 1, y: 2, w: 3, h: 4 });
    deepEqual(record.transform, { rotate: 90, flipH: true, flipV: false });
    equal(record.width, 3);
    equal(record.created, "2026-09-08T11:04:22Z");
    deepEqual(record.labels, ["hero"]);
  });

  test("a timestamp that YAML turned into a Date comes back as a string", () => {
    const record = core.instanceRecordFrom({ created: new Date(Date.UTC(2026, 8, 8, 11, 4, 22)) }, "n.md");
    equal(record.created, "2026-09-08T11:04:22Z");
  });

  test("a crop with nothing in it is no crop", () => {
    equal(core.instanceRecordFrom({ crop: {} }, "n.md").crop, null);
    equal(core.instanceRecordFrom({ crop: { x: 0, y: 0, w: 0, h: 0 } }, "n.md").crop, null);
  });

  test("present but empty is not declared, so a blanked record still inherits", () => {
    equal(core.isDeclared(""), false);
    equal(core.isDeclared("  "), false);
    equal(core.isDeclared([]), false);
    equal(core.isDeclared({}), false);
    equal(core.isDeclared(null), false);
    equal(core.isDeclared(undefined), false);
    equal(core.isDeclared("edited"), true);
    equal(core.isDeclared(0), true, "zero is a value someone meant");
    equal(core.isDeclared(false), true);
  });

  test("the intrinsic fields are the ones that describe this file", () => {
    for (const field of [
      "media",
      "source",
      "op",
      "crop",
      "transform",
      "sourceTime",
      "width",
      "height",
      "created",
    ]) {
      ok(core.isIntrinsicField(field), field);
    }
    // The evidence fields describe the subject rather than the file, so they
    // inherit: a crop of a captured frame is about the same use case.
    equal(core.isIntrinsicField("useCase"), false);
    equal(core.isIntrinsicField("shows"), false);
    equal(core.isIntrinsicField("status"), false);
    equal(core.isIntrinsicField("labels"), false);
    equal(core.isIntrinsicField("photographer"), false);
  });
});

group("finding notes", () => {
  function storeOver(entries) {
    const app = fakeVault(entries);
    const store = new LineageStore(app, {});
    store.build();
    return { app, store };
  }

  const VAULT = [
    { path: "data/assets/cover.png" },
    { path: "data/assets/cover+clone+1.png" },
    instance("data/media/cover.md", { media: "[[cover.png]]", status: "reviewed" }),
    instance("data/media/cover+clone+1.md", {
      media: "[[cover+clone+1.png]]",
      source: "[[cover.png]]",
      op: "crop",
    }),
    { path: "data/notes/unrelated.md", frontmatter: { implements: "Planet" } },
  ];

  test("a note is found by what it says, not by what it is called", () => {
    const { store } = storeOver(VAULT);
    equal(store.noteFileFor("data/assets/cover.png").path, "data/media/cover.md");
    ok(store.isTracked("data/assets/cover.png"));
  });

  test("notes of other schemas are ignored entirely", () => {
    const { store } = storeOver(VAULT);
    equal(store.records.size, 2);
    equal(store.recordAt("data/notes/unrelated.md"), null);
  });

  test("a file with no note is untracked, and that is not an error", () => {
    const { store } = storeOver(VAULT);
    equal(store.isTracked("data/assets/nothing.png"), false);
    equal(store.recordFor("data/assets/nothing.png"), null);
  });

  test("parent and children read off the same maps", () => {
    const { store } = storeOver(VAULT);
    equal(store.parentOf("data/assets/cover+clone+1.png"), "data/assets/cover.png");
    deepEqual(store.childrenOf("data/assets/cover.png"), ["data/assets/cover+clone+1.png"]);
    deepEqual(store.childrenOf("data/assets/cover+clone+1.png"), []);
  });

  test("a note moved and renamed by hand is still found", () => {
    // The whole point of discovery through the cache: nothing depended on
    // where the note was or what it was called.
    const { app, store } = storeOver(VAULT);
    const note = app.files.get("data/media/cover.md");
    app.files.delete("data/media/cover.md");
    note.path = "MyVault/archive/some other name.md";
    note.basename = "some other name";
    app.files.set(note.path, note);
    app.metadataCache.setFrontmatter(note.path, {
      implements: "MediaInstance",
      media: "[[cover.png]]",
      status: "reviewed",
    });
    store.build();
    equal(store.noteFileFor("data/assets/cover.png").path, "MyVault/archive/some other name.md");
  });

  test("a source naming a file that is not here is reported, not repaired", () => {
    const { store } = storeOver([
      { path: "data/assets/orphan.png" },
      instance("data/media/orphan.md", { media: "[[orphan.png]]", source: "[[deleted.png]]" }),
    ]);
    equal(store.parentOf("data/assets/orphan.png"), null);
    const breaks = store.breaks();
    equal(breaks.length, 1);
    equal(breaks[0].kind, "source");
    equal(breaks[0].link, "deleted.png");
    equal(breaks[0].notePath, "data/media/orphan.md");
  });

  test("a note whose media has gone is a break too", () => {
    const { store } = storeOver([instance("data/media/ghost.md", { media: "[[gone.png]]" })]);
    const breaks = store.breaks();
    equal(breaks.length, 1);
    equal(breaks[0].kind, "media");
    equal(breaks[0].link, "gone.png");
  });

  test("two notes claiming one file leaves the first standing", () => {
    const { store } = storeOver([
      { path: "data/assets/cover.png" },
      instance("data/media/a.md", { media: "[[cover.png]]", status: "reviewed" }),
      instance("data/media/b.md", { media: "[[cover.png]]", status: "edited" }),
    ]);
    equal(store.noteFileFor("data/assets/cover.png").path, "data/media/a.md");
    equal(store.records.size, 2, "both are still records; only the claim is contested");
  });
});

group("keeping the maps current", () => {
  test("a note edited into being is picked up from the changed event", () => {
    const app = fakeVault([{ path: "data/assets/cover.png" }, { path: "data/media/cover.md" }]);
    const store = new LineageStore(app, {});
    store.build();
    equal(store.isTracked("data/assets/cover.png"), false);

    const note = app.files.get("data/media/cover.md");
    const frontmatter = { implements: "MediaInstance", media: "[[cover.png]]" };
    app.metadataCache.setFrontmatter(note.path, frontmatter);
    ok(store.handleMetadataChange(note, "", { frontmatter }));
    equal(store.noteFileFor("data/assets/cover.png").path, "data/media/cover.md");
  });

  test("a note edited out of being is dropped again", () => {
    const app = fakeVault([
      { path: "data/assets/cover.png" },
      instance("data/media/cover.md", { media: "[[cover.png]]" }),
    ]);
    const store = new LineageStore(app, {});
    store.build();
    const note = app.files.get("data/media/cover.md");
    ok(store.handleMetadataChange(note, "", { frontmatter: { implements: "Planet" } }));
    equal(store.isTracked("data/assets/cover.png"), false);
    equal(store.records.size, 0);
  });

  test("a note repointed at another file moves with it", () => {
    const app = fakeVault([
      { path: "data/assets/a.png" },
      { path: "data/assets/b.png" },
      instance("data/media/n.md", { media: "[[a.png]]" }),
    ]);
    const store = new LineageStore(app, {});
    store.build();
    const note = app.files.get("data/media/n.md");
    store.handleMetadataChange(note, "", { frontmatter: { implements: "MediaInstance", media: "[[b.png]]" } });
    equal(store.isTracked("data/assets/a.png"), false);
    equal(store.noteFileFor("data/assets/b.png").path, "data/media/n.md");
  });

  test("a change to a note that was never lineage is not work", () => {
    const app = fakeVault([{ path: "data/notes/x.md", frontmatter: { implements: "Planet" } }]);
    const store = new LineageStore(app, {});
    store.build();
    const note = app.files.get("data/notes/x.md");
    equal(store.handleMetadataChange(note, "", { frontmatter: { implements: "Planet" } }), false);
  });

  test("a rename of the note moves its keys without a rebuild", () => {
    const app = fakeVault([
      { path: "data/assets/a.png" },
      instance("data/media/a.md", { media: "[[a.png]]" }),
    ]);
    const store = new LineageStore(app, {});
    store.build();
    const note = app.files.get("data/media/a.md");
    note.path = "data/media/renamed.md";
    ok(store.handleRename(note, "data/media/a.md"));
    equal(store.noteFileFor("data/assets/a.png"), null, "the vault no longer holds the old path");
    equal(store.byMedia.get("data/assets/a.png"), "data/media/renamed.md");
  });

  test("a rename of the media moves the maps to the new path", () => {
    const app = fakeVault([
      { path: "data/assets/a.png" },
      { path: "data/assets/a+clone+1.png" },
      instance("data/media/a.md", { media: "[[a.png]]" }),
      instance("data/media/c.md", { media: "[[a+clone+1.png]]", source: "[[a.png]]" }),
    ]);
    const store = new LineageStore(app, {});
    store.build();
    ok(store.handleRename({ path: "data/assets/hero.png" }, "data/assets/a.png"));
    equal(store.byMedia.get("data/assets/hero.png"), "data/media/a.md");
    deepEqual(store.childrenOf("data/assets/hero.png"), ["data/assets/a+clone+1.png"]);
  });

  test("an untracked file renamed is no work at all", () => {
    const app = fakeVault([{ path: "data/assets/loose.png" }]);
    const store = new LineageStore(app, {});
    store.build();
    equal(store.handleRename({ path: "data/assets/other.png" }, "data/assets/loose.png"), false);
  });

  test("a change fires onChange once, and a non-change fires nothing", () => {
    const app = fakeVault([{ path: "data/assets/a.png" }, { path: "data/media/a.md" }]);
    let calls = 0;
    const store = new LineageStore(app, { onChange: () => (calls += 1) });
    store.build();
    calls = 0;
    const note = app.files.get("data/media/a.md");
    store.handleMetadataChange(note, "", { frontmatter: { implements: "MediaInstance", media: "[[a.png]]" } });
    equal(calls, 1);
    store.handleMetadataChange({ path: "data/assets/a.png" }, "", null);
    equal(calls, 1, "a media file is not a note");
  });
});

group("writing notes", () => {
  test("a new note is created in the note folder", async () => {
    const app = fakeVault([{ path: "data/assets/cover.png" }]);
    const store = new LineageStore(app, { noteFolder: "data/media" });
    store.build();
    const file = await store.write("data/assets/cover.png", { status: "reviewed" });
    equal(file.path, "data/media/cover.md");
    ok(app.written[0].text.includes('media: "[[data/assets/cover.png]]"'), app.written[0].text);
    ok(app.written[0].text.includes("status: reviewed"));
  });

  test("the note is findable the moment it exists, not one event later", async () => {
    const app = fakeVault([{ path: "data/assets/cover.png" }]);
    const store = new LineageStore(app, {});
    store.build();
    await store.write("data/assets/cover.png", { status: "reviewed" });
    // The save path writes a root note and a child note in one breath, and the
    // second needs the first to be there.
    equal(store.isTracked("data/assets/cover.png"), true);
  });

  test("writing again updates the note it already has", async () => {
    const app = fakeVault([{ path: "data/assets/cover.png" }]);
    const store = new LineageStore(app, {});
    store.build();
    const first = await store.write("data/assets/cover.png", { status: "edited" });
    const second = await store.write("data/assets/cover.png", { status: "reviewed" });
    equal(first.path, second.path, "one note, not two");
    equal(app.written.length, 2);
    equal(app.written[1].kind, "modify");
    ok(app.written[1].text.includes("status: reviewed"));
  });

  test("a rewrite keeps everything below the marker", async () => {
    const app = fakeVault([{ path: "data/assets/cover.png" }]);
    const store = new LineageStore(app, {});
    store.build();
    const file = await store.write("data/assets/cover.png", { status: "edited" });
    file.body = file.body + "\nThe shot from the roof, before the rain.\n";
    await store.write("data/assets/cover.png", { status: "reviewed" });
    ok(file.body.includes("The shot from the roof, before the rain."), file.body);
    ok(file.body.includes("status: reviewed"));
  });

  test("a rewrite keeps frontmatter this plugin did not write", async () => {
    const app = fakeVault([
      { path: "data/assets/cover.png" },
      instance("data/media/cover.md", {
        media: "[[cover.png]]",
        status: "edited",
        photographer: "Ada",
      }),
    ]);
    const store = new LineageStore(app, {});
    store.build();
    await store.write("data/assets/cover.png", { status: "reviewed" });
    const text = app.written[0].text;
    ok(text.includes("photographer: Ada"), text);
    ok(text.includes("status: reviewed"), text);
  });

  test("a name already taken gets a suffix rather than an overwrite", async () => {
    const app = fakeVault([
      { path: "data/assets/cover.png" },
      { path: "data/assets/cover.jpg" },
      { path: "data/media/cover.md" },
    ]);
    const store = new LineageStore(app, {});
    store.build();
    const file = await store.write("data/assets/cover.png", {});
    equal(file.path, "data/media/cover.1.md");
  });

  test("a round trip through the cache comes back the same", async () => {
    const app = fakeVault([{ path: "data/assets/cover.png" }, { path: "data/assets/cover+clone+1.png" }]);
    const store = new LineageStore(app, {});
    store.build();
    const fields = {
      source: "[[data/assets/cover.png]]",
      op: "crop",
      crop: { x: 120, y: 40, w: 800, h: 600 },
      transform: { rotate: 90, flipH: true, flipV: false },
      width: 800,
      height: 600,
      created: "2026-09-08T11:04:22Z",
      status: "edited",
      labels: ["hero"],
    };
    const file = await store.write("data/assets/cover+clone+1.png", fields);
    // Stand in for Obsidian parsing what was written: the plugin's own reader
    // over the same values.
    const record = core.instanceRecordFrom(
      Object.assign({ implements: "MediaInstance", media: "[[data/assets/cover+clone+1.png]]" }, fields),
      file.path
    );
    deepEqual(record.crop, { x: 120, y: 40, w: 800, h: 600 });
    deepEqual(record.transform, { rotate: 90, flipH: true, flipV: false });
    equal(record.sourceLink, "data/assets/cover.png");
    deepEqual(record.labels, ["hero"]);
  });
});

report("lineage");
