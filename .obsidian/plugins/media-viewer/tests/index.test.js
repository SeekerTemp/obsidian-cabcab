// Tests for MediaIndex. Run with:
//
//   node tests/index.test.js
//
// The vault is stubbed down to the one method the index uses, getFiles().
const { MediaIndex, core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

// Stands in for Obsidian's TFile. Only `path` matters to the index; `id` is
// here so a test can tell one handle for a path from another.
let handleCounter = 0;
function file(path) {
  handleCounter += 1;
  return { path, id: handleCounter };
}

function vaultOf(paths) {
  const files = paths.map(file);
  return {
    files,
    getFiles() {
      return this.files;
    },
    add(path) {
      const created = file(path);
      this.files.push(created);
      return created;
    },
    drop(path) {
      const index = this.files.findIndex((f) => f.path === path);
      const [removed] = this.files.splice(index, 1);
      return removed;
    },
  };
}

const FOLDER = "data/assets";

function indexOver(paths, folder, recursive) {
  const vault = vaultOf(paths);
  const index = new MediaIndex(vault);
  index.setFolder(folder === undefined ? FOLDER : folder, recursive);
  return { index, vault };
}

group("scanning a folder", () => {
  test("lists the folder's media and nothing else", () => {
    const { index } = indexOver([
      "data/assets/cover.png",
      "data/assets/clip.mp4",
      "data/assets/notes.md",
      "data/assets/archive.zip",
      "other/elsewhere.png",
    ]);
    deepEqual(index.paths, ["data/assets/clip.mp4", "data/assets/cover.png"]);
  });

  test("sidecar notes never appear in the grid", () => {
    const { index } = indexOver([
      "data/assets/cover.png",
      "data/assets/cover.instance.md",
      "data/assets/clip.mp4.instance.md",
    ]);
    deepEqual(index.paths, ["data/assets/cover.png"]);
  });

  test("is non-recursive by default", () => {
    const { index } = indexOver(["data/assets/cover.png", "data/assets/sub/deep.png"]);
    deepEqual(index.paths, ["data/assets/cover.png"]);
  });

  test("the recursive toggle picks up descendants, and rescans on change", () => {
    const { index } = indexOver(["data/assets/cover.png", "data/assets/sub/deep.png"]);
    index.setRecursive(true);
    deepEqual(index.paths, ["data/assets/cover.png", "data/assets/sub/deep.png"]);
    index.setRecursive(false);
    deepEqual(index.paths, ["data/assets/cover.png"]);
  });

  test("orders numerically, so shot2 comes before shot10", () => {
    const { index } = indexOver([
      "data/assets/shot10.png",
      "data/assets/shot2.png",
      "data/assets/shot1.png",
    ]);
    deepEqual(index.paths, [
      "data/assets/shot1.png",
      "data/assets/shot2.png",
      "data/assets/shot10.png",
    ]);
  });

  test("orders case-insensitively", () => {
    const { index } = indexOver([
      "data/assets/Zebra.png",
      "data/assets/apple.png",
      "data/assets/Banana.png",
    ]);
    deepEqual(index.paths, [
      "data/assets/apple.png",
      "data/assets/Banana.png",
      "data/assets/Zebra.png",
    ]);
  });

  test("the vault root is a folder like any other", () => {
    const { index } = indexOver(["cover.png", "data/assets/deep.png"], "");
    deepEqual(index.paths, ["cover.png"]);
  });

  test("no folder selected means an empty list, not a whole-vault scan", () => {
    const { index } = indexOver(["data/assets/cover.png"], null);
    deepEqual(index.paths, []);
    equal(index.size, 0);
  });

  test("switching folders replaces the list rather than appending to it", () => {
    const { index } = indexOver(["data/assets/cover.png", "other/elsewhere.png"]);
    index.setFolder("other");
    deepEqual(index.paths, ["other/elsewhere.png"]);
  });

  test("a trailing slash on the folder is tolerated", () => {
    const { index } = indexOver(["data/assets/cover.png"], "data/assets/");
    deepEqual(index.paths, ["data/assets/cover.png"]);
  });
});

group("lookup", () => {
  test("maps path to file handle, and reports position", () => {
    const { index } = indexOver(["data/assets/b.png", "data/assets/a.png"]);
    ok(index.has("data/assets/a.png"));
    equal(index.fileFor("data/assets/a.png").path, "data/assets/a.png");
    equal(index.indexOf("data/assets/b.png"), 1);
    equal(index.at(0), "data/assets/a.png");
  });

  test("an absent path reports cleanly rather than throwing", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    equal(index.has("data/assets/missing.png"), false);
    equal(index.fileFor("data/assets/missing.png"), null);
    equal(index.indexOf("data/assets/missing.png"), -1);
    equal(index.at(5), null);
    equal(index.at(-1), null);
  });
});

