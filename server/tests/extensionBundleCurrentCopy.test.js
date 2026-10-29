import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import express from "express";
import archiver from "archiver";
import unzipper from "unzipper";
import { fileURLToPath } from "url";
import {
  decodeExtensionBundle,
  encodeExtensionBundle,
  readExtensionFolder,
  refreshShippedExtensionCopies,
} from "../utils/embeddedExtension.js";

// Security audit R2-28 (2026-10-28): the Windows package (and the Linux
// tarball) put browser-extension/ and zomboid-panel-extension.zip next to
// the executable, and the in-app update replaces only the executable and
// client/dist. GET /api/mods/collection/extension-bundle preferred that
// zip, so an install updated in place kept handing out the extension it was
// first installed with -- past 1.5.0, a popup that still sent the panel
// password and the Steam cookies over plain http:// to any host. The
// binary now carries its own copy, the route zips that, and every start
// brings the copies next to the executable up to date.
//
// This replaces modsExtensionBundleStreamError.test.js: the route no longer
// streams a zip from disk, so the unlistened read-stream error it guarded
// can't happen; a failure building the zip is covered below instead.

const REPO_EXTENSION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../browser-extension",
);

// The route sits behind mods.manage; who may call it is not what this file
// is about.
vi.mock("../services/permissions.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requirePermission: () => (_req, _res, next) => next(),
}));

const { default: router } = await import("../routes/mods.js");

let server;
let port;
const temporaryDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-extension-bundle-"));
  temporaryDirs.push(dir);
  return dir;
}

function copyExtension(target, overrides = {}) {
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(REPO_EXTENSION)) {
    fs.copyFileSync(path.join(REPO_EXTENSION, name), path.join(target, name));
  }
  for (const [name, contents] of Object.entries(overrides)) {
    fs.writeFileSync(path.join(target, name), contents);
  }
}

function zipOf(entries) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip");
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const [name, contents] of Object.entries(entries)) archive.append(contents, { name });
    void archive.finalize();
  });
}

async function unzip(buffer) {
  const directory = await unzipper.Open.buffer(buffer);
  const files = {};
  for (const entry of directory.files) files[entry.path] = (await entry.buffer()).toString("utf8");
  return files;
}

function download() {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/api/mods/collection/extension-bundle" }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
}

