// A test runner small enough to read in one sitting. node:test would do the
// same job, but this keeps the output format under our control and matches the
// zero-dependency shape of the plugin itself.
const results = { passed: 0, failed: 0, failures: [] };
let currentGroup = "";

function group(name, body) {
  currentGroup = name;
  body();
  currentGroup = "";
}

function test(name, body) {
  const label = currentGroup ? currentGroup + " > " + name : name;
  try {
    body();
    results.passed += 1;
  } catch (error) {
    results.failed += 1;
    results.failures.push({ label, message: error && error.message ? error.message : String(error) });
  }
}

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value) || (value && typeof value === "object")) return JSON.stringify(value);
  return String(value);
}

function equal(actual, expected, note) {
  const same = Object.is(actual, expected);
  if (!same) {
    throw new Error(
      (note ? note + ": " : "") + "expected " + show(expected) + ", got " + show(actual)
    );
  }
}

function deepEqual(actual, expected, note) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error((note ? note + ": " : "") + "expected " + b + ", got " + a);
  }
}

function ok(value, note) {
  if (!value) throw new Error((note || "expected truthy") + ", got " + show(value));
}

function close(actual, expected, tolerance, note) {
  const limit = typeof tolerance === "number" ? tolerance : 1e-9;
  if (!(Math.abs(Number(actual) - Number(expected)) <= limit)) {
    throw new Error(
      (note ? note + ": " : "") + "expected " + expected + " +/- " + limit + ", got " + actual
    );
  }
}

// Called at the end of a test file. Exits non-zero on failure so the command
// line, and anything driving it, sees the result rather than having to read it.
function report(title) {
  const total = results.passed + results.failed;
  if (results.failed) {
    console.log("");
    for (const failure of results.failures) {
      console.log("FAIL  " + failure.label);
      console.log("      " + failure.message);
    }
    console.log("");
    console.log(title + ": " + results.passed + "/" + total + " passed, " + results.failed + " failed");
    process.exitCode = 1;
    return;
  }
  console.log(title + ": " + results.passed + "/" + total + " passed");
}

module.exports = { group, test, equal, deepEqual, ok, close, report };