group("insertion is idempotent by path", () => {
  test("a create event adds the file once", () => {
    const { index, vault } = indexOver(["data/assets/a.png"]);
    const created = vault.add("data/assets/b.png");
    equal(index.handleCreate(created), true);
    deepEqual(index.paths, ["data/assets/a.png", "data/assets/b.png"]);
  });

  test("the same file created twice is added once — this is the save path", () => {
    const { index, vault } = indexOver(["data/assets/a.png"]);
    const created = vault.add("data/assets/b.png");
    index.handleCreate(created);
    equal(index.handleCreate(created), false, "the second event is a no-op");
    deepEqual(index.paths, ["data/assets/a.png", "data/assets/b.png"]);
    equal(index.size, 2);
  });

  test("a file already found by the scan is not added again by its create event", () => {
    const { index, vault } = indexOver(["data/assets/a.png"]);
    equal(index.handleCreate(vault.files[0]), false);
    equal(index.size, 1);
  });

  test("re-inserting an existing path refreshes the handle without reordering", () => {
    const { index } = indexOver(["data/assets/a.png", "data/assets/b.png"]);
    const before = index.fileFor("data/assets/a.png").id;
    index.insert(file("data/assets/a.png"));
    ok(index.fileFor("data/assets/a.png").id !== before, "handle replaced");
    deepEqual(index.paths, ["data/assets/a.png", "data/assets/b.png"]);
  });

  test("insertion lands in sorted position, not at the end", () => {
    const { index } = indexOver(["data/assets/a.png", "data/assets/c.png"]);
    index.handleCreate(file("data/assets/b.png"));
    deepEqual(index.paths, ["data/assets/a.png", "data/assets/b.png", "data/assets/c.png"]);
  });

  test("insertion honours numeric order", () => {
    const { index } = indexOver(["data/assets/shot1.png", "data/assets/shot10.png"]);
    index.handleCreate(file("data/assets/shot2.png"));
    deepEqual(index.paths, [
      "data/assets/shot1.png",
      "data/assets/shot2.png",
      "data/assets/shot10.png",
    ]);
  });

  test("a create outside the folder, or of a non-media file, is ignored", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    equal(index.handleCreate(file("other/b.png")), false);
    equal(index.handleCreate(file("data/assets/notes.md")), false);
    equal(index.handleCreate(file("data/assets/a.instance.md")), false);
    equal(index.handleCreate(null), false);
    equal(index.size, 1);
  });
});

group("modify", () => {
  test("refreshes the handle without changing membership", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    const before = index.fileFor("data/assets/a.png").id;
    equal(index.handleModify(file("data/assets/a.png")), true);
    ok(index.fileFor("data/assets/a.png").id !== before, "handle replaced so the URL can change");
    equal(index.size, 1);
  });

  test("a modify for a file this index does not hold is dropped", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    equal(index.handleModify(file("other/b.png")), false);
    equal(index.handleModify(null), false);
  });
});

group("delete", () => {
  test("removes the file from both the map and the order", () => {
    const { index } = indexOver(["data/assets/a.png", "data/assets/b.png"]);
    equal(index.handleDelete(file("data/assets/a.png")), true);
    deepEqual(index.paths, ["data/assets/b.png"]);
    equal(index.has("data/assets/a.png"), false);
  });

  test("a delete for an unheld file is dropped", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    equal(index.handleDelete(file("other/b.png")), false);
    equal(index.size, 1);
  });

  test("successorFor gives the following entry", () => {
    const { index } = indexOver(["data/assets/a.png", "data/assets/b.png", "data/assets/c.png"]);
    equal(index.successorFor("data/assets/b.png"), "data/assets/c.png");
  });

  test("successorFor gives the previous entry at the end of the list", () => {
    const { index } = indexOver(["data/assets/a.png", "data/assets/b.png"]);
    equal(index.successorFor("data/assets/b.png"), "data/assets/a.png");
  });

  test("successorFor of the only entry, and of an unheld path, is null", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    equal(index.successorFor("data/assets/a.png"), null);
    equal(index.successorFor("data/assets/missing.png"), null);
  });
});

