import { describe, expect, it } from "vitest";
import {
  findServerErrors,
  matchLuaFileError,
  parseCausedByLine,
  parseEntry,
  parseExceptionLine,
  parseFrameLine,
} from "../utils/serverErrorFinder.js";

// SECURITY (2026-10-28): Diagnostics > Problems found reads the game's
// server-console.txt on the panel's main thread, and a Workshop mod's Lua
// print() writes whatever text it likes there. The patterns that read each
// line used to backtrack, so one crafted line froze the whole panel (HTTP,
// Socket.IO, the scheduler, the Discord bot) for minutes. Every hostile
// shape below took seconds with those patterns and must take well under a
// second now; the readers that replaced them must read every ordinary line
// exactly as the old patterns did (checked against them at the bottom).

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LIMIT_MS = 1000;

function timed(fn) {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

function scanText(lines) {
  return findServerErrors({
    logs: [{ text: lines.join("\n") }],
    logMtime: new Date(),
    server: { id: 1, running: true, isRemote: false, maxMemoryGb: 4, hostMemoryGb: 16, defaultPort: 16261 },
  });
}

const ENTRY = "ERROR: General      f:0, t:1774895897563, st:0>";
const repeat = (n, line) => Array.from({ length: n }, () => line);

describe("Problems found reads hostile console lines quickly", () => {
  it("an entry line with no '> ' (100 KB)", () => {
    const { ms } = timed(() => scanText(["ERROR: " + "a".repeat(100_000)]));
    expect(ms).toBeLessThan(LIMIT_MS);
    const direct = timed(() => parseEntry("ERROR: " + "a".repeat(100_000)));
    expect(direct.value).toBeNull();
    expect(direct.ms).toBeLessThan(LIMIT_MS);
  });

  it("an entry line of '> ' pairs that ends in a line separator (60 KB)", () => {
    const line = "ERROR: x" + "> ".repeat(30_000) + LS;
    expect(timed(() => scanText([line])).ms).toBeLessThan(LIMIT_MS);
    const direct = timed(() => parseEntry(line));
    expect(direct.value).toBeNull();
    expect(direct.ms).toBeLessThan(LIMIT_MS);
  });

  it("Lua stack frames with a long run of spaces after MOD:", () => {
    const block = [
      `${ENTRY} KahluaThread.flushErrorMessage      > dumping Lua stack trace`,
      ...repeat(40, "function: f -- file: a.lua line # 1 | MOD: a" + " ".repeat(4000) + "b"),
    ];
    const { value, ms } = timed(() => scanText([...block, ...block, ...block, ...block]));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(value.findings.some((f) => f.kind === "luaError")).toBe(true);
  });

  it("exception lines with a long run of spaces in the message", () => {
    const block = [
      `${ENTRY} ExceptionLogger.logException> Exception thrown`,
      ...repeat(6, "\ta.bException: x" + " ".repeat(4000) + "y"),
    ];
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(...block);
    const { value, ms } = timed(() => scanText(lines));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(value.findings.some((f) => f.kind === "javaException")).toBe(true);
  });

  it("Caused by: lines with a long run of spaces after a Lua error", () => {
    const block = [
      `${ENTRY} KahluaThread.flushErrorMessage      > dumping Lua stack trace`,
      "function: f -- file: a.lua line # 1 | Vanilla",
      `${ENTRY} ExceptionLogger.logException> Exception thrown`,
      ...repeat(120, "\tCaused by: a.b x" + " ".repeat(4000) + "y"),
    ];
    expect(timed(() => scanText([...block, ...block])).ms).toBeLessThan(LIMIT_MS);
  });

  it("'Error found in LUA file' lines with a long run of spaces", () => {
    const lines = repeat(80, "Error found in LUA file: ".repeat(19) + "x" + " ".repeat(3500) + "y");
    expect(timed(() => scanText(lines)).ms).toBeLessThan(LIMIT_MS);
  });

  it("'Error found in LUA file' lines naming a path of slashes", () => {
    const lines = repeat(5000, "Error found in LUA file: " + "/".repeat(499) + "x");
    const { value, ms } = timed(() => scanText(lines));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(value.findings.some((f) => f.kind === "luaFileError")).toBe(true);
  });

  it("error lines whose sample has a long run of spaces before its end", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${ENTRY} x${i}` + " ".repeat(4000) + "y");
    const { value, ms } = timed(() => scanText(lines));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(value.findings.length).toBeGreaterThan(0);
  });

  // Adversary: a line break left inside a line, under the length cut.
  it("lines under the length cut that hide a carriage return", () => {
    const lines = repeat(200, "ERROR: x" + "> ".repeat(2000) + "\rz");
    expect(timed(() => scanText(lines)).ms).toBeLessThan(LIMIT_MS);
  });

  // Adversary: the readers on their own, with no length cut in front of them.
  it("each line reader takes linear time on a 1 MB line", () => {
    const MB = 1_000_000;
    const cases = [
      () => parseFrameLine("function: f -- file: a line # 1 | MOD: a" + " ".repeat(MB) + "b"),
      () => parseFrameLine("function: " + " -- file: x line # y".repeat(MB / 20)),
      () => parseFrameLine("function: f -- file: a" + " line # 1x".repeat(MB / 10)),
      () => parseExceptionLine("a.bException: x" + " ".repeat(MB) + "y"),
      () => parseExceptionLine("a.bException: x" + " at x(".repeat(MB / 6) + ")"),
      () => parseExceptionLine("a.bException: x" + "Xat x(".repeat(MB / 6) + ")"),
      () => parseExceptionLine("a.bException" + " ".repeat(MB) + "at x(" + "(".repeat(MB) + ")"),
      () => parseExceptionLine("a." + "b.".repeat(MB / 2) + "cException: x"),
      () => parseCausedByLine("Caused by: a.b x" + " ".repeat(MB) + "y"),
      () => matchLuaFileError("Error found in LUA file: x" + " ".repeat(MB) + "y"),
      () => matchLuaFileError("Error found in LUA file: ".repeat(MB / 25)),
      () => parseEntry("[x]" + " ".repeat(MB) + "Q"),
      () => parseEntry("ERROR: x" + "> ".repeat(MB / 2) + PS),
    ];
    for (const run of cases) expect(timed(run).ms).toBeLessThan(LIMIT_MS);
  });

  it("a 1 MB line", () => {
    const { ms } = timed(() => scanText([`${ENTRY} ok`, "ERROR: " + "a".repeat(1_000_000), `${ENTRY} ok`]));
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});

// ─── The readers give what the patterns they replaced gave ───────────────

const OLD_ENTRY_RE = /^(?:\[[^\]]{0,40}\]\s*)?(TRACE|NOISE|DEBUG|LOG {2}|WARN |ERROR): (\S+)(.*?)> (.*)$/;
const OLD_ORIGIN_RE = /^([\w.$<>]+)\s*> ?(.*)$/;
const OLD_FRAME_RE = /^function: (.*?) -- file: (.*?) line # (\d+)(?: \| (?:MOD: (.*?)|(Vanilla)))?\.?\s*$/;
const OLD_EXCEPTION_LINE_RE = /^\s*(?:Caused by: )?([\w$]+(?:\.[\w$]+)+(?:Exception|Error))(?::\s?(.*?))?(?:\s+at [\w.$<>]+\([^)]*\))?\.?\s*$/;
const OLD_CAUSED_BY_RE = /^\s*Caused by: ([\w$]+(?:\.[\w$]+)+):?\s*(.*?)\.?\s*$/;
const OLD_LUA_FILE_RE = /Error found in LUA file: (.{1,500}?)\s*$/;

function oldEntryTime(meta, raw) {
  const t = /\bt:(\d{12,14})\b/.exec(meta || "");
  if (t) {
    const ms = Number(t[1]);
    if (ms > 1.4e12 && ms < 4.2e12) return ms;
  }
  const d = /^\[(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/.exec(raw || "");
  if (d) {
    const [, dd, mm, yy, h, mi, s, ms] = d;
    const value = new Date(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(h), Number(mi), Number(s), Number(ms || 0)).getTime();
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function oldParseEntry(raw) {
  const m = OLD_ENTRY_RE.exec(raw);
  if (!m) return null;
  let text = m[4];
  let origin = null;
  const o = OLD_ORIGIN_RE.exec(text);
  if (o && /[.$]/.test(o[1])) {
    origin = o[1];
    text = o[2];
  }
  return { level: m[1].trim(), category: m[2], origin, text: text.trim(), time: oldEntryTime(m[3], raw) };
}

// A small seeded generator, so a failure always repeats.
function generator(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(next() * list.length)];
  const build = (starts, tokens, max) => {
    let s = next() < 0.85 ? pick(starts) : "";
    const n = 1 + Math.floor(next() * max);
    for (let i = 0; i < n; i++) s += pick(tokens);
    return s;
  };
  return { next, pick, build };
}

const RUNS = 6000;

describe("the line readers match the old patterns on ordinary and odd lines", () => {
  it("parseEntry()", () => {
    const g = generator(42);
    const starts = ["ERROR: ", "LOG  : ", "WARN : ", "TRACE: ", "DEBUG: ", "[30-03-26 14:38:17.563] ERROR: ", "[x] LOG  : ", " ERROR: "];
    const tokens = ["General", "Lua", "a", "b.c", "$", "<init>", ">", "> ", " >", " ", "  ", "\t", "f:0, t:1774895897563, st:0", " t:1774895897563", "X.y", ": ", "x", "General>", LS, PS, "\r", "\n"];
    const part = () => g.build([""], tokens, 3);
    for (let i = 0; i < RUNS; i++) {
      const line = g.next() < 0.5
        ? g.build(starts, tokens, 9)
        : g.pick(starts) + g.pick(["General", "Lua", "General>", "a.b", ">"]) + (g.next() < 0.5 ? part() : "")
          + g.pick(["> ", ">", " > ", "  f:0, t:1774895897563, st:0> "]) + (g.next() < 0.7 ? part() : "");
      expect(parseEntry(line), JSON.stringify(line)).toEqual(oldParseEntry(line));
    }
    // The lines the game writes.
    for (const line of [
      `${ENTRY} KahluaThread.flushErrorMessage      > dumping Lua stack trace`,
      "[30-03-26 14:38:26.380] LOG  : General      f:0, t:1774895897563, st:0> SERVER STARTED",
      "ERROR: General> text",
      "ERROR: General> a> b",
      "ERROR: General      f:0 at AngelCodeFont.parseFnt              > AngelCodeFont failed",
    ]) {
      expect(parseEntry(line)).toEqual(oldParseEntry(line));
    }
  });

  it("parseFrameLine()", () => {
    const g = generator(7);
    const starts = ["function: ", " function: ", "\tfunction: "];
    const tokens = ["f", "autoSort", " -- file: ", " line # ", "12", "3", " | MOD: ", " | Vanilla", ".", " ", "  ", "\t", "a", "b.lua", "x y", "|", "MOD:", "Vanilla", "-- file:", "line #", "Spongie's Clothing"];
    const part = () => g.build([""], tokens, 3);
    const tails = ["", ".", " | MOD: Core", " | MOD: Core.", " | MOD: ", " | MOD: .", " | Vanilla", " | Vanilla.", " | Vanilla x", "x", " .", ". "];
    for (let i = 0; i < RUNS; i++) {
      const line = g.next() < 0.3
        ? g.build(starts, tokens, 10)
        : g.pick(starts) + part() + " -- file: " + part() + " line # " + g.pick(["12", "3", "x", ""])
          + g.pick(tails) + (g.next() < 0.3 ? part() : "") + (g.next() < 0.2 ? g.pick(["  ", "\t"]) : "");
      const f = OLD_FRAME_RE.exec(line.trim());
      const expected = f ? { fn: f[1], file: f[2], line: Number(f[3]), mod: f[4] ?? null, vanilla: Boolean(f[5]) } : null;
      expect(parseFrameLine(line), JSON.stringify(line)).toEqual(expected);
    }
  });

  it("parseExceptionLine()", () => {
    const g = generator(11);
    const starts = ["java.lang.RuntimeException", "\tjava.lang.NullPointerException", "Caused by: a.bError", " a.b.cException", "x.yError", "a.Exception", "java.lang.Error"];
    const tokens = [":", ": ", " ", "  ", "\t", "at ", " at ", "x.y", "(", ")", "Foo.java:1", "$", "<init>", "msg", ".", "Exception", "Error", "a", "b.c", "Caused by: "];
    const part = () => g.build([""], tokens, 3);
    for (let i = 0; i < RUNS; i++) {
      const line = g.next() < 0.4
        ? g.build(starts, tokens, 9)
        : g.pick(starts) + (g.next() < 0.7 ? g.pick([":", ": ", ":  ", ":\t"]) + part() : "")
          + (g.next() < 0.7 ? g.pick([" at ", "  at ", "\tat ", "at ", " at  "]) + g.pick(["x.y", "<init>", "a$b", "", "x y"])
            + "(" + g.pick(["", "Foo.java:1", "(", "a(b", "x) y"]) + ")" : "")
          + g.pick(["", ".", " ", ". ", "..", "\t"]);
      const e = OLD_EXCEPTION_LINE_RE.exec(line);
      const expected = e ? { cls: e[1], message: e[2] } : null;
      expect(parseExceptionLine(line), JSON.stringify(line)).toEqual(expected);
    }
    const real = "\tjava.lang.RuntimeException: attempted index: x of non-table: null at KahluaThread.tableget(KahluaThread.java:1689).";
    expect(parseExceptionLine(real)).toEqual({ cls: "java.lang.RuntimeException", message: "attempted index: x of non-table: null" });
  });

  it("parseCausedByLine()", () => {
    const g = generator(23);
    const starts = ["Caused by: ", "\tCaused by: ", " Caused by: java.lang."];
    const tokens = ["a.b", "a", ".", "c", "Exception", ":", ": ", " ", "  ", "\t", "msg", "x y", "$", "Caused by: "];
    for (let i = 0; i < RUNS; i++) {
      const line = g.build(starts, tokens, 9);
      const c = OLD_CAUSED_BY_RE.exec(line);
      const expected = c ? { cls: c[1], message: c[2] } : null;
      expect(parseCausedByLine(line), JSON.stringify(line)).toEqual(expected);
    }
  });

  it("matchLuaFileError()", () => {
    const g = generator(99);
    const long = ["a".repeat(470), "b".repeat(480), "/".repeat(475)];
    const starts = ["Error found in LUA file: ", "LOG  : Lua> Error found in LUA file: "];
    const tokens = ["a", "/", "x.lua", " ", "  ", "\t", ".", "Error found in LUA file: ", ...long];
    for (let i = 0; i < RUNS; i++) {
      const line = g.build(starts, tokens, 8);
      const m = OLD_LUA_FILE_RE.exec(line);
      const got = matchLuaFileError(line);
      expect(got ? got[1] : null, JSON.stringify(line)).toBe(m ? m[1] : null);
    }
  });
});
