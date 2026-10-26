import fs from "fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("OtherServerUpdates");

// The mod checker (modChecker.js) and the game update checker
// (updateChecker.js) follow the active server: a Workshop mod updated on
// Steam left every other server on the old version -- and refusing players
// who already have the new one -- with nothing on screen, and the mod
// update restart never reached them either. This check looks at each local
// server other than the active one:
//   - mods: the Workshop items its .ini lists (WorkshopItems=) against
//     Steam, from the appworkshop ACF in its own install (the same lookup
//     the mod checker does, getWorkshopAcfCandidates());
//   - the game: its install's build (appmanifest) against Steam's latest
//     for its branch -- detected and shown only: updating a server's files
//     means stopping it and running SteamCMD, which stays an operator's
//     call on its own Dashboard.
// When the mod checker's automatic restart is on, a running server with
// mods behind is restarted to load them (the server downloads Workshop
// updates as it starts), with the mod checker's warning to its players --
// once per set of updates, so a download that keeps failing doesn't
// restart it in a loop.

export const UPDATES_INTERVAL_MS = 15 * 60 * 1000;
// Steam's latest build per branch is a SteamCMD query of up to a minute,
// shared by every server on that branch and asked again at most this often.
export const LATEST_BUILD_TTL_MS = 60 * 60 * 1000;

function displayName(server) {
  return server?.name || server?.serverName || String(server?.id ?? "server");
}

// Workshop ids from a WorkshopItems= value ("123;456").
export function workshopIdsOf(config) {
  const raw = config?.WorkshopItems;
  if (raw === undefined || raw === null) return null;
  return String(raw)
    .split(";")
    .map((id) => id.trim())
    .filter((id) => /^\d{1,15}$/.test(id));
}

// The local ACF's timeupdated per Workshop id, from the mod checker's parser.
export function localWorkshopTimestamps(parsed) {
  const local = new Map();
  for (const [id, data] of Object.entries(parsed?.installedMods || {})) {
    local.set(String(id), Number(data?.timeupdated) || 0);
  }
  for (const [id, data] of Object.entries(parsed?.modDetails || {})) {
    if (!local.has(String(id))) local.set(String(id), Number(data?.timeupdated) || 0);
  }
  return local;
}

export class OtherServerUpdates {
  /**
   * @param {object} deps
   * @param {() => Promise<object[]>} deps.getServers
   * @param {() => Promise<object|null>} deps.getActiveServer
   * @param {(server) => Promise<object|null>} deps.readServerConfig  the server's .ini as key/values
   * @param {(installPath) => string[]} deps.acfCandidates
   * @param {(content: string) => object} deps.parseAcf
   * @param {(ids: string[]) => Promise<{result: Map}>} deps.fetchWorkshop
   * @param {(installPath) => Promise<{buildId, branch}|null>} deps.installedBuild
   * @param {(branch, installPath) => Promise<{buildId}|null>} deps.latestBuild
   * @param {() => Promise<object[]>} deps.readStatuses  GET /servers/status rows
   * @param {() => {autoRestart: boolean, warningMinutes: number}} deps.modRestartSettings
   * @param {(server, warningMinutes) => Promise<{success}>} deps.restartServer
   * @param {(payload) => void} [deps.emit]
   */
  constructor({
    getServers,
    getActiveServer,
    readServerConfig,
    acfCandidates,
    parseAcf,
    fetchWorkshop,
    installedBuild,
    latestBuild,
    readStatuses,
    modRestartSettings,
    restartServer,
    logEvent = async () => {},
    emit = () => {},
    now = () => Date.now(),
    readFile = (file) => fs.promises.readFile(file, "utf8"),
    fileExists = (file) => fs.existsSync(file),
  }) {
    Object.assign(this, {
      getServers,
      getActiveServer,
      readServerConfig,
      acfCandidates,
      parseAcf,
      fetchWorkshop,
      installedBuild,
      latestBuild,
      readStatuses,
      modRestartSettings,
      restartServer,
      logEvent,
      emit,
      now,
      readFile,
      fileExists,
    });
    // serverId -> { mods, game }
    this.results = new Map();
    // branch -> { buildId, at }
    this.latestBuilds = new Map();
    // serverId -> the set of updates it was last restarted for
    this.restartedFor = new Map();
    this.checking = false;
    this.interval = null;
    this.firstRun = null;
  }

