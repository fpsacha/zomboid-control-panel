import { describe, expect, it } from "vitest";
import { shouldAutoOpenBrowser } from "../utils/browserLaunch.js";

describe("shouldAutoOpenBrowser", () => {
  it("opens by default", () => {
    expect(shouldAutoOpenBrowser()).toBe(true);
  });

  it.each(["0", "false", "no", "off", " FALSE "])(
    "recognizes %j as disabled",
    (value) => {
      expect(shouldAutoOpenBrowser(value)).toBe(false);
    },
  );

  it("keeps browser opening enabled for other values", () => {
    expect(shouldAutoOpenBrowser("true")).toBe(true);
  });
});