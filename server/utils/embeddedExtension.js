// The Steam Sync browser extension (browser-extension/) as this panel
// version ships it.
//
// SECURITY (2026-10-28, audit R2-28): the Windows package and the Linux
// tarball put browser-extension/ (and, on Windows, zomboid-panel-extension.zip)
// next to the executable, and the in-app update replaces only the
// executable and client/dist. GET /api/mods/collection/extension-bundle
// preferred that zip, so an install updated in place kept handing out the
// extension it was first installed with: past 1.5.0, a popup that still
// sent the panel password and the Steam cookies over plain http:// to any
// host. The binary now carries its own copy (PANEL_BROWSER_EXTENSION_B64,
// written by build.js), the bundle route zips that, and every start brings
// the copies next to the executable up to date (refreshShippedExtensionCopies()).

import fs from "fs";
import path from "path";
import { gunzipSync, gzipSync } from "zlib";
import archiver from "archiver";

// Every file popup.html loads must be listed: a missing urlPolicy.js would
// leave the popup unable to send anything.
export const EXTENSION_FILES = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "urlPolicy.js",
  "popup.js",
  "README.md",
];
const REQUIRED_FILES = ["manifest.json", "popup.html", "urlPolicy.js", "popup.js"];

export const EXTENSION_FOLDER_NAME = "browser-extension";
export const EXTENSION_ZIP_NAME = "zomboid-panel-extension.zip";

// One fixed time for every zip entry: the same files give the same bytes,
// so a start can tell whether the zip next to the executable is current.
const ZIP_ENTRY_DATE = new Date(Date.UTC(2020, 0, 1));

// The files of an extension folder, or null when one popup.html needs is
// missing. Map: file name -> contents.
export function readExtensionFolder(dir) {
  const files = new Map();
  for (const name of EXTENSION_FILES) {
    let contents;
    try {
      contents = fs.readFileSync(path.join(dir, name));
    } catch {
      if (REQUIRED_FILES.includes(name)) return null;
      continue;
    }
    files.set(name, contents);
  }
  return files;
}

// build.js: the folder as one base64 string for the esbuild define. Throws
// when a required file is missing, so the build fails rather than shipping
// an executable that hands out a broken extension.
export function encodeExtensionBundle(dir) {
  const files = readExtensionFolder(dir);
  if (!files) {
    throw new Error(`${dir} is missing one of ${REQUIRED_FILES.join(", ")}`);
  }
  const encoded = {};
  for (const [name, contents] of files) encoded[name] = contents.toString("base64");
  return gzipSync(Buffer.from(JSON.stringify({ schemaVersion: 1, files: encoded }), "utf8")).toString("base64");
}

// Only the listed names, with every required one: whatever else a bundle
// holds is refused, never written or served.
export function decodeExtensionBundle(encoded) {
  if (!encoded) return null;
  const bundle = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
  if (!bundle || bundle.schemaVersion !== 1 || !bundle.files || typeof bundle.files !== "object") {
    throw new Error("Embedded browser extension is invalid");
  }
  const files = new Map();
  for (const [name, contents] of Object.entries(bundle.files)) {
    if (!EXTENSION_FILES.includes(name) || typeof contents !== "string") {
      throw new Error(`Embedded browser extension holds an unexpected file: ${name}`);
    }
    files.set(name, Buffer.from(contents, "base64"));
  }
  for (const name of REQUIRED_FILES) {
    if (!files.has(name)) throw new Error(`Embedded browser extension is missing ${name}`);
  }
  // In EXTENSION_FILES order, whatever order the bundle had.
  return new Map(EXTENSION_FILES.filter((name) => files.has(name)).map((name) => [name, files.get(name)]));
}

// The copy inside a packaged executable, or null (development, Docker).
export function getEmbeddedExtensionFiles() {
  const encoded =
    typeof PANEL_BROWSER_EXTENSION_B64 !== "undefined" ? PANEL_BROWSER_EXTENSION_B64 : "";
  return decodeExtensionBundle(encoded);
}

// The extension this panel version ships: the executable's own copy, else
// the source folder (development, Docker), never a prebuilt zip lying next
// to the install.
export function loadCurrentExtensionFiles({
  embedded = getEmbeddedExtensionFiles(),
  baseDir = typeof process.pkg !== "undefined" ? path.dirname(process.execPath) : process.cwd(),
} = {}) {
  if (embedded) return embedded;
  for (const dir of [path.join(baseDir, EXTENSION_FOLDER_NAME), path.join(baseDir, "..", EXTENSION_FOLDER_NAME)]) {
    const files = readExtensionFolder(dir);
    if (files) return files;
  }
  return null;
}

export function zipExtensionFiles(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("warning", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    for (const [name, contents] of files) {
      archive.append(contents, { name, date: ZIP_ENTRY_DATE });
    }
    archive.finalize().catch(reject);
  });
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

// A fresh temporary file renamed over the target: a link at the target is
// replaced, never written through.
function replaceFile(target, contents) {
  const temporary = `${target}.update-${process.pid}`;
  try {
    fs.unlinkSync(temporary);
  } catch {
    /* nothing left over */
  }
  fs.writeFileSync(temporary, contents, { flag: "wx" });
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* already gone */
    }
    throw error;
  }
}

// Brings browser-extension/ and zomboid-panel-extension.zip next to the
// executable up to the version it carries. Only copies the install already
// has (never creates them), only a real folder and a real file (a link is
// left alone), and only what differs. Returns what it changed.
export async function refreshShippedExtensionCopies(exeDir, files = getEmbeddedExtensionFiles()) {
  const changed = { folderFiles: [], zip: false };
  if (!files) return changed;

  const folder = path.join(exeDir, EXTENSION_FOLDER_NAME);
  const folderStat = lstatOrNull(folder);
  if (folderStat?.isDirectory()) {
    for (const [name, contents] of files) {
      const target = path.join(folder, name);
      const stat = lstatOrNull(target);
      if (stat && !stat.isFile() && !stat.isSymbolicLink()) continue;
      if (stat?.isFile() && fs.readFileSync(target).equals(contents)) continue;
      replaceFile(target, contents);
      changed.folderFiles.push(name);
    }
  }

  const zipPath = path.join(exeDir, EXTENSION_ZIP_NAME);
  if (lstatOrNull(zipPath)?.isFile()) {
    const zip = await zipExtensionFiles(files);
    if (!fs.readFileSync(zipPath).equals(zip)) {
      replaceFile(zipPath, zip);
      changed.zip = true;
    }
  }
  return changed;
}
