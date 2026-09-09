/* A vault small enough to reason about.
 *
 * Files are strings in a Map, frontmatter is whatever a test says it is, and
 * `getFirstLinkpathDest` resolves a link the way Obsidian does for the cases
 * that matter here: an exact path, or a bare filename found anywhere.
 *
 * It is deliberately not a fake filesystem. ffmpeg writes to a real disk and
 * the vault only ever *notices* what appeared, so the two are separate fakes
 * and the seam between them is the thing worth testing.
 */

class FakeFile {
  constructor(path) {
    this.path = path;
    const at = path.lastIndexOf("/");
    this.name = at === -1 ? path : path.slice(at + 1);
    const dot = this.name.lastIndexOf(".");
    this.basename = dot <= 0 ? this.name : this.name.slice(0, dot);
    this.extension = dot <= 0 ? "" : this.name.slice(dot + 1);
  }
}

class FakeFolder {
  constructor(path) {
    this.path = path;
    this.children = [];
  }
}

function createFakeApp(options) {
  const settings = options || {};
  const contents = new Map();
  const files = new Map();
  const folders = new Map();
  const frontmatters = new Map();
  const events = {};
  // Everything the vault was asked to do, in order, so a test can assert that
  // a save wrote two notes rather than three.
  const log = [];

  const ensureFolders = (path) => {
    const parts = path.split("/");
    parts.pop();
    let seen = "";
    for (const part of parts) {
      seen = seen ? seen + "/" + part : part;
      if (!folders.has(seen)) folders.set(seen, new FakeFolder(seen));
    }
  };

  const app = {
    vault: {
      getAbstractFileByPath(path) {
        return files.get(path) || folders.get(path) || null;
      },
      getMarkdownFiles() {
        return Array.from(files.values()).filter((file) => file.extension === "md");
      },
      // Every file in the vault, which is what the browser walks to find out
      // what there is to edit.
      getFiles() {
        return Array.from(files.values());
      },
      getResourcePath(file) {
        return "app://fake/" + file.path;
      },
      adapter: {
        getBasePath: () => settings.basePath || "/vault",
      },
      async read(file) {
        return contents.get(file.path) || "";
      },
      async modify(file, text) {
        log.push({ op: "modify", path: file.path });
        contents.set(file.path, text);
        return file;
      },
      async create(path, text) {
        log.push({ op: "create", path });
        if (files.has(path)) throw new Error("exists: " + path);
        ensureFolders(path);
        const file = new FakeFile(path);
        files.set(path, file);
        contents.set(path, text);
        return file;
      },
      async createFolder(path) {
        log.push({ op: "createFolder", path });
        if (folders.has(path)) throw new Error("exists: " + path);
        folders.set(path, new FakeFolder(path));
        return folders.get(path);
      },
      on(name, handler) {
        (events[name] = events[name] || []).push(handler);
        return { name };
      },
    },
    metadataCache: {
      getFileCache(file) {
        const front = frontmatters.get(file.path);
        return front ? { frontmatter: front } : null;
      },
      /* Obsidian resolves a bare name against the whole vault, which is what
         lets a note be moved by hand and keep working. */
      getFirstLinkpathDest(link, from) {
        if (files.has(link)) return files.get(link);
        for (const [path, file] of files) {
          if (file.name === link || file.basename === link) return file;
        }
        return null;
      },
      on(name, handler) {
        (events[name] = events[name] || []).push(handler);
        return { name };
      },
    },
    workspace: {
      trigger() {},
      on(name, handler) {
        (events[name] = events[name] || []).push(handler);
        return { name };
      },
      getActiveFile: () => settings.activeFile || null,
      getLeavesOfType: () => [],
      onLayoutReady: (fn) => fn(),
    },
  };

  return {
    app,
    files,
    folders,
    contents,
    frontmatters,
    log,
    // Put a media file in the vault without going through create(), the way
    // one arrives from disk.
    addFile(path) {
      ensureFolders(path);
      const file = new FakeFile(path);
      files.set(path, file);
      return file;
    },
    addNote(path, frontmatter, body) {
      ensureFolders(path);
      const file = new FakeFile(path);
      files.set(path, file);
      frontmatters.set(path, frontmatter);
      contents.set(path, body || "");
      return file;
    },
    // What a note looks like on disk, for a round-trip assertion.
    textAt(path) {
      return contents.get(path) || "";
    },
    frontmatterAt(path) {
      return frontmatters.get(path) || null;
    },
    setFrontmatter(path, frontmatter) {
      frontmatters.set(path, frontmatter);
    },
  };
}

module.exports = { createFakeApp, FakeFile, FakeFolder };
