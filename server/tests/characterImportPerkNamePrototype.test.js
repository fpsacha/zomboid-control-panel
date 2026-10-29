import { describe, expect, it } from "vitest";
import { characterImportArgs } from "../utils/characterImport.js";

describe("character import perk names", () => {
  it("drops perks named after Object members and keeps a prototype-free map", () => {
    const perks = JSON.parse(
      '{"__proto__": {"level": 3}, "constructor": {"level": 1}, "prototype": {"level": 1}, "Woodwork": {"level": 2}}',
    );
    const { args } = characterImportArgs({ username: "Bob", data: { perks }, options: {} });

    expect(Object.getPrototypeOf(args.data.perks)).toBe(null);
    expect(Object.keys(args.data.perks)).toEqual(["Woodwork"]);
    expect(args.data.perks.Woodwork).toEqual({ level: 2 });
    expect(JSON.parse(JSON.stringify(args.data.perks))).toEqual({ Woodwork: { level: 2 } });
  });
});
