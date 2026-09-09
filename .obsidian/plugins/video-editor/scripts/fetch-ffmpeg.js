/* Put ffmpeg and ffprobe in this plugin's bin/ folder.
 *
 *   node scripts/fetch-ffmpeg.js
 *
 * The binaries are git-ignored — 290 MB, platform-specific, and this vault is
 * the repository — so a fresh clone arrives with an empty bin/. This is the
 * one command that fills it.
 *
 * No npm: it downloads over node's own https and extracts with `tar`, which
 * Windows 10 and later ship as well as macOS and Linux. `tar -xf` reads zips
 * on Windows and .tar.xz elsewhere, so there is one code path rather than two.
 *
 * If this cannot reach the network, the fallback is unchanged and documented:
 * install ffmpeg however you normally would and leave it on PATH, or copy the
 * two executables into bin/ by hand.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin");

/* Where each platform's build comes from.
 *
 * BtbN's are the **gpl** builds on purpose: the lgpl ones omit libx264, which
 * is what the re-encode path asks for by name, so an lgpl build would install
 * cleanly and then fail the first exact cut.
 */
const SOURCES = {
  "win32-x64": {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    archive: "ffmpeg.zip",
    exe: ".exe",
  },
  "linux-x64": {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
    archive: "ffmpeg.tar.xz",
    exe: "",
  },
  "linux-arm64": {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
    archive: "ffmpeg.tar.xz",
    exe: "",
  },
};

function sourceFor(platform, arch) {
  const key = platform + "-" + arch;
  if (SOURCES[key]) return SOURCES[key];
  if (platform === "darwin") {
    throw new Error(
      "There is no single trustworthy macOS build to fetch automatically.\n" +
        "Run `brew install ffmpeg`, then either leave it on PATH or copy the two\n" +
        "binaries here:\n" +
        "  cp $(which ffmpeg) $(which ffprobe) " + BIN
    );
  }
  throw new Error(
    "No build is listed for " + key + ".\n" +
      "Install ffmpeg with your package manager and leave it on PATH, or copy\n" +
      "ffmpeg and ffprobe into " + BIN
  );
}

// Follows redirects by hand, because GitHub sends releases to a different host
// and node's https does not follow anything on its own.
function download(url, target, hops) {
  const left = hops === undefined ? 6 : hops;
  return new Promise((resolve, reject) => {
    if (left <= 0) {
      reject(new Error("too many redirects"));
      return;
    }
    https
      .get(url, { headers: { "user-agent": "obsidian-video-editor" } }, (response) => {
        const status = response.statusCode;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve(download(response.headers.location, target, left - 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error("the download answered " + status));
          return;
        }
        const total = Number(response.headers["content-length"]) || 0;
        let seen = 0;
        let shown = -1;
        const file = fs.createWriteStream(target);
        response.on("data", (chunk) => {
          seen += chunk.length;
          if (!total) return;
          const percent = Math.floor((seen / total) * 100 / 5) * 5;
          if (percent === shown) return;
          shown = percent;
          process.stdout.write("\r  " + percent + "%  " + Math.round(seen / 1048576) + " MB");
        });
        response.pipe(file);
        file.on("finish", () => file.close(() => {
          process.stdout.write("\n");
          resolve(target);
        }));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

// The two files, wherever in the extracted tree they landed.
function findBinaries(root, exe) {
  const wanted = ["ffmpeg" + exe, "ffprobe" + exe];
  const found = new Map();
  const walk = (dir, depth) => {
    if (depth > 5 || found.size === wanted.length) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (wanted.includes(entry.name) && !found.has(entry.name)) found.set(entry.name, full);
    }
  };
  walk(root, 0);
  return found;
}

/* Unpack the archive, with the one tar that can actually read it.
 *
 * Two things bit this on Windows, and both are worth naming because the error
 * each produces points nowhere near the cause:
 *
 *   - `tar` on PATH inside Git Bash is **GNU** tar, which cannot read a zip at
 *     all ("This does not look like a tar archive"). Windows 10 and later ship
 *     **bsdtar** at System32\\tar.exe, which can. So the Windows path is named
 *     explicitly rather than resolved through PATH.
 *   - GNU tar reads an absolute path beginning "C:" as a remote host called C
 *     and tries to open an rsh session to it. Naming the archive relatively,
 *     from cwd, leaves no colon to misread.
 *
 * PowerShell's Expand-Archive is the fallback, for a Windows old enough to
 * have no bsdtar.
 */
function extract(work, archive) {
  if (process.platform === "win32") {
    const bsdtar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(bsdtar)) {
      execFileSync(bsdtar, ["-xf", archive], { cwd: work, stdio: "inherit" });
      return;
    }
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "Expand-Archive -Path '" + archive + "' -DestinationPath '.' -Force"],
      { cwd: work, stdio: "inherit" }
    );
    return;
  }
  // Everywhere else the archive is a .tar.xz and any tar reads it.
  execFileSync("tar", ["-xf", archive], { cwd: work, stdio: "inherit" });
}

async function main() {
  const source = sourceFor(process.platform, process.arch);
  fs.mkdirSync(BIN, { recursive: true });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "video-editor-ffmpeg-"));
  const archive = path.join(work, source.archive);
  try {
    console.log("Fetching ffmpeg for " + process.platform + "-" + process.arch);
    console.log("  " + source.url);
    await download(source.url, archive);

    console.log("Extracting");
    extract(work, source.archive);

    const found = findBinaries(work, source.exe);
    if (found.size < 2) {
      throw new Error("the archive did not contain both ffmpeg and ffprobe");
    }
    for (const [name, from] of found) {
      const to = path.join(BIN, name);
      fs.copyFileSync(from, to);
      if (process.platform !== "win32") fs.chmodSync(to, 0o755);
      console.log("  " + name + "  " + Math.round(fs.statSync(to).size / 1048576) + " MB");
    }
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (error) {
      console.log("  (could not clear " + work + ")");
    }
  }

  console.log("\nDone. Reload Obsidian; the header badge should turn green.");
  console.log("Check it with:  node tests/smoke.js");
}

main().catch((error) => {
  console.error("\n" + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
