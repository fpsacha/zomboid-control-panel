import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  isWindowsNetworkPath,
  realpathOrNearest,
  untrustedFolderReason,
} from "../utils/untrustedFolder.js";
import { normalizeUserPath } from "../utils/zomboidPaths.js";

// SECURITY (2026-10-28, R2-13 review): realpathOrNearest() climbed a path one
// folder at a time, each step a realpath of the whole remaining string, so a
// deep path from a request (server.install's paths, Map Cleanup's custom
// path) cost the square of its depth in synchronous work. It now halves its
// way to the longest existing part. normalizeUserPath()'s ${VAR} pattern was
// quadratic on "${${${..." in the same way.

const BS = String.fromCharCode(92);

// The walk as it was: the reference result for the halving one.
function climbOneByOne(target) {
  const rest = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

let root;
let nativeCalls;

function countNativeCalls() {
  nativeCalls = 0;
  const original = fs.realpathSync.native;
  vi.spyOn(fs.realpathSync, "native").mockImplementation((p, ...rest) => {
    nativeCalls++;
    // Past this the old walk is cut short so the test fails fast instead of
    // running for seconds.
    if (nativeCalls > 300) return String(p);
    return original.call(fs.realpathSync, p, ...rest);
  });
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "untrusted-bound-")));
  fs.mkdirSync(path.join(root, "game", "Zomboid"), { recursive: true });
  fs.mkdirSync(path.join(root, "steamapps", "workshop", "content", "108600", "1"), { recursive: true });
  fs.symlinkSync(
    path.join(root, "steamapps", "workshop", "content", "108600", "1"),
    path.join(root, "link"),
    "junction",
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("realpathOrNearest", () => {
  it("returns what the one-by-one climb returned", () => {
    const cases = [
      root,
      path.join(root, "game", "Zomboid"),
      path.join(root, "game", "missing", "deeper", "still"),
      path.join(root, "missing"),
      path.join(root, "link"),
      path.join(root, "link", "x", "y"),
      path.join(root, "game", "Zomboid", "..", "Zomboid", "z"),
      path.join(root, "game") + path.sep,
    ];
    if (process.platform === "win32") cases.push(`Q:${BS}zcp-missing${BS}a`, `${root.toUpperCase()}${BS}GAME${BS}nope`);
    for (const target of cases) {
      expect(realpathOrNearest(target)).toBe(climbOneByOne(target));
    }
  });

  it("finds the existing part of a 16000-folder-deep path with a few dozen realpath calls", () => {
    const tail = `${path.sep}a`.repeat(16000);
    const expected = path.join(root, "game", ...tail.split(path.sep).filter(Boolean));
    countNativeCalls();
    const started = Date.now();
    expect(realpathOrNearest(path.join(root, "game") + tail)).toBe(expected);
    expect(nativeCalls).toBeLessThanOrEqual(40);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("takes a path longer than any OS opens as written", () => {
    const target = path.join(root, "game") + `${path.sep}a`.repeat(20000);
    countNativeCalls();
    expect(realpathOrNearest(target)).toBe(path.resolve(target));
    expect(nativeCalls).toBe(0);
  });

  // Adversary pass: depth doesn't hide a link into the Workshop tree.
  it("a link into steamapps/workshop under a deep missing tail is still found", () => {
    const target = path.join(root, "link") + `${path.sep}x`.repeat(3000);
    countNativeCalls();
    expect(untrustedFolderReason(target, { windows: false })).toBe("workshop");
    expect(nativeCalls).toBeLessThanOrEqual(40);
  });
});

describe("isWindowsNetworkPath", () => {
  it.each([
    [`${BS}${BS}host${BS}share`, true],
    ["//host/share", true],
    [`  ${BS}${BS}host${BS}share  `, true],
    [`${BS}${BS}?${BS}UNC${BS}host${BS}share`, true],
    [`${BS}${BS}.${BS}pipe${BS}x`, true],
    [`C:${BS}Users${BS}x`, false],
    ["relative", false],
    ["", false],
    [null, false],
  ])("%s -> %s, without touching the file system", (value, expected) => {
    countNativeCalls();
    const exists = vi.spyOn(fs, "existsSync");
    const stat = vi.spyOn(fs, "statSync");
    expect(isWindowsNetworkPath(value)).toBe(expected);
    expect(nativeCalls).toBe(0);
    expect(exists).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });
});

describe("normalizeUserPath", () => {
  afterEach(() => {
    delete process.env.ZCP_BOUND_TEST;
  });

  it("expands ${VAR} in time linear in the input", () => {
    const started = Date.now();
    normalizeUserPath("${".repeat(30000));
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("still expands ${VAR}, %VAR% and $VAR", () => {
    process.env.ZCP_BOUND_TEST = "value";
    expect(normalizeUserPath("${ZCP_BOUND_TEST}/x")).toBe("value/x");
    expect(normalizeUserPath("%ZCP_BOUND_TEST%/x")).toBe("value/x");
    expect(normalizeUserPath("$ZCP_BOUND_TEST/x")).toBe("value/x");
    expect(normalizeUserPath("${MISSING_ZCP_BOUND}/x")).toBe("${MISSING_ZCP_BOUND}/x");
  });
});
