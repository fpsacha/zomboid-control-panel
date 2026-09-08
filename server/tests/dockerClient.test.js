import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import {
  DockerClient,
  demuxDockerLogStream,
  isManagedContainer,
  lifecycleTimeoutMs,
  parseContainerStats,
} from "../services/dockerClient.js";

// Docker's own multiplexed-frame format for a non-TTY container's log
// stream: 8-byte header (1 byte stream type, 3 reserved, 4-byte big-endian
// payload length) then that many payload bytes, repeated per chunk written
// to stdout/stderr.
function frame(streamType, text) {
  const payload = Buffer.from(text, "utf-8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("demuxDockerLogStream", () => {
  it("strips the 8-byte frame header from each chunk and concatenates the payloads", () => {
    const buffer = Buffer.concat([
      frame(1, "line one\n"),
      frame(2, "line two (stderr)\n"),
      frame(1, "line three\n"),
    ]);
    expect(demuxDockerLogStream(buffer)).toBe("line one\nline two (stderr)\nline three\n");
  });

  it("stops cleanly on a truncated final frame instead of throwing or reading past the buffer", () => {
    const complete = frame(1, "complete line\n");
    const truncated = Buffer.alloc(8);
    truncated.writeUInt8(1, 0);
    truncated.writeUInt32BE(9999, 4); // claims a payload that was never appended
    const buffer = Buffer.concat([complete, truncated]);
    expect(demuxDockerLogStream(buffer)).toBe("complete line\n");
  });

  it("returns an empty string for an empty stream", () => {
    expect(demuxDockerLogStream(Buffer.alloc(0))).toBe("");
  });
});

describe("Docker managed-container boundary", () => {
  it("accepts only containers explicitly opted into panel management", () => {
    expect(isManagedContainer({ Labels: { "zomboid-panel.managed": "true" } })).toBe(true);
    expect(isManagedContainer({ Config: { Labels: { "zomboid-panel.managed": "true" } } })).toBe(true);
    expect(isManagedContainer({ Labels: { "zomboid-panel.role": "pz-server" } })).toBe(false);
    expect(isManagedContainer({ Image: "ich777/steamcmd:projectzomboid", Labels: {} })).toBe(false);
  });
});

describe("lifecycleTimeoutMs", () => {
  it("waits out the container's own stop grace period", () => {
    // A modded B42 world sets stop_grace_period: 90s, which Compose writes to
    // the container as StopTimeout. Anything shorter aborts the socket and
    // reports a failure on a stop Docker went on to complete.
    const container = { Config: { StopTimeout: 90 } };
    expect(lifecycleTimeoutMs("stop", container)).toBeGreaterThan(90_000);
    expect(lifecycleTimeoutMs("restart", container)).toBeGreaterThan(
      lifecycleTimeoutMs("stop", container),
    );
  });

  it("falls back to Docker's own default when the container sets no timeout", () => {
    expect(lifecycleTimeoutMs("stop", { Config: {} })).toBe(10_000 + 30_000);
    expect(lifecycleTimeoutMs("stop", undefined)).toBe(10_000 + 30_000);
  });

  it("does not budget a shutdown window for a start", () => {
    expect(lifecycleTimeoutMs("start", { Config: { StopTimeout: 90 } })).toBe(30_000);
  });
});

describe("parseContainerStats", () => {
  it("calculates bounded CPU, memory, network, and disk counters", () => {
    expect(parseContainerStats({
      cpu_stats: { system_cpu_usage: 2000, online_cpus: 2, cpu_usage: { total_usage: 500, percpu_usage: [250, 250] } },
      precpu_stats: { system_cpu_usage: 1000, cpu_usage: { total_usage: 200 } },
      memory_stats: { usage: 512, limit: 1024 },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 5, tx_bytes: 7 } },
      blkio_stats: { io_service_bytes_recursive: [{ op: "Read", value: 3 }, { op: "Write", value: 4 }] },
    })).toEqual({
      cpuPercent: 60,
      memoryUsed: 512,
      memoryLimit: 1024,
      memoryPercent: 50,
      networkRx: 15,
      networkTx: 27,
      diskRead: 3,
      diskWrite: 4,
    });
  });
});