beforeAll(async () => {
  const app = express();
  app.use("/api/mods", router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.pkg;
  delete globalThis.PANEL_BROWSER_EXTENSION_B64;
});

describe("GET /api/mods/collection/extension-bundle serves the extension this version ships (R2-28)", () => {
  it("zips the current extension, not a stale zomboid-panel-extension.zip left next to the install", async () => {
    const install = tempDir();
    copyExtension(path.join(install, "browser-extension"));
    fs.writeFileSync(
      path.join(install, "zomboid-panel-extension.zip"),
      await zipOf({ "manifest.json": "{}", "popup.js": "// the popup from before 1.5.0" }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(install);

    const res = await download();

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    const files = await unzip(res.body);
    expect(files["popup.js"]).toBe(fs.readFileSync(path.join(REPO_EXTENSION, "popup.js"), "utf8"));
    expect(files["urlPolicy.js"]).toBe(fs.readFileSync(path.join(REPO_EXTENSION, "urlPolicy.js"), "utf8"));
  });

  it("in the packaged panel, serves the copy inside the executable, not the folder an update left behind", async () => {
    const current = tempDir();
    copyExtension(current, { "popup.js": "// this version's popup" });
    const install = tempDir();
    copyExtension(path.join(install, "browser-extension"), { "popup.js": "// the popup from before 1.5.0" });
    process.pkg = {};
    vi.spyOn(process, "execPath", "get").mockReturnValue(path.join(install, "ZomboidControlPanel.exe"));
    globalThis.PANEL_BROWSER_EXTENSION_B64 = encodeExtensionBundle(current);

    const files = await unzip((await download()).body);

    expect(files["popup.js"]).toBe("// this version's popup");
  });

  it("answers 500, without bringing the panel down, when its copy can't be read", async () => {
    process.pkg = {};
    globalThis.PANEL_BROWSER_EXTENSION_B64 = Buffer.from("not a bundle").toString("base64");

    const res = await download();

    expect(res.status).toBe(500);
  });

  it("answers 404 when there is no extension anywhere", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(path.join(tempDir(), "deep", "er"));

    expect((await download()).status).toBe(404);
  });
});

describe("refreshShippedExtensionCopies(): the copies next to the executable (R2-28)", () => {
  it("brings a stale folder and zip up to this version, then leaves them alone", async () => {
    const current = tempDir();
    copyExtension(current, { "popup.js": "// this version's popup" });
    const files = readExtensionFolder(current);
    const exeDir = tempDir();
    copyExtension(path.join(exeDir, "browser-extension"), { "popup.js": "// the popup from before 1.5.0" });
    fs.writeFileSync(path.join(exeDir, "zomboid-panel-extension.zip"), await zipOf({ "popup.js": "// old" }));

    const changed = await refreshShippedExtensionCopies(exeDir, files);

    expect(changed).toEqual({ folderFiles: ["popup.js"], zip: true });
    expect(fs.readFileSync(path.join(exeDir, "browser-extension", "popup.js"), "utf8")).toBe("// this version's popup");
    const zipped = await unzip(fs.readFileSync(path.join(exeDir, "zomboid-panel-extension.zip")));
    expect(zipped["popup.js"]).toBe("// this version's popup");
    expect(Object.keys(zipped).sort()).toEqual([...files.keys()].sort());

    expect(await refreshShippedExtensionCopies(exeDir, files)).toEqual({ folderFiles: [], zip: false });
  });

  it("creates neither copy where the install has none", async () => {
    const exeDir = tempDir();
    await refreshShippedExtensionCopies(exeDir, readExtensionFolder(REPO_EXTENSION));
    expect(fs.readdirSync(exeDir)).toEqual([]);
  });

  it("does nothing in development or Docker, where there is no embedded copy", async () => {
    const exeDir = tempDir();
    copyExtension(path.join(exeDir, "browser-extension"), { "popup.js": "// local edit" });
    expect(await refreshShippedExtensionCopies(exeDir)).toEqual({ folderFiles: [], zip: false });
    expect(fs.readFileSync(path.join(exeDir, "browser-extension", "popup.js"), "utf8")).toBe("// local edit");
  });

  // Adversary pass: a link planted where the folder or a file was must not
  // turn the refresh into a write somewhere else.
  it("never writes through a link standing in for the folder", async () => {
    const elsewhere = tempDir();
    fs.writeFileSync(path.join(elsewhere, "popup.js"), "// not the panel's");
    const exeDir = tempDir();
    fs.symlinkSync(elsewhere, path.join(exeDir, "browser-extension"), "junction");

    await refreshShippedExtensionCopies(exeDir, readExtensionFolder(REPO_EXTENSION));

    expect(fs.readdirSync(elsewhere)).toEqual(["popup.js"]);
    expect(fs.readFileSync(path.join(elsewhere, "popup.js"), "utf8")).toBe("// not the panel's");
  });

  it("replaces a link standing in for a file instead of writing through it", async (context) => {
    const outside = path.join(tempDir(), "target.txt");
    fs.writeFileSync(outside, "outside");
    const exeDir = tempDir();
    copyExtension(path.join(exeDir, "browser-extension"));
    const link = path.join(exeDir, "browser-extension", "popup.js");
    fs.rmSync(link);
    try {
      fs.symlinkSync(outside, link, "file");
    } catch {
      context.skip(); // Windows without the symlink privilege
    }

    await refreshShippedExtensionCopies(exeDir, readExtensionFolder(REPO_EXTENSION));

    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, "utf8")).toBe(fs.readFileSync(path.join(REPO_EXTENSION, "popup.js"), "utf8"));
  });
});

describe("the embedded copy (build.js -> PANEL_BROWSER_EXTENSION_B64)", () => {
  it("round-trips the real extension folder", () => {
    const decoded = decodeExtensionBundle(encodeExtensionBundle(REPO_EXTENSION));
    for (const name of ["manifest.json", "popup.html", "urlPolicy.js", "popup.js"]) {
      expect(decoded.get(name).equals(fs.readFileSync(path.join(REPO_EXTENSION, name))), name).toBe(true);
    }
  });

  it("is wired into the executable build", () => {
    const build = fs.readFileSync(path.join(REPO_EXTENSION, "..", "build.js"), "utf8");
    expect(build).toMatch(/PANEL_BROWSER_EXTENSION_B64: JSON\.stringify\(browserExtensionB64\)/);
    expect(build).toMatch(/encodeExtensionBundle\("\.\/browser-extension"\)/);
  });

  it("refuses a bundle holding any other file name, or missing one popup.html loads", async () => {
    const { gzipSync } = await import("zlib");
    const encode = (files) => gzipSync(Buffer.from(JSON.stringify({ schemaVersion: 1, files }))).toString("base64");
    const base = { "manifest.json": "e30=", "popup.html": "", "urlPolicy.js": "", "popup.js": "" };
    expect(() => decodeExtensionBundle(encode({ ...base, "../evil.js": "" }))).toThrow(/unexpected file/);
    expect(() => decodeExtensionBundle(encode({ ...base, "__proto__/x": "" }))).toThrow(/unexpected file/);
    const { "urlPolicy.js": _missing, ...withoutPolicy } = base;
    expect(() => decodeExtensionBundle(encode(withoutPolicy))).toThrow(/missing urlPolicy\.js/);
    expect(() => encodeExtensionBundle(tempDir())).toThrow(/missing one of/);
  });
});
