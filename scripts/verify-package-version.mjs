import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const minimumMode = args[0] === "--minimum";
const expectedInput = minimumMode ? args[1] : args[0];
// A version argument that is there but empty (an unset variable, such as
// "$GITHUB_REF_NAME" read by PowerShell) must fail, not skip the comparison.
if ((minimumMode || args.length > 0) && !String(expectedInput ?? "").trim()) {
  throw new Error("The expected package version argument is empty");
}
const expectedVersion = expectedInput ? String(expectedInput).replace(/^v/, "") : null;
const semverPattern = /^\d+\.\d+\.\d+$/;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), "utf8"));
}

function parseVersion(version, label) {
  const normalized = String(version ?? "");
  if (!semverPattern.test(normalized)) {
    throw new Error(`${label} is not a numeric SemVer: ${normalized || "missing"}`);
  }
  return normalized.split(".").map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left, "Current package version");
  const rightParts = parseVersion(right, "Expected package version");
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

const rootPackage = readJson("package.json");
const rootLock = readJson("package-lock.json");
const clientPackage = readJson("client/package.json");
const clientLock = readJson("client/package-lock.json");
const versions = [
  ["package.json", rootPackage.version],
  ["package-lock.json", rootLock.version],
  ["package-lock.json root package", rootLock.packages?.[""]?.version],
  ["client/package.json", clientPackage.version],
  ["client/package-lock.json", clientLock.version],
  ["client/package-lock.json root package", clientLock.packages?.[""]?.version],
];
const currentVersion = String(versions[0][1] ?? "");
parseVersion(currentVersion, "package.json");

for (const [label, version] of versions) {
  if (version !== currentVersion) {
    throw new Error(`${label} is ${version ?? "missing"}, expected ${currentVersion}`);
  }
}

if (expectedVersion) {
  parseVersion(expectedVersion, "Expected package version");
  const matchesExpectation = minimumMode
    ? compareVersions(currentVersion, expectedVersion) >= 0
    : currentVersion === expectedVersion;
  if (!matchesExpectation) {
    const relation = minimumMode ? "at least" : "exactly";
    throw new Error(`Package version is ${currentVersion}, expected ${relation} ${expectedVersion}`);
  }
}

console.log(`Package version parity verified: ${currentVersion}`);