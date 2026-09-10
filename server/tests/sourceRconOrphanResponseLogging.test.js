import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import net from "net";

// timeout-handling-consistency-sweep, 2026-09-10 (god's fix #2): a late RCON
// response for an id whose execute() timer already fired (rejecting the
// caller with "RCON command timed out" and deleting the _pending entry) used
// to be dropped in _onData() with zero trace -- the identical orphan-response
// class server/services/panelBridge.js's processResult() was just fixed for
// (b7177e1b), unfixed here because that fix's scope never reached this file.
// Real net.Server + net.Socket loopback (not a mocked socket), matching
// linuxRconSplitPacket.test.js's own established real-socket convention for
// this exact client.

const { warnCalls, mockLogger } = vi.hoisted(() => {
  const warnCalls = [];
  return {
    warnCalls,
    mockLogger: {
      info: () => {},
      warn: (msg) => warnCalls.push(msg),
      error: () => {},
      debug: () => {},
    },
  };
});

vi.mock("../utils/logger.js", () => ({
  createLogger: () => mockLogger,
}));

const { SourceRconClient } = await import("../utils/sourceRcon.js");

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXECCOMMAND = 2;
const TYPE_RESPONSE_VALUE = 0;

function encodePacket(id, type, body) {
  const bodyBuf = Buffer.from(body ?? "", "utf8");
  const size = 4 + 4 + bodyBuf.length + 1 + 1;
  const buf = Buffer.alloc(4 + size);
  let offset = 0;
  buf.writeInt32LE(size, offset); offset += 4;
  buf.writeInt32LE(id, offset); offset += 4;
  buf.writeInt32LE(type, offset); offset += 4;
  bodyBuf.copy(buf, offset); offset += bodyBuf.length;
  buf.writeUInt8(0, offset); offset += 1;
  buf.writeUInt8(0, offset); offset += 1;
  return buf;
}

// Delays the EXECCOMMAND response by `delayMs` (real setTimeout), so the
// client's own execute() timeout (set well below delayMs) fires and deletes
// its _pending entry BEFORE the real response packet ever arrives on the wire.
function startFakeServer({ execDelayMs }) {
  return new Promise((resolveServer) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 4) break;
          const size = buf.readInt32LE(0);
          const totalLen = 4 + size;
          if (buf.length < totalLen) break;
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          buf = buf.subarray(totalLen);

          if (type === TYPE_AUTH) {
            socket.write(encodePacket(id, TYPE_AUTH_RESPONSE, ""));
          } else if (type === TYPE_EXECCOMMAND) {
            setTimeout(() => {
              socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, "late-answer"));
            }, execDelayMs);
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("SourceRconClient._onData: orphaned responses (no matching _pending entry) are logged, not silently dropped", () => {
  let server;
  let client;

  beforeEach(() => {
    warnCalls.length = 0;
  });

  afterEach(async () => {
    if (client) client.disconnect();
    if (server) await new Promise((r) => server.close(r));
    server = null;
    client = null;
  });

  it("logs a warning naming the id when the real response arrives after execute()'s own timeout already fired", async () => {
    server = await startFakeServer({ execDelayMs: 100 });
    client = new SourceRconClient({ host: "127.0.0.1", port: server.address().port, timeout: 3000 });
    await client.authenticate("pw");

    await expect(client.execute("slow", { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
    expect(warnCalls.length).toBe(0); // not yet -- the late response hasn't arrived

    // Give the server's delayed write time to actually land.
    await sleep(200);

    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toMatch(/Orphaned RCON response/);
  });

  it("does NOT log an orphan warning on the normal, on-time path", async () => {
    server = await startFakeServer({ execDelayMs: 0 });
    client = new SourceRconClient({ host: "127.0.0.1", port: server.address().port, timeout: 3000 });
    await client.authenticate("pw");

    const response = await client.execute("fast", { timeoutMs: 3000 });
    expect(response).toBe("late-answer");
    await sleep(20);
    expect(warnCalls.length).toBe(0);
  });
});
