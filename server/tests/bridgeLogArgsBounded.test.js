import { describe, expect, it } from "vitest";

// SECURITY (2026-10-28): logBridgeCommand kept the caller's args object as
// is in db.json's bridge_logs (500 entries). Up to 1 MB each made db.json
// huge, and args nested deeper than JSON.stringify can go made every later
// db.json write throw until 500 newer entries pushed that one out.
//
// REAL, UNMOCKED database/init.js: vitest.perFileDataDir.setup.mjs gives
// this file its own throwaway data folder.

const { logBridgeCommand, getBridgeLogs, getDb } = await import("../database/init.js");

function nested(depth) {
  return JSON.parse(`${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`);
}

async function savedArgs(args) {
  const entry = await logBridgeCommand("setGodMode", args, { ok: true }, false, 1);
  const [latest] = await getBridgeLogs(1);
  expect(latest.id).toBe(entry.id);
  return latest.args;
}

async function databaseStillSerializes() {
  const db = await getDb();
  expect(() => JSON.stringify(db.data, null, 2)).not.toThrow();
}

describe("logBridgeCommand keeps a bounded copy of the args", () => {
  it("keeps only the key names of args over 4 KB", async () => {
    const args = await savedArgs({ username: "Bob", pad: "x".repeat(200000) });

    expect(args).toEqual({ truncated: true, keys: ["username", "pad"] });
  });

  it("keeps args nested past the limit out of db.json, which still saves", async () => {
    const args = await savedArgs({ username: "Bob", deep: nested(20000) });

    expect(args).toEqual({ truncated: true, keys: ["username", "deep"] });
    await databaseStillSerializes();
  });

  it("also drops args nested deep but small enough to fit in 4 KB", async () => {
    const args = await savedArgs({ deep: nested(1500) });
    expect(args).toEqual({ truncated: true, keys: ["deep"] });
  });

  it("stores a copy of ordinary args, not the caller's object", async () => {
    const original = { username: "Bob", enabled: true, pos: { x: 1, y: 2 } };
    const args = await savedArgs(original);
    original.pos.x = 999;

    expect(args).toEqual({ username: "Bob", enabled: true, pos: { x: 1, y: 2 } });
  });

  // Adversary pass: the summary itself must not carry the size.
  it("caps the key list of a summary at 20 names of 64 characters", async () => {
    const huge = {};
    for (let i = 0; i < 1000; i++) huge[`${"k".repeat(5000)}${i}`] = i;
    const args = await savedArgs(huge);

    expect(args.truncated).toBe(true);
    expect(args.keys).toHaveLength(20);
    expect(args.keys.every((key) => key.length <= 64)).toBe(true);
    await databaseStillSerializes();
  });
});
