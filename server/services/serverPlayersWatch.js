import { createLogger } from "../utils/logger.js";
import { parseBoundedInteger } from "../utils/queryNumbers.js";
import { testRconConnection } from "./rcon.js";

const log = createLogger("PlayersWatch");

// Play time and sessions per server come from PanelBridge's connect and
// disconnect events (recordPlayerSession()), and PanelBridge follows the
// active server only: on every other server, nobody's time was counted. This
// watch asks each local server other than the active one who is on, over a
// one-off RCON connection like GET /servers/rcon-status?players=1, and turns
// the difference from its last answer into sessions under that server --
// what the Players page shows once that server is the active one.
//
// A minute apart, so a session can start or end up to a minute off. The
// first look at a server continues a session already open for a player on
// it (keepOpenSession) instead of starting it over: it may have been the
// active server a moment ago, its sessions opened by PanelBridge. A server
// that becomes the active one is left to PanelBridge, sessions and all.
// RCON can miss a look (a save, a busy tick), so only MISSES_BEFORE_GONE
// misses in a row end everyone's session there.

export const PLAYERS_WATCH_INTERVAL_MS = 60 * 1000;
export const MISSES_BEFORE_GONE = 3;

// { success, names } for one server, over its own RCON settings.
export async function readServerPlayers(server, { probe = testRconConnection } = {}) {
  const host = typeof server?.rconHost === "string" ? server.rconHost.trim() : "";
  const port = parseBoundedInteger(server?.rconPort, null, 1, 65535);
  if (!host || port === null) return { success: false };
  const result = await probe({
    host,
    port,
    password: server.rconPassword || "",
    timeoutMs: 3000,
    countPlayers: true,
  });
  if (!result?.success || !Array.isArray(result.playerNames)) return { success: false };
  return { success: true, names: result.playerNames };
}

export class ServerPlayersWatch {
  constructor({
    getServers,
    getActiveServer,
    recordSession,
    readPlayers = readServerPlayers,
    readStatuses = null,
  }) {
    this.getServers = getServers;
    this.getActiveServer = getActiveServer;
    this.recordSession = recordSession;
    this.readPlayers = readPlayers;
    // GET /servers/status rows: a server the scan confirms stopped has
    // nobody on it, whatever answers on its RCON port -- another server
    // sharing that port (the Dashboard warns about it) answered with its own
    // players, who were then counted on this server too.
    this.readStatuses = readStatuses;
    // Who was on each watched server at the last answer, by server id.
    this.online = new Map();
    this.misses = new Map();
    this.ticking = false;
    this.interval = null;
  }

  start(intervalMs = PLAYERS_WATCH_INTERVAL_MS) {
    this.stop();
    this.interval = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.interval.unref?.();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [servers, active] = await Promise.all([this.getServers(), this.getActiveServer()]);
      const activeId = active?.id !== null && active?.id !== undefined ? String(active.id) : null;
      const watched = (Array.isArray(servers) ? servers : []).filter(
        (server) => server && !server.isRemote && String(server.id) !== activeId,
      );
      const watchedIds = new Set(watched.map((server) => String(server.id)));
      // Deleted, or now the active server: PanelBridge's from here on.
      for (const id of [...this.online.keys()]) {
        if (!watchedIds.has(id)) {
          this.online.delete(id);
          this.misses.delete(id);
        }
      }
      if (watched.length === 0) return;
      let rows = new Map();
      if (this.readStatuses) {
        try {
          rows = new Map(((await this.readStatuses()) || []).map((row) => [String(row?.id), row]));
        } catch (error) {
          log.debug(`Players watch could not read the servers' states: ${error.message}`);
        }
      }
      for (const server of watched) {
        const row = rows.get(String(server.id));
        const stopped = Boolean(row && !row.stateUnknown && row.running === false);
        await this.lookAt(server, { stopped });
      }
    } catch (error) {
      log.debug(`Players watch tick failed: ${error.message}`);
    } finally {
      this.ticking = false;
    }
  }

  async lookAt(server, { stopped = false } = {}) {
    const id = String(server.id);
    const before = this.online.get(id);
    let answer;
    if (stopped) {
      answer = { success: true, names: [] };
    } else {
      try {
        answer = await this.readPlayers(server);
      } catch {
        answer = { success: false };
      }
    }

    if (!answer?.success) {
      const misses = (this.misses.get(id) || 0) + 1;
      this.misses.set(id, misses);
      if (misses >= MISSES_BEFORE_GONE && before && before.size > 0) {
        for (const name of before) await this.recordSession(name, "disconnect", server.id);
        this.online.set(id, new Set());
      }
      return;
    }
    this.misses.set(id, 0);

    const now = new Set(answer.names);
    if (before === undefined) {
      for (const name of now) {
        await this.recordSession(name, "connect", server.id, { keepOpenSession: true });
      }
    } else {
      for (const name of now) {
        if (!before.has(name)) await this.recordSession(name, "connect", server.id);
      }
      for (const name of before) {
        if (!now.has(name)) await this.recordSession(name, "disconnect", server.id);
      }
    }
    this.online.set(id, now);
  }
}
