// Tests for the crash log: the text it produces, the trimming that stops it
// growing without bound, and the buffer that answers "Copy crash log" even
// when every write has failed.
//
//   node tests/crashlog.test.js
const { installDom } = require("./stub-dom.js");
const dom = installDom();

const { core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, report } = require("./harness.js");

const FIXED = new Date(Date.UTC(2026, 8, 9, 11, 4, 22));

group("what an entry looks like", () => {
  test("time, level, scope and message, in that order on one line", () => {
    equal(
      core.formatLogEntry({ time: FIXED, level: "error", scope: "decode", message: "boom" }),
      "2026-09-09T11:04:22.000Z | ERROR | decode | boom"
    );
  });

  test("a stack follows, indented, so entries stay tellable apart", () => {
    const error = new Error("bang");
    error.stack = "Error: bang\n    at somewhere";
    const lines = core.formatLogEntry({ time: FIXED, scope: "save", message: "failed", error }).split("\n");
    equal(lines[0], "2026-09-09T11:04:22.000Z | ERROR | save | failed");
    equal(lines[1], "    Error: bang");
    equal(lines[2], "        at somewhere");
  });

  test("missing fields fall back rather than printing undefined", () => {
    const line = core.formatLogEntry({});
    ok(line.indexOf("| ERROR | plugin |") !== -1, "got " + line);
    equal(line.indexOf("undefined"), -1);
  });
});

group("whatever the failure turns out to be", () => {
  test("an Error gives its stack, which already carries the message", () => {
    const error = new Error("bang");
    error.stack = "Error: bang\n    at somewhere";
    equal(core.errorText(error), "Error: bang\n    at somewhere");
  });

  test("a message and an unrelated stack keep both", () => {
    const error = new Error("bang");
    error.stack = "    at somewhere";
    equal(core.errorText(error), "bang\n    at somewhere");
  });

  test("a rejected promise carrying a string, or nothing at all", () => {
    // Neither may throw on the way through: the log is what runs when
    // everything else has already gone wrong.
    equal(core.errorText("just a string"), "just a string");
    equal(core.errorText(null), "");
    equal(core.errorText(undefined), "");
    equal(core.errorText({ message: "objecty" }), "objecty");
  });
});

group("the file does not grow without bound", () => {
  test("under the cap, nothing is touched", () => {
    equal(core.trimLogText("a\nb\n", 100), "a\nb\n");
  });

  test("over it, the newest text survives", () => {
    const trimmed = core.trimLogText("old\nmiddle\nnewest\n", 12);
    ok(trimmed.indexOf("newest") !== -1, "kept the end");
    ok(trimmed.indexOf("old") === -1, "dropped the start");
  });

  test("the cut lands on a line boundary, never mid-entry", () => {
    const trimmed = core.trimLogText("aaaa\nbbbb\ncccc\n", 7);
    // A fragment like "bb\ncccc" would read as an entry that never happened.
    for (const line of trimmed.split("\n")) {
      ok(line === "" || line === "cccc" || line.indexOf("trimmed") !== -1, "unexpected line: " + line);
    }
  });

  test("and it says that something was dropped", () => {
    ok(core.trimLogText("aaaa\nbbbb\ncccc\n", 7).indexOf("trimmed") !== -1);
  });
});

/* The log itself. */

const { CrashLog } = require("./load-plugin.js");

function fakeApp() {
  const files = new Map();
  return {
    files,
    vault: {
      adapter: {
        writes: 0,
        async exists(path) {
          return files.has(path);
        },
        async read(path) {
          return files.get(path) || "";
        },
        async write(path, data) {
          this.writes += 1;
          files.set(path, data);
        },
      },
    },
  };
}

group("recording a failure", () => {
  test("it reaches the buffer straight away, before any write", async () => {
    const app = fakeApp();
    const log = new CrashLog(app, { path: "crash.log" });
    log.record("save", "could not encode", new Error("nope"));
    ok(log.text().indexOf("could not encode") !== -1);
    equal(app.vault.adapter.writes, 0, "the write is deferred");
  });

  test("the deferred write lands on the flush", async () => {
    const app = fakeApp();
    const log = new CrashLog(app, { path: "crash.log" });
    log.record("save", "could not encode", new Error("nope"));
    dom.runTimers();
    await log.flush();
    ok((app.files.get("crash.log") || "").indexOf("could not encode") !== -1);
  });

  test("many failures in a row cost one write, not one each", async () => {
    // A loop that throws on every file would otherwise turn one bad folder
    // into a thousand disk writes.
    const app = fakeApp();
    const log = new CrashLog(app, { path: "crash.log" });
    for (let n = 0; n < 50; n += 1) log.record("grid", "tile " + n + " failed", new Error("x"));
    dom.runTimers();
    await log.flush();
    equal(app.vault.adapter.writes, 1);
    ok((app.files.get("crash.log") || "").indexOf("tile 49 failed") !== -1, "and all of them are in it");
  });

  test("disabled, it records nothing at all", async () => {
    const app = fakeApp();
    const log = new CrashLog(app, { path: "crash.log", enabled: false });
    equal(log.record("save", "boom", new Error("x")), null);
    equal(log.text(), "");
  });

  test("the buffer is capped, so a long session cannot grow it forever", () => {
    const app = fakeApp();
    const log = new CrashLog(app, { path: "crash.log" });
    for (let n = 0; n < core.CRASH_LOG_BUFFER + 40; n += 1) log.record("x", "entry " + n, null);
    equal(log.entries.length, core.CRASH_LOG_BUFFER);
    ok(log.text().indexOf("entry 0") === -1, "the oldest went");
  });
});

group("when the log itself cannot be written", () => {
  test("it reports once and keeps the entries in memory", async () => {
    const app = fakeApp();
    app.vault.adapter.write = async () => {
      throw new Error("read-only");
    };
    const log = new CrashLog(app, { path: "crash.log" });
    const reported = [];
    const original = console.error;
    console.error = (...args) => reported.push(args[0]);
    try {
      log.record("save", "first failure", new Error("x"));
      await log.flush();
      log.record("save", "second failure", new Error("x"));
      await log.flush();
    } finally {
      console.error = original;
    }
    equal(reported.length, 1, "reported once, not per entry");
    ok(log.text().indexOf("second failure") !== -1, "both are still recoverable by Copy crash log");
  });
});

group("the notice does not become the problem", () => {
  test("one notice for a burst of failures", () => {
    let notices = 0;
    const log = new CrashLog(fakeApp(), { path: "crash.log", onNotice: () => (notices += 1) });
    for (let n = 0; n < 20; n += 1) log.record("grid", "failure " + n, null);
    equal(notices, 1);
  });
});

report("crashlog");