// Real Docker Engine API calls over a real Unix domain socket -- a fake
// daemon standing in for dockerd, not a mock of DockerClient's own HTTP
// layer, so this exercises the actual request/response code path (including
// demuxing and the byte cap) rather than assuming it. Unix domain sockets
// are POSIX; skipped on Windows like every other real-socket/real-fs test
// in this suite (see linuxDbFileModes.test.js et al.) -- exercised for real
// via the WSL gate.
const isWindows = process.platform === "win32";
const MANAGED_CONTAINER = {
  Id: "c1",
  Labels: { "zomboid-panel.managed": "true" },
  Config: { Labels: { "zomboid-panel.managed": "true" }, Tty: false },
};
const MANAGED_TTY_CONTAINER = {
  Id: "c2",
  Labels: { "zomboid-panel.managed": "true" },
  Config: { Labels: { "zomboid-panel.managed": "true" }, Tty: true },
};

(isWindows ? describe.skip : describe)("DockerClient.getContainerLogs -- against a real fake daemon", () => {
  let server;
  let socketPath;
  let client;
  let lastLogsRequestUrl;
  let logsResponseBuffer;
  let logsResponseStatus;

  function startFakeDaemon() {
    socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pz-docker-test-")), "docker.sock");
    server = http.createServer((req, res) => {
      if (req.url.startsWith("/containers/c1/json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MANAGED_CONTAINER));
        return;
      }
      if (req.url.startsWith("/containers/c2/json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(MANAGED_TTY_CONTAINER));
        return;
      }
      if (req.url.startsWith("/containers/unmanaged/json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: "unmanaged", Labels: {} }));
        return;
      }
      if (req.url.startsWith("/containers/") && req.url.includes("/logs")) {
        lastLogsRequestUrl = req.url;
        res.writeHead(logsResponseStatus || 200);
        res.end(logsResponseBuffer);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    return new Promise((resolve) => server.listen(socketPath, resolve));
  }

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  });

  it("demuxes a non-TTY container's multiplexed stdout/stderr into plain text", async () => {
    await startFakeDaemon();
    client = new DockerClient({ socketPath, enabled: true });
    logsResponseBuffer = Buffer.concat([
      frame(1, "Server starting...\n"),
      frame(2, "WARN: something on stderr\n"),
    ]);

    const logs = await client.getContainerLogs("c1", { tail: 500 });

    expect(logs).toBe("Server starting...\nWARN: something on stderr\n");
    expect(lastLogsRequestUrl).toContain("tail=500");
    expect(lastLogsRequestUrl).toContain("stdout=true");
    expect(lastLogsRequestUrl).toContain("stderr=true");
  });

  it("passes a TTY container's response through as plain text, unframed", async () => {
    await startFakeDaemon();
    client = new DockerClient({ socketPath, enabled: true });
    logsResponseBuffer = Buffer.from("raw tty output, no framing\n", "utf-8");

    const logs = await client.getContainerLogs("c2");

    expect(logs).toBe("raw tty output, no framing\n");
  });

  it("fails closed (returns null, does not throw) for a container this panel does not manage", async () => {
    await startFakeDaemon();
    client = new DockerClient({ socketPath, enabled: true });

    await expect(client.getContainerLogs("unmanaged")).resolves.toBeNull();
  });

  it("returns null rather than an unbounded string when the response exceeds the byte cap", async () => {
    await startFakeDaemon();
    client = new DockerClient({ socketPath, enabled: true });
    // One oversized frame -- realistic worst case is a pathological single
    // log line (e.g. a huge unbroken stack trace), not many small ones.
    logsResponseBuffer = frame(1, "x".repeat(5 * 1024 * 1024));

    await expect(client.getContainerLogs("c1")).resolves.toBeNull();
  });

  it("returns null when Docker control is disabled, without contacting the socket", async () => {
    await startFakeDaemon();
    client = new DockerClient({ socketPath, enabled: false });

    await expect(client.getContainerLogs("c1")).resolves.toBeNull();
  });

  // Regression (2026-08-31 services sweep): _requestBuffer's timeout handler
  // used to set `settled = true` BEFORE calling request.destroy(error) --
  // destroy() fires its 'error' event asynchronously, by which point the
  // error handler's own `if (settled) return` guard silently swallowed it,
  // so the promise never settled at all. A real daemon that accepts the
  // connection but never writes a response (hung/overloaded dockerd) used
  // to wedge getContainerLogs forever, with no failure a user could report.
  // A genuinely non-responding real HTTP server over a real Unix socket --
  // not a mock of the timeout event -- so this proves Node's actual
  // destroy(err)-then-error-event ordering is handled, not just an
  // assumption about it.
  it("rejects instead of hanging forever when the daemon accepts the connection but never responds", async () => {
    const hangDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-docker-hang-test-"));
    const hangSocketPath = path.join(hangDir, "docker.sock");
    const hangServer = http.createServer(() => {
      // Deliberately never call res.write/res.end -- the exact "connection
      // accepted, then silence" shape that used to make _requestBuffer's
      // promise never settle.
    });
    await new Promise((resolve) => hangServer.listen(hangSocketPath, resolve));

    try {
      const hangClient = new DockerClient({ socketPath: hangSocketPath, enabled: true });
      await expect(
        hangClient._requestBuffer("GET", "/containers/c1/logs", 150),
      ).rejects.toThrow(/timed out/i);
    } finally {
      await new Promise((resolve) => hangServer.close(resolve));
      fs.rmSync(hangDir, { recursive: true, force: true });
    }
  });
});

// wrapper-bypass class sweep, 2026-09-08: inspectManagedContainer() used to
// collapse "asked, and it's confirmed not ours" (unlabeled, or a real 404)
// and "couldn't ask" (socket unreachable, timeout, malformed response) into
// the exact same `null` -- callers had no way to tell a genuine "not
// managed" apart from "the check itself failed", which is what let
// docker.js's POST /containers/:id/:action report a transient Docker hiccup
// as a confident "Container is not managed by this panel". Mirrors
// listManagedContainers()'s existing lastError convention rather than
// inventing a new one. Spies on the private _requestJson rather than
// standing up a real socket -- portable to Windows, and exercises exactly
// the boundary this fix touches (the catch block) without re-testing the
// HTTP transport layer real-socket tests elsewhere already cover.
describe("DockerClient.inspectManagedContainer -- lastError distinguishes 'confirmed not ours' from 'could not ask'", () => {
  let tmpDir;
  let socketPath;
  let client;

  function makeClient() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-docker-lasterror-test-"));
    socketPath = path.join(tmpDir, "docker.sock");
    fs.writeFileSync(socketPath, "");
    return new DockerClient({ socketPath, enabled: true });
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("clears lastError on a call that reached the daemon and got back an unlabeled container", async () => {
    client = makeClient();
    client.lastError = "stale error from a previous call";
    vi.spyOn(client, "_requestJson").mockResolvedValue({ Id: "x", Labels: {} });

    const result = await client.inspectManagedContainer("x");

    expect(result).toBeNull();
    expect(client.lastError).toBeNull();
  });

  it("clears lastError on a call that reached the daemon and got back a labeled container", async () => {
    client = makeClient();
    client.lastError = "stale error from a previous call";
    vi.spyOn(client, "_requestJson").mockResolvedValue({
      Id: "x",
      Labels: { "zomboid-panel.managed": "true" },
    });

    const result = await client.inspectManagedContainer("x");

    expect(result).not.toBeNull();
    expect(client.lastError).toBeNull();
  });

  it("sets lastError when the request itself fails (socket/timeout/API error)", async () => {
    client = makeClient();
    vi.spyOn(client, "_requestJson").mockRejectedValue(new Error("Docker API returned 500"));

    const result = await client.inspectManagedContainer("x");

    expect(result).toBeNull();
    expect(client.lastError).toBe("Docker API returned 500");
  });

  it("both failure shapes return the identical null -- lastError is the only signal that tells them apart", async () => {
    client = makeClient();
    vi.spyOn(client, "_requestJson").mockResolvedValueOnce({ Id: "x", Labels: {} });
    const unlabeledResult = await client.inspectManagedContainer("x");
    const unlabeledLastError = client.lastError;

    vi.spyOn(client, "_requestJson").mockRejectedValueOnce(new Error("socket hang up"));
    const failedResult = await client.inspectManagedContainer("x");
    const failedLastError = client.lastError;

    expect(unlabeledResult).toBeNull();
    expect(failedResult).toBeNull();
    expect(unlabeledResult).toEqual(failedResult);
    expect(unlabeledLastError).toBeNull();
    expect(failedLastError).toBe("socket hang up");
  });
});
