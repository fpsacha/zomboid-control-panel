import { describe, expect, it } from "vitest";
import { characterImportArgs } from "../utils/characterImport.js";

describe("character import perk names", () => {
  it("keeps a perk named __proto__ as a plain key instead of replacing the object's prototype", () => {
    const perks = JSON.parse('{"__proto__": {"level": 3}, "Woodwork": {"level": 2}}');
    const { args } = characterImportArgs({ username: "Bob", data: { perks }, options: {} });

    expect(Object.getPrototypeOf(args.data.perks)).toBe(null);
    expect(Object.keys(args.data.perks)).toEqual(["__proto__", "Woodwork"]);
    expect(args.data.perks.Woodwork).toEqual({ level: 2 });
    expect(JSON.parse(JSON.stringify(args.data.perks)).Woodwork).toEqual({ level: 2 });
  });
});
