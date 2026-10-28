import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { createLogger } from "./logger.js";

const log = createLogger("ProcessMemory");

// Resident memory of game server processes by PID, and the memory this host
// (or this container) can give them -- the Dashboard's list of servers shows
// each one's RAM, and warns when the servers that start together are allowed
// more heap than the machine has.
//
// Linux reads /proc/<pid>/status (VmRSS), no process spawned. Windows asks
// PowerShell once for every PID, cached briefly: GET /servers/status is
// polled by every open Dashboard. macOS asks ps.

const WINDOWS_CACHE_MS = 20_000;
let windowsCache = { at: 0, key: "", values: new Map() };

function validPid(pid) {
  const value = Number(pid);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function linuxRss(pid) {
  try {
    const status = await fs.promises.readFile(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function run(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout || ""));
    });
  });
}

// SECURITY (2026-10-28): single-flight, like serverManager.js's
// runWindowsPowerShell(). Requests to GET /servers/status that arrive
// together all wait on one shared process scan, so they reach this at the
// same moment: each started its own PowerShell while the cache was empty or
// stale, and a burst of them starved the host running the game. A caller
// asking while the same PIDs are being read shares that run's answer.
const windowsInFlight = new Map();

function windowsRss(pids) {
  const key = [...pids].sort((a, b) => a - b).join(",");
  if (key === windowsCache.key && Date.now() - windowsCache.at < WINDOWS_CACHE_MS) {
    return Promise.resolve(windowsCache.values);
  }
  const running = windowsInFlight.get(key);
  if (running) return running;
  const read = readWindowsRss(key).finally(() => {
    if (windowsInFlight.get(key) === read) windowsInFlight.delete(key);
  });
  windowsInFlight.set(key, read);
  return read;
}

async function readWindowsRss(key) {
  const values = new Map();
  const out = await run("powershell", [
    "-NoProfile",
    "-Command",
    `Get-Process -Id ${key} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.WorkingSet64)" }`,
  ]);
  for (const line of String(out || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) values.set(Number(match[1]), Number(match[2]));
  }
  windowsCache = { at: Date.now(), key, values };
  return values;
}

async function psRss(pid) {
  const out = await run("ps", ["-o", "rss=", "-p", String(pid)], 5000);
  const kb = Number(String(out || "").trim());
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

// Map of PID -> resident bytes, for the PIDs that could be read.
export async function readProcessesMemory(pids, { platform = process.platform } = {}) {
  const wanted = [...new Set((pids || []).map(validPid).filter(Boolean))];
  const result = new Map();
  if (wanted.length === 0) return result;
  try {
    if (platform === "win32") {
      const values = await windowsRss(wanted);
      for (const pid of wanted) if (values.has(pid)) result.set(pid, values.get(pid));
      return result;
    }
    const read = platform === "linux" ? linuxRss : psRss;
    await Promise.all(
      wanted.map(async (pid) => {
        const bytes = await read(pid);
        if (bytes !== null) result.set(pid, bytes);
      }),
    );
  } catch (error) {
    log.debug(`Process memory read failed: ${error.message}`);
  }
  return result;
}

function readLimit(file) {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

// What this host can give its processes: the machine's memory, or the
// container's own cgroup limit when it is lower (the all-in-one image under
// a memory limit -- Node's os.totalmem() reports the whole host). cgroup v2
// says "max" for no limit, v1 a huge number; both leave the total.
export function hostMemoryLimitBytes({ readFile = readLimit, totalmem = os.totalmem } = {}) {
  const total = totalmem();
  const limits = [
    readFile("/sys/fs/cgroup/memory.max"),
    readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
  ].filter((value) => value !== null && value < total);
  return limits.length > 0 ? Math.min(...limits) : total;
}