  start(intervalMs = UPDATES_INTERVAL_MS, firstRunDelayMs = 5 * 60 * 1000) {
    this.stop();
    this.firstRun = setTimeout(() => void this.checkAll(), firstRunDelayMs);
    this.firstRun.unref?.();
    this.interval = setInterval(() => void this.checkAll(), intervalMs);
    this.interval.unref?.();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    if (this.firstRun) clearTimeout(this.firstRun);
    this.interval = null;
    this.firstRun = null;
  }

  // For GET /api/servers/updates: one entry per checked server.
  getResults() {
    return [...this.results.entries()].map(([serverId, result]) => ({ serverId, ...result }));
  }

  async checkAll() {
    if (this.checking) return this.getResults();
    this.checking = true;
    try {
      const [servers, active] = await Promise.all([this.getServers(), this.getActiveServer()]);
      const activeId = active?.id !== null && active?.id !== undefined ? String(active.id) : null;
      const watched = (Array.isArray(servers) ? servers : []).filter(
        (server) => server && !server.isRemote && String(server.id) !== activeId,
      );
      const watchedIds = new Set(watched.map((server) => String(server.id)));
      for (const id of [...this.results.keys()]) {
        if (!watchedIds.has(id)) this.results.delete(id);
      }
      if (watched.length === 0) return [];

      const modsByServer = new Map();
      for (const server of watched) {
        modsByServer.set(String(server.id), await this.readLocalMods(server));
      }
      const wanted = [
        ...new Set(
          [...modsByServer.values()].flatMap((mods) => (mods.relevant ? [...mods.relevant.keys()] : [])),
        ),
      ];
      let steam = new Map();
      let steamError = null;
      if (wanted.length > 0) {
        try {
          steam = (await this.fetchWorkshop(wanted))?.result || new Map();
          if (steam.size === 0) steamError = "steamUnavailable";
        } catch (error) {
          steamError = "steamUnavailable";
          log.debug(`Steam Workshop query failed: ${error.message}`);
        }
      }

      // Each server's state and its process's start, read once: a mod
      // installed after that start is on disk but not what the server loaded.
      let statuses = null;
      try {
        statuses = new Map(((await this.readStatuses()) || []).map((row) => [String(row.id), row]));
      } catch (error) {
        log.debug(`Could not read the servers' states: ${error.message}`);
      }

      const checkedAt = new Date(this.now()).toISOString();
      for (const server of watched) {
        const id = String(server.id);
        const mods = modsByServer.get(id);
        const row = statuses?.get(id);
        const startedAtMs = row?.running && !row.stateUnknown && row.startedAt ? Date.parse(row.startedAt) : NaN;
        const modResult = mods.error
          ? { outdated: [], error: mods.error, checkedAt }
          : steamError
            ? { outdated: [], error: steamError, checkedAt }
            : { outdated: this.outdatedMods(mods.relevant, steam, startedAtMs), checkedAt };
        const game = await this.checkGame(server, checkedAt);
        this.results.set(id, { mods: modResult, game });
      }

      await this.restartForModUpdates(watched, statuses);
      this.emit({ servers: this.getResults() });
      return this.getResults();
    } catch (error) {
      log.debug(`Other servers' update check failed: ${error.message}`);
      return this.getResults();
    } finally {
      this.checking = false;
    }
  }

  // { relevant: Map(id -> local timeupdated) } for the mods the server's ini
  // lists and its install has, or { error }.
  async readLocalMods(server) {
    const installPath = server.serverPath || server.installPath;
    const acfPath = (this.acfCandidates(installPath) || []).find((candidate) => this.fileExists(candidate));
    if (!acfPath) return { error: "noWorkshopFile" };
    let config;
    try {
      config = await this.readServerConfig(server);
    } catch {
      config = null;
    }
    const listed = workshopIdsOf(config);
    if (listed === null) return { error: "noServerConfig" };
    let parsed;
    try {
      let content = await this.readFile(acfPath);
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      parsed = this.parseAcf(content);
    } catch {
      return { error: "noWorkshopFile" };
    }
    const local = localWorkshopTimestamps(parsed);
    const relevant = new Map();
    for (const id of listed) {
      if (local.has(id)) relevant.set(id, local.get(id));
    }
    return { relevant };
  }

