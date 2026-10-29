import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// SECURITY (2026-10-28, sec2 leftover): GET /api/debug/diagnostics runs the
// active server's bundled <install>/jre64/bin/java -version. A server start
// refuses an install folder inside a Steam Workshop download folder or on a
// Windows network share (utils/untrustedFolder.js: anyone can supply its
// files), but an install folder saved before that rule is still stored, and
// the diagnostics ran its java anyway: a diagnostics.manage holder then ran a
// program of the Workshop author's choosing on this computer.

const activeServer = vi.hoisted(() => ({ current: null }));
const execFileCalls = vi.hoisted(() => []);

vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return {
    ...actual,
    getRoleByName: mockGetRoleByName,
    getActiveServer: async () => activeServer.current,
  };
});

vi.mock("child_process", async () => {
  const actual = await vi.importActual("child_process");
  const execFile = (file, args, ...rest) => {
    execFileCalls.push([file, args]);
    const callback = rest.find((arg) => typeof arg === "function");
    const err = Object.assign(new Error("not run in tests"), { code: "ENOENT" });
    if (callback) setImmediate(() => callback(err, "", ""));
    return { kill() {}, on() {} };
  };
  return { ...actual, default: { ...actual, execFile }, execFile };
});

const { default: router, findBundledJavaToProbe } = await import("../routes/debug.js");

async function runDiagnostics() {
  const layer = router.stack.find((entry) => entry.route?.path === "/diagnostics" && entry.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  let body = null;
  const res = {
    status: () => res,
    json: (payload) => {
      body = payload;
      return res;
    },
    setHeader: () => res,
  };
  await handler({ user: { role: "admin" }, query: {}, app: { get: () => undefined } }, res);
  return body;
}

const javaRel = process.platform === "win32" ? ["jre64", "bin", "java.exe"] : ["jre64", "bin", "java"];
const roots = [];

function installWithJava(...segments) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-java-probe-"));
  roots.push(root);
  const install = path.join(root, ...segments);
  fs.mkdirSync(path.join(install, ...javaRel.slice(0, -1)), { recursive: true });
  fs.writeFileSync(path.join(install, ...javaRel), "not really java");
  return install;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("the diagnostics Java probe", () => {
  it("GET /diagnostics doesn't run java from a stored Workshop install folder, and still runs an ordinary one", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in tests");
    });
    const workshop = installWithJava("steamapps", "workshop", "content", "108600", "3809901056");
    activeServer.current = { id: 1, name: "Legacy", installPath: workshop };
    execFileCalls.length = 0;
    expect(await runDiagnostics()).toBeTruthy();
    expect(execFileCalls.filter(([file]) => String(file).startsWith(workshop))).toEqual([]);

    const ordinary = installWithJava("pzserver");
    activeServer.current = { id: 1, name: "Ordinary", installPath: ordinary };
    execFileCalls.length = 0;
    await runDiagnostics();
    expect(execFileCalls.filter(([file]) => String(file).startsWith(ordinary))).toEqual([
      [path.join(ordinary, ...javaRel), ["-version"]],
    ]);
  }, 60000);

  it("never runs java from a Steam Workshop download folder", async () => {
    const install = installWithJava("steamapps", "workshop", "content", "108600", "3809901056");
    expect(await findBundledJavaToProbe(install)).toBeNull();
  });

  // Adversary pass: a link whose own path says nothing about the Workshop
  // still leads into it.
  it("never runs java from a link into a Workshop folder", async () => {
    const install = installWithJava("steamapps", "workshop", "content", "108600", "1");
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zcp-java-link-")), "pzserver");
    roots.push(path.dirname(link));
    fs.symlinkSync(install, link, "junction");
    expect(await findBundledJavaToProbe(link)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("never touches a network share", async () => {
    const access = vi.spyOn(fs.promises, "access");
    expect(await findBundledJavaToProbe("\\\\attacker\\share\\pzserver")).toBeNull();
    expect(await findBundledJavaToProbe("//attacker/share/pzserver")).toBeNull();
    expect(access).not.toHaveBeenCalled();
  });

  it("still finds the bundled java of an ordinary install", async () => {
    const install = installWithJava("pzserver");
    expect(await findBundledJavaToProbe(install)).toBe(path.join(install, ...javaRel));
  });
});
