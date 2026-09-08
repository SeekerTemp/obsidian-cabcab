// Loads ../main.js with `require("obsidian")` redirected to the stub, and
// returns the module. Used by every test file.
const path = require("path");
const Module = require("module");

const stubPath = path.join(__dirname, "stub-obsidian.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "obsidian") return stubPath;
  return originalResolve.call(this, request, ...rest);
};

module.exports = require(path.join(__dirname, "..", "main.js"));
