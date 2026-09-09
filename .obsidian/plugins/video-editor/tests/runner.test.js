/* FfmpegRunner — the only thing here that spawns a process.
 *
 * Driven against a fake child rather than a real ffmpeg, because what is worth
 * asserting is the plumbing: that a progress block split across two reads is
 * still read, that a missing binary says so in words, and that cancelling
 * actually kills something.
 */
require("./stub-dom.js").installDom();
const { FfmpegRunner, CancelledError, core } = require("./load-plugin.js");
const { group, test, equal, deepEqual, ok, close, report } = require("./harness.js");

/* A child process with the three streams and two events the runner uses.
   `emit` is exposed so a test can say when data arrives and in what pieces. */
function fakeChild() {
  const listeners = { stdout: {}, stderr: {}, self: {} };
  const child = {
    killed: false,
    stdout: {
      on(type, handler) {
        (listeners.stdout[type] = listeners.stdout[type] || []).push(handler);
      },
    },
    stderr: {
      on(type, handler) {
        (listeners.stderr[type] = listeners.stderr[type] || []).push(handler);
      },
    },
    on(type, handler) {
      (listeners.self[type] = listeners.self[type] || []).push(handler);
    },
    kill() {
      child.killed = true;
      child.close(255);
    },
    out(text) {
      for (const handler of listeners.stdout.data || []) handler(text);
    },
    err(text) {
      for (const handler of listeners.stderr.data || []) handler(text);
    },
    fail(error) {
      for (const handler of listeners.self.error || []) handler(error);
    },
    close(code) {
      for (const handler of listeners.self.close || []) handler(code);
    },
  };
  return child;
}

// A runner whose spawn hands back a child a test drives by hand. `calls`
// records what was asked for, so the binary and the arguments are assertable.
function makeRunner(options) {
  const settings = options || {};
  const calls = [];
  let current = null;
  const runner = new FfmpegRunner({
    getSettings: () => Object.assign({}, core.DEFAULT_SETTINGS, settings.settings || {}),
    platform: settings.platform || "linux",
    bundledFolder: settings.bundledFolder || null,
    fileExists: settings.fileExists || (() => false),
    spawn: (binary, args) => {
      calls.push({ binary, args });
      if (settings.onSpawn) {
        const replacement = settings.onSpawn(binary, args);
        if (replacement === null) throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
        if (replacement) {
          current = replacement;
          return replacement;
        }
      }
      current = fakeChild();
      return current;
    },
  });
  return { runner, calls, child: () => current };
}

group("finding the binary", () => {
  test("uses the platform's name when nothing is configured", async () => {
    const { runner, calls } = makeRunner({ platform: "win32" });
    const child = [];
    const promise = runner.run("ffmpeg", ["-version"], { capture: true });
    await Promise.resolve();
    equal(calls[0].binary, "ffmpeg.exe");
    runner.running.forEach((c) => c.close(0));
    await promise;
  });

  test("a configured path wins over PATH", async () => {
    const { runner, calls } = makeRunner({ settings: { ffmpegPath: "C:/tools/ffmpeg.exe" }, platform: "win32" });
    const promise = runner.run("ffmpeg", ["-version"], {});
    await Promise.resolve();
    equal(calls[0].binary, "C:/tools/ffmpeg.exe");
    runner.running.forEach((c) => c.close(0));
    await promise;
  });

  test("ffprobe is looked up separately", async () => {
    const { runner, calls } = makeRunner({ settings: { ffprobePath: "/opt/ffprobe" } });
    const promise = runner.run("ffprobe", [], {});
    await Promise.resolve();
    equal(calls[0].binary, "/opt/ffprobe");
    runner.running.forEach((c) => c.close(0));
    await promise;
  });
});

