/**
 * Minimal Source RCON protocol client.
 *
 * Written to replace `rcon-srcds` (see B34 in the backend audit): that
 * library required reaching into private internals
 * (`client.connection || client.socket || client._socket`), manually
 * calling `removeAllListeners`, and bumping `setMaxListeners(25)` to work
 * around it adding a fresh listener pair per `execute()` call -- a sign the
 * socket lifecycle wasn't actually owned by our code. This client owns the
 * socket directly: one persistent 'data' listener, explicit packet framing,
 * and no per-call listener accumulation.
 *
 * Protocol reference: https://developer.valvesoftware.com/wiki/Source_RCON_Protocol
 * (Project Zomboid's RCON implementation follows this protocol.)
 */
import net from 'net';

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXECCOMMAND = 2;
const TYPE_RESPONSE_VALUE = 0;

// Nominal Source RCON packets are capped around 4096 bytes, but PZ (like many
// game servers) doesn't strictly enforce that on responses -- `showoptions`
// on a heavily modded server can be tens of KB. Cap generously so we don't
// silently discard a legitimately large response as "corrupt".
const MAX_PACKET_SIZE = 8 * 1024 * 1024;

let nextRequestId = 1;
function allocRequestId() {
  // Wrap well before Java's Integer range to stay a safe, boring positive int.
  nextRequestId = (nextRequestId % 0x7fffffff) + 1;
  return nextRequestId;
}

function encodePacket(id, type, body) {
  const bodyBuf = Buffer.from(body ?? '', 'utf8');
  // size = id(4) + type(4) + body + null terminator(1) + empty-string terminator(1)
  const size = 4 + 4 + bodyBuf.length + 1 + 1;
  const buf = Buffer.alloc(4 + size);
  let offset = 0;
  buf.writeInt32LE(size, offset); offset += 4;
  buf.writeInt32LE(id, offset); offset += 4;
  buf.writeInt32LE(type, offset); offset += 4;
  bodyBuf.copy(buf, offset); offset += bodyBuf.length;
  buf.writeUInt8(0, offset); offset += 1; // body terminator
  buf.writeUInt8(0, offset); offset += 1; // empty-string terminator
  return buf;
}

/**
 * Incremental packet reassembler. Source RCON packets can arrive split
 * across multiple TCP reads (or several packets can arrive in one read) --
 * this buffers raw bytes and yields complete { id, type, body } packets as
 * they become available.
 */
export class PacketReader {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  push(chunk) {
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    const packets = [];
    for (;;) {
      if (this._buf.length < 4) break;
      const size = this._buf.readInt32LE(0);
      // 10 = id(4) + type(4) + two terminators. Anything smaller would make the
      // readInt32LE calls below run off the end of the buffer and throw.
      if (size < 10 || size > MAX_PACKET_SIZE) {
        // Corrupt/unexpected framing -- drop everything buffered so far
        // rather than getting stuck reading a bogus length forever.
        this._buf = Buffer.alloc(0);
        break;
      }
      const totalLen = 4 + size;
      if (this._buf.length < totalLen) break; // wait for more data

      const id = this._buf.readInt32LE(4);
      const type = this._buf.readInt32LE(8);
      // body runs from offset 12 to totalLen - 2 (strip the two null terminators)
      const body = this._buf.toString('utf8', 12, totalLen - 2);
      packets.push({ id, type, body });

      this._buf = this._buf.subarray(totalLen);
    }
    return packets;
  }
}

