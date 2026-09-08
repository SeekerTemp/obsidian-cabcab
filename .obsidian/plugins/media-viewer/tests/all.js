// Runs every test file in this folder as its own process, so one suite's
// failure does not hide the next one's result.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.js"))
  .sort();

let failed = 0;
for (const name of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: "inherit" });
  if (result.status !== 0) failed += 1;
}

if (failed) {
  console.log(failed + " of " + files.length + " suites failed");
  process.exitCode = 1;
}
