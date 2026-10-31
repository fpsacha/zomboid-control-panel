import { describe, expect, it } from "vitest";
import { formatLogEntryText } from "../utils/logText.js";

const ESC = String.fromCharCode(0x1b);
const BS = String.fromCharCode(0x08);
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);

describe("formatLogEntryText() and terminal controls", () => {
  it("escapes ESC, backspace, NUL and DEL so a terminal cannot move the cursor", () => {
    const out = formatLogEntryText(`a${ESC}[2K${BS}b${NUL}c${DEL}d`);
    expect(out).toBe("a\\u001b[2K\\u0008b\\u0000c\\u007fd");
  });

  it("keeps tab, CR/LF and stack-frame indentation", () => {
    expect(formatLogEntryText("x\ty\n    at f()")).toBe("x\ty\n    at f()");
  });

  it("indents a continuation line that starts with a single space", () => {
    expect(formatLogEntryText("first\n 2026-10-30 [INFO] forged")).toBe("first\n     2026-10-30 [INFO] forged");
  });
});