group("a missing binary", () => {
  test("is reported in words, not as ENOENT", async () => {
    const { runner } = makeRunner({ onSpawn: () => null });
    let message = "";
    try {
      await runner.run("ffmpeg", [], {});
    } catch (error) {
      message = error.message;
    }
    ok(message.includes("not found"), "says it is missing");
    ok(message.includes("bin folder"), "and names the folder to drop it in");
    ok(message.includes("PATH"), "as well as the other way to satisfy it");
  });

  test("an ENOENT after spawn is treated the same way", async () => {
    const { runner, child } = makeRunner();
    const promise = runner.run("ffmpeg", [], {});
    await Promise.resolve();
    child().fail(Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
    let message = "";
    try {
      await promise;
    } catch (error) {
      message = error.message;
    }
    ok(message.includes("not found"));
  });

  test("check() answers false and remembers, rather than spawning on every open", async () => {
    const { runner, calls } = makeRunner({ onSpawn: () => null });
    equal(await runner.check(), false);
    equal(await runner.check(), false);
    equal(calls.length, 1, "looked once, then remembered");
  });

  test("check() reads the version out of ffmpeg's own banner", async () => {
    const { runner, child } = makeRunner();
    const promise = runner.check();
    await Promise.resolve();
    child().out("ffmpeg version 7.1 Copyright (c) 2000-2024\n");
    child().close(0);
    equal(await promise, true);
    equal(runner.version, "7.1");
  });

  test("forget() makes it look again, which is what a settings change needs", async () => {
    const { runner } = makeRunner({ onSpawn: () => null });
    await runner.check();
    equal(runner.available, false);
    runner.forget();
    equal(runner.available, null);
  });
});

group("a binary carried with the plugin", () => {
  // ffmpeg is a self-contained static executable, so dropping the two files in
  // the plugin's own bin/ is a complete install: no admin rights, nothing on
  // PATH, and it travels with the vault to whatever machine opens it next.
  function bundled(present, options) {
    const settings = options || {};
    return makeRunner(
      Object.assign(
        {
          platform: settings.platform || "win32",
          bundledFolder: "D:/vault/.obsidian/plugins/video-editor",
          fileExists: (path) => present.includes(path),
        },
        settings
      )
    );
  }

  test("is preferred over PATH", async () => {
    const { runner, calls } = bundled(["D:/vault/.obsidian/plugins/video-editor/bin/ffmpeg.exe"]);
    const promise = runner.run("ffmpeg", [], {});
    await Promise.resolve();
    equal(calls[0].binary, "D:/vault/.obsidian/plugins/video-editor/bin/ffmpeg.exe");
    runner.running.forEach((c) => c.close(0));
    await promise;
  });

  test("but a configured path still wins over both", async () => {
    const { runner, calls } = bundled(["D:/vault/.obsidian/plugins/video-editor/bin/ffmpeg.exe"], {
      settings: { ffmpegPath: "C:/tools/ffmpeg.exe" },
    });
    const promise = runner.run("ffmpeg", [], {});
    await Promise.resolve();
    equal(calls[0].binary, "C:/tools/ffmpeg.exe");
    runner.running.forEach((c) => c.close(0));
    await promise;
  });

  test("an empty bin folder falls through to PATH", async () => {
    const { runner, calls } = bundled([]);
    const promise = runner.run("ffmpeg", [], {});
    await Promise.resolve();
    equal(calls[0].binary, "ffmpeg.exe");
    runner.running.forEach((c) => c.close(0));
    await promise;
  });

  test("ffmpeg and ffprobe are looked for separately", async () => {
    // Half an install is a real state: someone copies one file and not both.
    const { runner } = bundled(["D:/vault/.obsidian/plugins/video-editor/bin/ffmpeg.exe"]);
    equal(runner.sourceOf("ffmpeg").kind, "bundled");
    equal(runner.sourceOf("ffprobe").kind, "path");
  });

  test("the lookup is remembered, not repeated for every filmstrip still", async () => {
    let looks = 0;
    const { runner } = bundled([], {
      fileExists: () => {
        looks += 1;
        return false;
      },
    });
    runner.binaryFor("ffmpeg");
    runner.binaryFor("ffmpeg");
    runner.binaryFor("ffmpeg");
    equal(looks, 1);
  });

  test("and looked for again after forget(), which a settings change calls", async () => {
    // Also the case where someone drops the files in while Obsidian is open.
    const present = [];
    const { runner } = bundled(present, { fileExists: (path) => present.includes(path) });
    equal(runner.binaryFor("ffmpeg"), "ffmpeg.exe");
    present.push("D:/vault/.obsidian/plugins/video-editor/bin/ffmpeg.exe");
    runner.forget();
    equal(runner.binaryFor("ffmpeg"), "D:/vault/.obsidian/plugins/video-editor/bin/ffmpeg.exe");
  });

  test("names the executable the platform actually has", () => {
    equal(
      core.bundledBinaryPath("/vault/plugins/video-editor", "ffprobe", "win32"),
      "/vault/plugins/video-editor/bin/ffprobe.exe"
    );
    equal(
      core.bundledBinaryPath("/vault/plugins/video-editor", "ffprobe", "darwin"),
      "/vault/plugins/video-editor/bin/ffprobe"
    );
    equal(core.bundledBinaryPath("", "ffmpeg", "win32"), null, "no folder, no bundled path");
  });
});

group("failure", () => {
  test("a non-zero exit carries what ffmpeg actually said", async () => {
    const { runner, child } = makeRunner();
    const promise = runner.run("ffmpeg", [], {});
    await Promise.resolve();
    child().err("Invalid data found when processing input\n");
    child().close(1);
    let message = "";
    try {
      await promise;
    } catch (error) {
      message = error.message;
    }
    ok(message.includes("Invalid data found"), "ffmpeg's own words, not its exit code");
    equal(message.includes("3199971767"), false, "an unsigned AVERROR helps nobody");
  });

  test("a runaway error stream is trimmed rather than kept whole", async () => {
    // A corrupt file can produce megabytes of the same complaint, and that
    // should not become the reason the pane runs out of memory.
    const { runner, child } = makeRunner();
    const promise = runner.run("ffmpeg", [], {});
    await Promise.resolve();
    for (let i = 0; i < 40; i += 1) child().err("x".repeat(2000) + "\n");
    child().err("Conversion failed!\n");
    child().close(1);
    let message = "";
    try {
      await promise;
    } catch (error) {
      message = error.message;
    }
    ok(message.includes("Conversion failed!"), "the last line survived the trim");
    ok(message.length < 5000, "and the message is a Notice, not a novel");
  });
});

group("progress", () => {
  test("reads a block and reports the seconds done", async () => {
    const { runner, child } = makeRunner();
    const seen = [];
    const promise = runner.run("ffmpeg", [], { onProgress: (p) => seen.push(p) });
    await Promise.resolve();
    child().out("frame=100\nout_time_us=40000000\nspeed=8.0x\nprogress=continue\n");
    child().close(0);
    await promise;
    equal(seen.length, 1);
    close(seen[0].seconds, 40, 1e-9);
    close(seen[0].speed, 8, 1e-9);
  });

  test("a block split across two reads is still read", async () => {
    /* This is the bug the carry exists for: without it the `progress=end` that
       closes a job is missed about as often as it is seen, and the bar sticks
       at 99% on every export. */
    const { runner, child } = makeRunner();
    const seen = [];
    const promise = runner.run("ffmpeg", [], { onProgress: (p) => seen.push(p) });
    await Promise.resolve();
    child().out("out_time_us=400000");
    child().out("00\nprogress=end\n");
    child().close(0);
    await promise;
    const last = seen[seen.length - 1];
    close(last.seconds, 40, 1e-9, "the split number was reassembled");
    equal(last.done, true);
  });

  test("a partial line alone reports nothing rather than a wrong number", async () => {
    const { runner, child } = makeRunner();
    const seen = [];
    const promise = runner.run("ffmpeg", [], { onProgress: (p) => seen.push(p) });
    await Promise.resolve();
    child().out("out_time_us=4000");
    child().close(0);
    await promise;
    equal(seen.length, 0);
  });
});

group("cancelling", () => {
  test("kills the child and reports a cancellation, not a failure", async () => {
    const { runner, child } = makeRunner();
    const signal = { cancelled: false };
    const promise = runner.run("ffmpeg", [], { signal });
    await Promise.resolve();
    signal.cancelled = true;
    let caught = null;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    ok(caught instanceof CancelledError, "a cancellation, not an ffmpeg error");
    equal(child().killed, true, "and the process actually stopped");
  });

  test("killAll stops everything still running", async () => {
    const { runner } = makeRunner();
    const first = runner.run("ffmpeg", [], {}).catch(() => "stopped");
    const second = runner.run("ffmpeg", [], {}).catch(() => "stopped");
    await Promise.resolve();
    equal(runner.running.size, 2);
    runner.killAll();
    deepEqual(await Promise.all([first, second]), ["stopped", "stopped"]);
    equal(runner.running.size, 0);
  });
});

group("probing", () => {
  test("hands back the parsed shape", async () => {
    const { runner, child, calls } = makeRunner();
    const promise = runner.probe("/vault/walk.mp4");
    await Promise.resolve();
    equal(calls[0].args.includes("-show_streams"), true);
    child().out(
      JSON.stringify({
        streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "25/1" }],
        format: { duration: "3600.0" },
      })
    );
    child().close(0);
    const info = await promise;
    equal(info.width, 1280);
    close(info.duration, 3600, 1e-9);
  });

  test("a file the toolchain cannot read gives null, not a thrown pane", async () => {
    const { runner, child } = makeRunner();
    // The failure is logged on purpose — that is the point of it. Swallowed
    // here so the suite output stays the suite output.
    const originalError = console.error;
    console.error = () => {};
    try {
      const promise = runner.probe("/vault/broken.mp4");
      await Promise.resolve();
      child().err("Invalid data\n");
      child().close(1);
      equal(await promise, null);
    } finally {
      console.error = originalError;
    }
  });
});

group("stills", () => {
  test("collects stdout as bytes, not as text", async () => {
    // A JPEG run through String() is a corrupt JPEG.
    const { runner, child } = makeRunner();
    const promise = runner.still("/vault/walk.mp4", 30, 90);
    await Promise.resolve();
    child().out(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    child().close(0);
    const buffer = await promise;
    ok(Buffer.isBuffer(buffer));
    equal(buffer[0], 0xff);
    equal(buffer[1], 0xd8);
  });

  test("a seek past the end is a gap in the strip, not a broken pane", async () => {
    const { runner, child } = makeRunner();
    const promise = runner.still("/vault/walk.mp4", 99999, 90);
    await Promise.resolve();
    child().close(1);
    equal(await promise, null);
  });
});

report("video-editor runner");
