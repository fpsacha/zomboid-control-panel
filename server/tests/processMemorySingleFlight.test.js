import { afterEach, describe, expect, it, vi } from "vitest";

// SECURITY (2026-10-28): GET /api/servers/status reads every running
// server's memory, and on Windows that asks PowerShell. Requests arriving
// together each started their own PowerShell while the 20-second cache was
// empty or stale; a burst of them starved the host running the game. The
// read is single-flight now: callers asking for the same PIDs share one run.

const spawns = [];
const failNext = { value: false };

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: vi.fn((file, args, _options, callback) => {
      spawns.push({ file, args });
      const command = String(args[args.length - 1] || "");
      const ids = (/-Id ([\d,]+)/.exec(command)?.[1] || "").split(",").filter(Boolean);
      const fail = failNext.value;
      failNext.value = false;
      setTimeout(() => {
        if (fail) callback(new Error("powershell failed"), "", "");
        else callback(null, ids.map((id) => `${id} ${Number(id) * 1000}`).join("\r\n"), "");
      }, 25);
    }),
  };
});

const { readProcessesMemory } = await import("../utils/processMemory.js");

afterEach(() => {
  vi.restoreAllMocks();
  spawns.length = 0;
});

describe("readProcessesMemory() on Windows", () => {
  it("starts one PowerShell for a burst of concurrent reads of the same servers", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => readProcessesMemory([4101, 4102], { platform: "win32" })),
    );
    expect(spawns).toHaveLength(1);
    expect(spawns[0].file).toBe("powershell");
    for (const result of results) {
      expect(result.get(4101)).toBe(4101000);
      expect(result.get(4102)).toBe(4102000);
    }
  });

  it("shares the run whatever the order or spelling of the PIDs (adversary: reordered and repeated PIDs)", async () => {
    const results = await Promise.all([
      readProcessesMemory([4202, 4201], { platform: "win32" }),
      readProcessesMemory(["4201", 4202, 4202], { platform: "win32" }),
      readProcessesMemory([4201, "4202", null, -1], { platform: "win32" }),
    ]);
    expect(spawns).toHaveLength(1);
    for (const result of results) expect([...result.keys()].sort()).toEqual([4201, 4202]);
  });

  it("starts one PowerShell for a burst that arrives just as the cache expires", async () => {
    const realNow = Date.now();
    await readProcessesMemory([4301], { platform: "win32" });
    expect(spawns).toHaveLength(1);
    // Inside the 20-second cache: no new run.
    await Promise.all(Array.from({ length: 10 }, () => readProcessesMemory([4301], { platform: "win32" })));
    expect(spawns).toHaveLength(1);
    vi.spyOn(Date, "now").mockReturnValue(realNow + 21_000);
    await Promise.all(Array.from({ length: 40 }, () => readProcessesMemory([4301], { platform: "win32" })));
    expect(spawns).toHaveLength(2);
  });

  it("runs again after a failed read instead of keeping the failed run", async () => {
    failNext.value = true;
    const failed = await Promise.all([
      readProcessesMemory([4401], { platform: "win32" }),
      readProcessesMemory([4401], { platform: "win32" }),
    ]);
    expect(spawns).toHaveLength(1);
    for (const result of failed) expect(result.size).toBe(0);
    // The failed answer is cached like any other; once it is stale a new
    // read starts (the in-flight entry did not stick).
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 21_000);
    const next = await readProcessesMemory([4401], { platform: "win32" });
    expect(spawns).toHaveLength(2);
    expect(next.get(4401)).toBe(4401000);
  });

  it("still reads a different set of servers on its own", async () => {
    const [a, b] = await Promise.all([
      readProcessesMemory([4501], { platform: "win32" }),
      readProcessesMemory([4501, 4502], { platform: "win32" }),
    ]);
    expect(spawns).toHaveLength(2);
    expect(a.get(4501)).toBe(4501000);
    expect(b.get(4502)).toBe(4502000);
  });
});
