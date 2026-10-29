import { describe, expect, it, vi } from "vitest";

// Security audit 2026-10-28 (R1-65): routes quote request values in their
// log lines (DELETE /api/backup/:name, DELETE /api/scheduler/tasks/:id,
// POST /api/chunks/delete-chunks' saveName, ...). The logger escaped C1
// controls and U+2028/U+2029 in every entry but left CR/LF to the call
// sites, and these never escaped them: a %0A in a backup name started a new
// line in combined.log -- the file the Debug page downloads and support
// bundles ship -- that read as a genuine panel entry. The logger now indents
// every line after an entry's first, so no call site can start one.

vi.mock("../database/init.js", () => ({ getActiveServer: vi.fn(async () => null) }));
vi.mock("../services/auth.js", () => ({ requireRole: () => (_req, _res, next) => next() }));

const { fileFormat, onLog, createLogger } = await import("../utils/logger.js");
const { default: backupRouter } = await import("../routes/backup.js");

const MESSAGE = Symbol.for("message");
const C = (...codes) => String.fromCharCode(...codes);
const LF = C(10);
const CR = C(13);
const FORGED = "2026-10-28 10:00:00 [INFO] [Auth] Login succeeded for admin";
// How a reader of combined.log recognises the start of an entry.
const ENTRY_START = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[/;

function fileEntry(message, extra = {}) {
  return fileFormat.transform({ level: "info", message, source: "Backup", ...extra })[MESSAGE];
}

function physicalLines(text) {
  return text.split(/\r\n|\r|\n/);
}

function expectOneEntry(text) {
  const lines = physicalLines(text);
  expect(lines.filter((line) => ENTRY_START.test(line))).toHaveLength(1);
  for (const line of lines.slice(1)) expect(line).toMatch(/^([ \t]|$)/);
}

async function streamed(fn) {
  const seen = [];
  const stop = onLog((entry) => seen.push(entry));
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    stop();
  }
  return seen;
}

describe("combined.log entries quoting request text", () => {
  it("can't start a line that reads as an entry of its own, after LF, CR or CRLF", () => {
    for (const lineBreak of [LF, CR, CR + LF]) {
      const entry = fileEntry(`DELETE /x.zip${lineBreak}${FORGED}`);
      expectOneEntry(entry);
      expect(entry.endsWith(`${lineBreak}    ${FORGED}`)).toBe(true);
    }
  });

  it("indents every continuation line of a multi-line message, blank ones included", () => {
    const entry = fileEntry(`a${LF}b${CR}${LF}c${CR}d${LF}${LF}e${LF}`);
    expectOneEntry(entry);
    expect(entry).toMatch(new RegExp(`\\] \\[Backup\\] a${LF}    b${CR}${LF}    c${CR}    d${LF}    ${LF}    e${LF}$`));
  });

  it("leaves a stack trace exactly as it was", () => {
    const err = new Error("boom");
    const entry = fileEntry("boom", { level: "error", stack: err.stack });
    expect(entry.endsWith(`[ERROR] [Backup] ${err.stack}`)).toBe(true);
  });

  // Adversary pass: other ways to make a viewer, or a script reading a
  // support bundle, start a new line.
  it("escapes the vertical tab, form feed and separators that splitlines() breaks on", () => {
    for (const code of [0x0b, 0x0c, 0x1c, 0x1d, 0x1e]) {
      const entry = fileEntry(`DELETE /x.zip${C(code)}${FORGED}`);
      expect(entry).not.toContain(C(code));
      expect(entry).toContain(`\\u00${code.toString(16).padStart(2, "0")}${FORGED}`);
    }
  });

  it("indents a forged line led by a no-break space, and keeps one led by a space or tab off column 0", () => {
    for (const lead of [C(0xa0), " ", C(9), C(0x3000)]) {
      expectOneEntry(fileEntry(`DELETE /x.zip${LF}${lead}${FORGED}`));
    }
  });
});

describe("the Debug page's live log stream", () => {
  it("gets the same indentation, so its text export can't be forged either", async () => {
    const log = createLogger("Backup");
    const [entry] = await streamed(() => log.info(`DELETE /x.zip${LF}${FORGED}`));
    expect(entry.message).toBe(`DELETE /x.zip${LF}    ${FORGED}`);
  });
});

describe("DELETE /api/backup/:name", () => {
  it("logs a %0A in the backup name without forging an entry", async () => {
    const layer = backupRouter.stack.find((l) => l.route?.path === "/:name" && l.route.methods.delete);
    const handler = layer.route.stack.at(-1).handle;
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const deleteBackup = vi.fn(async () => ({ success: true }));
    const name = `x.zip${LF}${FORGED}`;

    const seen = await streamed(() =>
      handler({ params: { name }, app: { get: () => ({ deleteBackup }) } }, res),
    );

    expect(deleteBackup).toHaveBeenCalledWith(name);
    const line = seen.find((e) => e.source === "API:Backup" && e.message.startsWith("DELETE /x.zip"));
    expect(line).toBeDefined();
    expectOneEntry(fileEntry(line.message));
    expect(physicalLines(line.message).some((l) => ENTRY_START.test(l))).toBe(false);
  });
});