group("rename", () => {
  test("a rename within the folder moves the entry and re-sorts", () => {
    const { index } = indexOver(["data/assets/a.png", "data/assets/c.png"]);
    equal(index.handleRename(file("data/assets/z.png"), "data/assets/a.png"), true);
    deepEqual(index.paths, ["data/assets/c.png", "data/assets/z.png"]);
    equal(index.has("data/assets/a.png"), false);
  });

  test("a rename out of the folder removes the entry", () => {
    const { index } = indexOver(["data/assets/a.png", "data/assets/b.png"]);
    equal(index.handleRename(file("other/a.png"), "data/assets/a.png"), true);
    deepEqual(index.paths, ["data/assets/b.png"]);
  });

  test("a rename into the folder adds the entry", () => {
    const { index } = indexOver(["data/assets/b.png"]);
    equal(index.handleRename(file("data/assets/a.png"), "other/a.png"), true);
    deepEqual(index.paths, ["data/assets/a.png", "data/assets/b.png"]);
  });

  test("a rename that never touches the folder is dropped", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    equal(index.handleRename(file("other/y.png"), "other/x.png"), false);
    deepEqual(index.paths, ["data/assets/a.png"]);
  });

  test("renaming a media file into a sidecar name removes it from the grid", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    index.handleRename(file("data/assets/a.instance.md"), "data/assets/a.png");
    deepEqual(index.paths, []);
  });

  test("a rename onto an existing path does not duplicate it", () => {
    const { index } = indexOver(["data/assets/a.png", "data/assets/b.png"]);
    index.handleRename(file("data/assets/b.png"), "data/assets/a.png");
    deepEqual(index.paths, ["data/assets/b.png"]);
    equal(index.size, 1);
  });
});

group("change notification", () => {
  test("reports the reason and the path touched", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    const seen = [];
    index.onChange = (reason, path, oldPath) => seen.push([reason, path, oldPath]);
    index.handleCreate(file("data/assets/b.png"));
    index.handleModify(file("data/assets/b.png"));
    index.handleRename(file("data/assets/c.png"), "data/assets/b.png");
    index.handleDelete(file("data/assets/c.png"));
    deepEqual(seen, [
      ["create", "data/assets/b.png", undefined],
      ["modify", "data/assets/b.png", undefined],
      ["rename", "data/assets/c.png", "data/assets/b.png"],
      ["delete", "data/assets/c.png", undefined],
    ]);
  });

  test("stays quiet for events about other folders", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    let count = 0;
    index.onChange = () => (count += 1);
    index.handleCreate(file("other/b.png"));
    index.handleModify(file("other/b.png"));
    index.handleDelete(file("other/b.png"));
    equal(count, 0);
  });

  test("a rescan reports once", () => {
    const { index } = indexOver(["data/assets/a.png"]);
    const seen = [];
    index.onChange = (reason) => seen.push(reason);
    index.setFolder("other");
    deepEqual(seen, ["scan"]);
  });
});

group("core helpers behind the index", () => {
  test("isInFolder is exact unless recursive", () => {
    equal(core.isInFolder("a/b/c.png", "a/b"), true);
    equal(core.isInFolder("a/b/d/c.png", "a/b"), false);
    equal(core.isInFolder("a/b/d/c.png", "a/b", true), true);
    equal(core.isInFolder("a/bb/c.png", "a/b", true), false, "prefix match must not cross a name");
  });

  test("the root folder contains everything under recursion, and only its own files without", () => {
    equal(core.isInFolder("c.png", ""), true);
    equal(core.isInFolder("a/c.png", ""), false);
    equal(core.isInFolder("a/c.png", "", true), true);
  });

  test("sortedInsertIndex finds the position in an ordered list", () => {
    const paths = ["a.png", "c.png", "e.png"];
    equal(core.sortedInsertIndex(paths, "b.png"), 1);
    equal(core.sortedInsertIndex(paths, "f.png"), 3);
    equal(core.sortedInsertIndex(paths, "A.png"), 0);
    equal(core.sortedInsertIndex([], "a.png"), 0);
  });

  test("compareMediaPaths is a total order, so equal names still separate", () => {
    ok(core.compareMediaPaths("x/a.png", "y/a.png") !== 0, "distinct paths never compare equal");
    equal(core.compareMediaPaths("a/x.png", "a/x.png"), 0);
  });

  test("selectionAfterRemoval clamps to the end and reports an empty list", () => {
    equal(core.selectionAfterRemoval(["a", "b"], 0), "a");
    equal(core.selectionAfterRemoval(["a", "b"], 2), "b");
    equal(core.selectionAfterRemoval([], 0), null);
  });
});

report("index");
