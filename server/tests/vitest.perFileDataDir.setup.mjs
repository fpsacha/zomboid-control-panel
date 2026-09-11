// bug-hunt-2026-08-26: replaces vitest.globalSetup.mjs's approach of minting
// ONE temp dataDir for the entire `vitest run` invocation. That design meant
// every test file importing the real, unmocked server/database/init.js (12
// of them as of this fix -- adminPasswordFirstBoot, bugfixes,
// circuitBreakerStatus, db-tmp-cleanup, oidcRoutes, reassignRoleMembers,
// rolesMigration, rolesMigrationMatchesSeed, serverPathEnvFallback,
// serverRconSecretsE2E, upnpEditAppliesLive, v1MigrationDryRun) got its OWN
// in-memory lowdb snapshot (vitest's default isolate:true resets the module
// registry per file) but all of them wrote the ENTIRE snapshot back to the
// SAME physical db.json on every commit, with no lock and no merge -- a
// silent last-writer-wins race. Confirmed to produce both a false failure (a
// file's own correct write erased by another file's write before it reads
// its own data back) and a false pass (an assertion satisfied by ambient
// state another file happened to leave behind, for a reason unrelated to
// the code actually under test).
//
// Fix: stop sharing the file. Give every test FILE its own temp root
// instead of one per run -- no locking or merge strategy added on top,
// because coordinating access to a file that should never have been shared
// is worse than just not sharing it.
//
// WHY A setupFiles SCRIPT WORKS HERE, where vitest.globalSetup.mjs's own
// comment once warned "a setupFiles hook would be too late": that warning
// was about the ORIGINAL constraint -- PANEL_PATHS_CONFIG_PATH had to be in
// process.env before vitest forked worker processes, because a forked
// child's env is a snapshot taken at fork time. This script has a
// DIFFERENT job: give each *file* its own value, not hand one value to
// every worker before they exist. vitest guarantees setupFiles run, per
// file, before that file's own module graph is imported -- and
// server/utils/paths.js reads PANEL_PATHS_CONFIG_PATH into a module-level
// const at ITS OWN import time. Under isolate:true (this suite's default,
// unchanged -- see vitest.config.js), paths.js is re-evaluated fresh for
// every file, so setting the env var here, before that happens, is
// sufficient. process.env itself is NOT reset between files that share a
// worker process (module isolation resets the module registry, not
// process.env) -- but that's harmless here, because this script overwrites
// PANEL_PATHS_CONFIG_PATH to a fresh per-file value every time it runs,
// strictly before the file whose setup it is ever imports paths.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-test-"));
const configPath = path.join(tempRoot, "paths.config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      dataDir: path.join(tempRoot, "data"),
      logsDir: path.join(tempRoot, "logs"),
    },
    null,
    2,
  ),
  "utf8",
);
process.env.PANEL_PATHS_CONFIG_PATH = configPath;

async function removeTempRoot() {
  const retryableCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  const attempts = 20;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.promises.rm(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      return;
    } catch (error) {
      if (!retryableCodes.has(error?.code) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

afterAll(async () => {
  delete process.env.PANEL_PATHS_CONFIG_PATH;
  // map-proxy-enotempty, 2026-09-09: a test file can leave its own
  // fire-and-forget disk writes (e.g. mapProxy.js's writeDiskCacheAsync)
  // still landing a file under tempRoot when its last `it()` returns --
  // reproduced directly (100 concurrent copies of
  // mapProxyTileBrowserCacheStaleness.test.js, fired twice) as
  // `ENOTEMPTY` thrown by this exact rmSync on Windows, with every real
  // assertion in the file already green. rmSync's own maxRetries defaults
  // to 0, so it never retries on its own. A few short retries give an
  // already-in-flight write (mkdir/writeFile/rename on this process's own
  // libuv threadpool) time to land; deliberately bounded -- a genuinely
  // stuck handle still surfaces after the retry budget instead of hanging
  // the teardown.
  await removeTempRoot();
});
