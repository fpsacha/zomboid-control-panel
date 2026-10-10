import { createLogger } from "../utils/logger.js";
import { warnLeaderboardReadFailed } from "./leaderboardDiagnostics.js";

const log = createLogger("LeaderboardSampler");

// Stopgap for PanelBridge 1.7.73 and older, which read kills and days only
// when the panel asks for the leaderboard (the Leaderboard page, a
// character sheet): a player who played while nobody watched kept 0 kills,
// or had no row. Every 2 minutes while players are online this asks once.
// Safe on 1.7.73: its death path keeps the kill baseline, so reading a
// dead player still listed only credits that life's kills.
//
// A newer bridge reads every player itself and says so with
// diagnostics.lastSweepAt; from then on this stays idle while that bridge
// version is connected, and picks up again for any other version (a server
// switch, a downgrade). A bridge without getLeaderboard (before 1.7.69) is
// asked once per mod session. One read in flight at most; nothing here
// throws.

export const LEADERBOARD_SAMPLER_INTERVAL_MS = 2 * 60 * 1000;

// getLeaderboard came with PanelBridge 1.7.69. An older bridge answers this,
// logs a WARN on both sides and counts a failed command, every time.
const UNKNOWN_COMMAND_RE = /^Unknown command: getLeaderboard/;

let state = null;

function bridgeConnected(bridge) {
  try {
    return Boolean(bridge?.isRunning && bridge.isModConnected());
  } catch {
    return false;
  }
}

function hasOnlinePlayers(bridge) {
  const players = bridge?.modStatus?.players;
  if (Array.isArray(players)) return players.some((name) => typeof name === "string" && name.length > 0);
  if (players && typeof players === "object") return Object.keys(players).length > 0;
  return false;
}

function bridgeVersion(bridge) {
  const version = bridge?.modStatus?.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

// status.json's version and the mod's start time, as characterSheet.js keys
// its own unsupported bridges: an updated or restarted mod is asked again.
function bridgeSession(bridge) {
  const status = bridge?.modStatus;
  return `${status?.version ?? ""}|${status?.startedAt ?? ""}`;
}

// What a read returned, for the log and the support bundle: how many rows,
// which online players have none, how many were never read. The "missing
// player" reports come with no other evidence.
function summarize(bridge, data) {
  const rows = Array.isArray(data?.players) ? data.players : [];
  const online = Array.isArray(bridge?.modStatus?.players)
    ? bridge.modStatus.players.filter((n) => typeof n === "string" && n)
    : [];
  const names = new Set(rows.map((r) => String(r?.username ?? "").toLowerCase()));
  const noRow = online.filter((n) => !names.has(n.toLowerCase()));
  const notRead = rows.filter((r) => r && r.everRead === false).length;
  return { rows: rows.length, online: online.length, onlineWithoutRow: noRow.slice(0, 10), notRead, at: Date.now() };
}

async function sample(current) {
  if (current.inFlight || !bridgeConnected(current.bridge) || !hasOnlinePlayers(current.bridge)) return;
  const version = bridgeVersion(current.bridge);
  if (current.bridgeSweeps && current.bridgeSweepsVersion === version) return;
  const session = bridgeSession(current.bridge);
  if (current.unsupportedSession === session) return;
  current.bridgeSweeps = false;
  current.unsupportedSession = null;
  current.inFlight = true;
  try {
    const result = await current.bridge.getLeaderboard({ source: "sampler" });
    if (state !== current) return;
    current.lastSampleAt = Date.now();
    current.lastSummary = summarize(current.bridge, result?.data);
    if (Date.now() - (current.lastSummaryLogAt || 0) > 10 * 60 * 1000) {
      current.lastSummaryLogAt = Date.now();
      const x = current.lastSummary;
      log.info(
        `Leaderboard read: ${x.rows} rows, ${x.online} online, ${x.notRead} never read` +
          (x.onlineWithoutRow.length ? `, online with no row: ${x.onlineWithoutRow.join(", ")}` : ""),
      );
    }
    if (typeof result?.data?.diagnostics?.lastSweepAt === "number") {
      current.bridgeSweeps = true;
      current.bridgeSweepsVersion = version;
      log.info(`PanelBridge ${version ?? "(unknown version)"} reads the leaderboard itself; the panel stops asking`);
    }
  } catch (error) {
    if (UNKNOWN_COMMAND_RE.test(String(error?.message ?? ""))) {
      current.unsupportedSession = session;
      log.info(
        `PanelBridge ${version ?? "(unknown version)"} has no getLeaderboard; the panel stops asking until the mod is updated or restarted`,
      );
      return;
    }
    warnLeaderboardReadFailed(log, "the leaderboard sampler", error);
  } finally {
    current.inFlight = false;
  }
}

export function startLeaderboardSampler(panelBridge) {
  stopLeaderboardSampler();
  if (!panelBridge || typeof panelBridge.getLeaderboard !== "function") return;
  const current = {
    bridge: panelBridge,
    inFlight: false,
    bridgeSweeps: false,
    bridgeSweepsVersion: null,
    unsupportedSession: null,
    lastSampleAt: null,
    timer: null,
  };
  current.timer = setInterval(() => {
    sample(current).catch(() => {});
  }, LEADERBOARD_SAMPLER_INTERVAL_MS);
  current.timer.unref?.();
  state = current;
}

export function stopLeaderboardSampler() {
  const current = state;
  state = null;
  if (current) clearInterval(current.timer);
}

/** For the support bundle: whether the panel is still asking, and why not. */
export function getLeaderboardSamplerStatus() {
  if (!state) return { running: false };
  return {
    running: true,
    intervalMs: LEADERBOARD_SAMPLER_INTERVAL_MS,
    bridgeSweeps: state.bridgeSweeps,
    bridgeSweepsVersion: state.bridgeSweeps ? state.bridgeSweepsVersion : null,
    bridgeLacksLeaderboard: state.unsupportedSession !== null,
    lastSampleAt: state.lastSampleAt,
    lastSummary: state.lastSummary ?? null,
  };
}
