import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Linux bug hunt 2026-08-29, server-discovery card. mountDiscovery.js's
// COMMON_MOUNT_CANDIDATES are all container-internal Docker bind-mount
// conventions (/pz-server, /serverdata/serverfiles, /steam/pz) -- real paths
// only inside a container built to that convention. The panel also runs
// bare-metal on Linux (the packaged build), where a genuine SteamCMD install
// lives at one of a few real host paths instead -- exactly the ones
// zomboidPaths.js's computeCandidateZomboidPaths() has anticipated on the
// save-data side for a long time (~/pzserver/Zomboid, /opt/pzserver/Zomboid,
// /srv/pz/Zomboid). Before this fix, discoverMounts() had zero install-side
// candidates for any of these, so the "Discover" scan -- shown unconditionally
// on every deployment, per Servers.tsx -- came up empty for a bare-metal
// Linux operator no matter how standard their layout was.

let tmpHome;

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

afterEach(() => {
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = undefined;
  vi.unstubAllEnvs();
});

function buildInstall(installDir) {
  fs.mkdirSync(path.join(installDir, "media", "lua"), { recursive: true });
  fs.mkdirSync(path.join(installDir, "steamapps"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "ProjectZomboid64"), "binary");
  fs.writeFileSync(path.join(installDir, "start-server.sh"), "#!/bin/bash\n");
}

function buildData(dataDir, serverName = "servertest") {
  fs.mkdirSync(path.join(dataDir, "Server"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "Server", `${serverName}.ini`),
    "RCONPort=27015\n",
  );
  fs.mkdirSync(path.join(dataDir, "Saves"), { recursive: true });
}

describe("discoverMounts(): bare-metal Linux SteamCMD layouts", () => {
  it.skipIf(process.platform === "win32")(
    "finds a ~/pzserver install with data at PZ's own real default cachedir (~/Zomboid, NOT nested under the install)",
    async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discovery-home-"));
      const installDir = path.join(tmpHome, "pzserver");
      const dataDir = path.join(tmpHome, "Zomboid");
      buildInstall(installDir);
      buildData(dataDir);

      const { discoverMounts } = await import("../services/mountDiscovery.js");
      const mounts = discoverMounts();

      expect(mounts).toContainEqual(
        expect.objectContaining({
          installPath: installDir,
          dataPath: dataDir,
          source: "linux-bare-metal",
          serverNames: ["servertest"],
        }),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "prefers a Zomboid folder nested under the install over the $HOME fallback, when both exist",
    async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discovery-home-"));
      const installDir = path.join(tmpHome, "pzserver");
      const nestedData = path.join(installDir, "Zomboid");
      const homeData = path.join(tmpHome, "Zomboid");
      buildInstall(installDir);
      buildData(nestedData, "nested-server");
      buildData(homeData, "home-server");

      const { discoverMounts } = await import("../services/mountDiscovery.js");
      const mounts = discoverMounts();
      const found = mounts.find((m) => m.installPath === installDir);

      expect(found.dataPath).toBe(nestedData);
      expect(found.serverNames).toEqual(["nested-server"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not report a bare-metal candidate when nothing is there (no false positive on a clean host)",
    async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discovery-home-"));
      // Deliberately build nothing under tmpHome.
      const { discoverMounts } = await import("../services/mountDiscovery.js");
      const mounts = discoverMounts();
      expect(mounts.some((m) => m.source === "linux-bare-metal")).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "recognizes the alternate real launcher-script name (projectzomboid-dedi-server.sh), not just start-server.sh",
    async () => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-discovery-home-"));
      const installDir = path.join(tmpHome, "pzserver");
      // Build an install that ONLY has the alternate script name -- no
      // start-server.sh, no ProjectZomboid64 binary, no media/lua, no
      // steamapps -- so hasStartScript is the ONLY thing that can make this
      // probe valid, isolating exactly the condition this test checks.
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(
        path.join(installDir, "projectzomboid-dedi-server.sh"),
        "#!/bin/bash\n",
      );

      const { probeInstallPath } = await import("../services/mountDiscovery.js");
      const result = probeInstallPath(installDir);
      expect(result.valid).toBe(true);
      expect(result.hasStartScript).toBe(true);
    },
  );
});
