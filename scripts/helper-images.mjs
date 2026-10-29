// The helper images the Docker publish workflows run, by digest.
//
// .github/helper-images/Dockerfile pins them as `FROM <image>:<tag>@sha256:<digest> AS <name>`
// (the form Dependabot's docker ecosystem updates). This prints one
// `<name>=<image>@sha256:<digest>` line per image for $GITHUB_OUTPUT, and
// fails unless both binfmt and buildkit are pinned that way: the workflows
// would otherwise fall back to the actions' moving default tags.
//
// Usage: node scripts/helper-images.mjs [path/to/Dockerfile]

import fs from "node:fs";
import process from "node:process";

const REQUIRED = ["binfmt", "buildkit"];
const FROM = /^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/i;
const PINNED = /^([a-z0-9][a-z0-9./_-]*):[\w][\w.-]*@(sha256:[0-9a-f]{64})$/;

const file = process.argv[2] || ".github/helper-images/Dockerfile";
const pins = new Map();
for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!/^FROM\s/i.test(line)) continue;
  const from = FROM.exec(line.trim());
  const pinned = from && PINNED.exec(from[1]);
  if (!pinned) {
    console.error(`${file}: not a 'FROM <image>:<tag>@sha256:<digest> AS <name>' line: ${line.trim()}`);
    process.exit(1);
  }
  const name = from[2].toLowerCase();
  if (pins.has(name)) {
    console.error(`${file}: ${name} is pinned twice.`);
    process.exit(1);
  }
  pins.set(name, `${pinned[1]}@${pinned[2]}`);
}

const missing = REQUIRED.filter((name) => !pins.has(name));
if (missing.length > 0) {
  console.error(`${file}: no pinned ${missing.join(", ")} image.`);
  process.exit(1);
}
for (const name of REQUIRED) console.log(`${name}=${pins.get(name)}`);
