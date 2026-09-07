import { describe, expect, it, vi } from "vitest";
import { resolvePanelPort } from "../index.js";

// Startup-failure-mode sweep, 2026-09-07 (god's dispatch): a bad PORT env
// var or a corrupted `panelPort` setting used to silently become 3001, with
// nothing in the log to explain why the panel isn't listening where the
// operator expected -- SILENT-OR-GENERIC, not PERMANENT (the panel still
// starts fine), but exactly the "does the operator see anything" gap this
// sweep looks for. resolvePanelPort() now calls the supplied onInvalid()
// callback whenever it discards a genuinely-configured value, so the real
// call site (index.js's start()) can log a warning naming the bad value.
describe("resolvePanelPort: falls back to 3001, but says so when it discards a real value", () => {
  it("passes through a valid port unchanged, without warning", () => {
    const onInvalid = vi.fn();
    expect(resolvePanelPort(8080, { onInvalid })).toBe(8080);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("accepts a numeric string (the real shape env vars and DB settings arrive in)", () => {
    const onInvalid = vi.fn();
    expect(resolvePanelPort("8080", { onInvalid })).toBe(8080);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("falls back to 3001 and warns for a non-numeric value", () => {
    const onInvalid = vi.fn();
    expect(resolvePanelPort("abc", { onInvalid })).toBe(3001);
    expect(onInvalid).toHaveBeenCalledWith("abc");
  });

  it("falls back to 3001 and warns for an out-of-range port (0, negative, > 65535)", () => {
    for (const bad of [0, -1, 70000]) {
      const onInvalid = vi.fn();
      expect(resolvePanelPort(bad, { onInvalid })).toBe(3001);
      expect(onInvalid).toHaveBeenCalledWith(bad);
    }
  });

  it("falls back to 3001 and warns for a non-integer port", () => {
    const onInvalid = vi.fn();
    expect(resolvePanelPort(80.5, { onInvalid })).toBe(3001);
    expect(onInvalid).toHaveBeenCalledWith(80.5);
  });

  it("does NOT warn for an absent value (undefined/null/empty string) -- that's the normal 'nothing configured' case, not a discarded operator value", () => {
    for (const absent of [undefined, null, ""]) {
      const onInvalid = vi.fn();
      expect(resolvePanelPort(absent, { onInvalid })).toBe(3001);
      expect(onInvalid).not.toHaveBeenCalled();
    }
  });

  it("does not throw when onInvalid is omitted", () => {
    expect(() => resolvePanelPort("abc")).not.toThrow();
    expect(resolvePanelPort("abc")).toBe(3001);
  });
});