  // Behind Steam, or -- for a running server, `startedAtMs` its process's
  // start -- installed in a version Steam published after that start. Servers
  // sharing an install share its Workshop folder: another server's restart
  // downloads the update there, the ACF then matches Steam, and this server,
  // still running the version it loaded, looked up to date and was never
  // restarted for it.
  outdatedMods(relevant, steam, startedAtMs = NaN) {
    const outdated = [];
    for (const [id, localTime] of relevant) {
      const latest = steam.get(id);
      const loadedOlder = Number.isFinite(startedAtMs) && localTime * 1000 > startedAtMs;
      if (latest && (Number(latest.time_updated) > localTime || loadedOlder)) {
        outdated.push({
          workshopId: id,
          name: latest.title || `Workshop ${id}`,
          latestAt: new Date(Number(latest.time_updated) * 1000).toISOString(),
        });
      }
    }
    return outdated;
  }

  async checkGame(server, checkedAt) {
    const installPath = server.serverPath || server.installPath;
    let installed = null;
    try {
      installed = installPath ? await this.installedBuild(installPath) : null;
    } catch {
      installed = null;
    }
    if (!installed?.buildId) return { error: "noInstalledBuild", checkedAt };
    const branch = installed.branch || "public";
    let latest = this.latestBuilds.get(branch);
    if (!latest || this.now() - latest.at > LATEST_BUILD_TTL_MS) {
      try {
        const info = await this.latestBuild(branch, installPath);
        if (info?.buildId) {
          latest = { buildId: String(info.buildId), at: this.now() };
          this.latestBuilds.set(branch, latest);
        }
      } catch (error) {
        log.debug(`Latest build for branch ${branch} unavailable: ${error.message}`);
      }
    }
    if (!latest?.buildId) {
      return { installedBuild: String(installed.buildId), branch, error: "noLatestBuild", checkedAt };
    }
    const installedBuild = Number.parseInt(installed.buildId, 10);
    const latestBuild = Number.parseInt(latest.buildId, 10);
    return {
      installedBuild: String(installed.buildId),
      latestBuild: latest.buildId,
      branch,
      updateAvailable:
        Number.isFinite(installedBuild) && Number.isFinite(latestBuild) && latestBuild > installedBuild,
      checkedAt,
    };
  }

  // One running server at a time: the scheduler runs one restart at once.
  // `running`: the servers' states by id, null when they couldn't be read.
  async restartForModUpdates(watched, running) {
    const settings = this.modRestartSettings?.() || {};
    if (!settings.autoRestart) return;
    for (const server of watched) {
      const id = String(server.id);
      const outdated = this.results.get(id)?.mods?.outdated || [];
      if (outdated.length === 0) {
        this.restartedFor.delete(id);
        continue;
      }
      const key = outdated
        .map((mod) => `${mod.workshopId}@${mod.latestAt}`)
        .sort()
        .join(",");
      if (this.restartedFor.get(id) === key) continue;
      if (!running) return;
      const row = running.get(id);
      if (!row || row.stateUnknown || !row.running) continue;

      this.restartedFor.set(id, key);
      const names = outdated.map((mod) => mod.name).join(", ");
      log.info(`Restarting ${displayName(server)} to load updated mods: ${names}`);
      await this.logEvent("mod_update_restart", `${displayName(server)}: restarting to load updated mods (${names})`, server.id);
      try {
        const result = await this.restartServer(server, settings.warningMinutes ?? 5);
        if (!result?.success) {
          // Not restarted (another restart running, RCON down...): the next
          // check tries again. Restarted but still behind (a download that
          // failed) keeps the key, so that one isn't retried in a loop.
          this.restartedFor.delete(id);
          await this.logEvent(
            "mod_update_restart_error",
            `${displayName(server)} was not restarted for its mod updates: ${result?.message || result?.error || "no reason was given"}`,
            server.id,
          );
        }
      } catch (error) {
        this.restartedFor.delete(id);
        await this.logEvent(
          "mod_update_restart_error",
          `${displayName(server)} was not restarted for its mod updates: ${error.message}`,
          server.id,
        );
      }
    }
  }
}
