// Whether a release tag may move the Docker image's moving tags.
//
// docker-publish.yml publishes `latest` and the `<major>.<minor>` alias
// from release tags. Re-running an older tag's run (or a manual run on an
// older tag) must not point them back at that older image: users who pull
// `latest` would silently lose every fix since. This prints, for
// $GITHUB_OUTPUT:
//   latest=true|false   the tag is the highest vX.Y.Z release tag
//   minor=true|false    the tag is the highest one of its <major>.<minor>
//
// Usage: git tag --list 'v*' | node scripts/newest-release-tag.mjs <tag>
//
// Only vX.Y.Z tags count as releases (old v0.1.0-alpha or v0.8.5.2 tags
// don't). The tag itself must be in the list: a checkout that didn't fetch
// tags would otherwise make every tag look like the newest.

import fs from "node:fs";
import process from "node:process";

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function parse(tag) {
  const match = RELEASE_TAG.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const tag = String(process.argv[2] ?? "").trim();
const own = parse(tag);
if (!own) {
  console.error(`${tag || "(no tag)"} is not a vX.Y.Z release tag.`);
  process.exit(1);
}

const listed = fs.readFileSync(0, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
if (!listed.includes(tag)) {
  console.error(`${tag} is not among the repository's tags; were the tags fetched?`);
  process.exit(1);
}

const releases = listed.map(parse).filter(Boolean);
const latest = releases.every((other) => compare(own, other) >= 0);
const minor = releases
  .filter((other) => other[0] === own[0] && other[1] === own[1])
  .every((other) => compare(own, other) >= 0);

console.log(`latest=${latest}`);
console.log(`minor=${minor}`);