export class SourceRconClient {
  /**
   * API-compatible constructor shape with the `rcon-srcds` package it
   * replaces (`new Rcon({ host, port, timeout })` then
   * `.authenticate(password)`), so the surrounding connection-management
   * code in services/rcon.js needed a minimal, low-risk diff to swap
   * transports -- import + constructor call only. `.execute()` and
   * `.disconnect()` keep the same call shape too.
   */
  constructor({ host, port, timeout = 5000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.socket = null;
    this.reader = new PacketReader();
    this._pending = new Map(); // requestId -> { resolve, reject, timer, parts }
    this._authPending = null;
    this._destroyed = false;
  }

  get connected() {
    return !!this.socket && !this.socket.destroyed;
  }

  /**
   * Opens the TCP connection and authenticates. Resolves once auth succeeds,
   * rejects (and closes the socket) on connection error, timeout, or bad
   * password.
   */
  authenticate(password) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        try { socket.destroy(); } catch { /* ignore */ }
        reject(err);
      };

      const connectTimer = setTimeout(() => fail(new Error('RCON connection timed out')), this.timeout);

      socket.once('error', (err) => fail(err));
      socket.once('close', () => {
        if (!settled) fail(new Error('RCON connection closed before authentication completed'));
      });

      socket.connect(this.port, this.host, () => {
        clearTimeout(connectTimer);
        socket.setNoDelay(true);

        // One persistent listener for the life of the connection -- no
        // per-execute() listener accumulation (the problem this replaces).
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => this._onClose());
        socket.on('error', (err) => this._onSocketError(err));

        const authId = allocRequestId();
        const authTimer = setTimeout(() => {
          if (this._authPending) {
            this._authPending = null;
            fail(new Error('RCON authentication timed out'));
          }
        }, this.timeout);

        this._authPending = {
          id: authId,
          resolve: () => { settled = true; clearTimeout(authTimer); resolve(); },
          reject: (err) => { clearTimeout(authTimer); fail(err); },
        };

        socket.write(encodePacket(authId, TYPE_AUTH, password));
      });
    });
  }

  _onSocketError(err) {
    if (this._authPending) {
      const pending = this._authPending;
      this._authPending = null;
      pending.reject(err);
      return;
    }
    // Reject every in-flight command; the caller's own reconnect logic
    // handles re-establishing the connection.
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  _onClose() {
    const closeErr = new Error('RCON connection closed');
    if (this._authPending) {
      const pending = this._authPending;
      this._authPending = null;
      pending.reject(closeErr);
    }
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(closeErr);
    }
    this._pending.clear();
  }

  _onData(chunk) {
    const packets = this.reader.push(chunk);
    for (const packet of packets) {
      if (this._authPending && packet.type === TYPE_AUTH_RESPONSE) {
        const pending = this._authPending;
        this._authPending = null;
        if (packet.id === -1) {
          pending.reject(new Error('RCON authentication failed (wrong password)'));
        } else {
          pending.resolve();
        }
        continue;
      }
      // Some servers send an empty SERVERDATA_RESPONSE_VALUE immediately
      // before the real SERVERDATA_AUTH_RESPONSE during auth -- harmless,
      // just ignore it (there is no pending command yet at that point, so
      // the lookup below simply won't find a match).
      if (packet.type === TYPE_RESPONSE_VALUE) {
        const entry = this._pending.get(packet.id);
        if (entry) {
          entry.parts.push(packet.body);
          // PZ / most Source RCON servers reply with a single packet per
          // command. Resolve on the first response for that id; if a
          // server ever splits a large response across multiple packets
          // sharing the same id, this would need the multi-packet
          // terminator trick -- not needed for PZ's typical output sizes.
          clearTimeout(entry.timer);
          this._pending.delete(packet.id);
          entry.resolve(entry.parts.join(''));
        }
      }
    }
  }

  /**
   * Sends a command and resolves with its response body. Rejects on
   * timeout or if the connection drops before a response arrives.
   */
  execute(command, { timeoutMs = 8000 } = {}) {
    if (!this.connected) {
      return Promise.reject(new Error('RCON not connected'));
    }
    return new Promise((resolve, reject) => {
      const id = allocRequestId();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RCON command timed out: ${command}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, parts: [] });
      this.socket.write(encodePacket(id, TYPE_EXECCOMMAND, command), (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  disconnect() {
    this._destroyed = true;
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
    }
    this.socket = null;
  }
}
