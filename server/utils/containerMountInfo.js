// Understand the panel's own container mounts well enough to translate a
// user-typed HOST path into what this container actually sees, or explain
// honestly why it cannot.
//
// THE CENTRAL FACT (hive dispatch docker-unraid-container-path-translation,
// 2026-09-09): in Docker/Unraid, the path an operator reads off their host
// (e.g. /mnt/user/appdata/pzserver) and the path THIS container sees for the
// exact same directory (e.g. /pz-server) are different strings. A validator
// that says "not found" for a path that demonstrably exists on the host is
// the bug this module exists to help fix -- but only for a path that is
// genuinely somewhere else; if nothing was ever bind-mounted here at all,
// "not found" is the correct answer and must stay that way.
//
// EMPIRICALLY VERIFIED (real containers -- a same-kernel Linux bind mount,
// 2026-09-09, not assumed):
//   - /proc/self/mountinfo, read from INSIDE a container with NO Docker
//     socket access, can only ever reveal a path relative to the underlying
//     DEVICE the bind mount's source lives on (mountinfo's "root" field) --
//     e.g. for a host bind of /var/lib/docker/volumes/x/_data, the
//     container sees root=/data/docker/volumes/x/_data, not the true
//     absolute host path. The mount-namespace boundary between container
//     and host makes the true host-visible path structurally unrecoverable
//     from mountinfo alone, on every platform including Unraid (this is a
//     Linux kernel/namespace property, not a Docker- or Unraid-specific
//     quirk). What mountinfo CAN reliably answer: whether a given
//     container-side path is a genuine distinct mount at all (something WAS
//     bound here) versus just an ordinary directory baked into the image
//     (nothing was ever mapped) -- today's plain existsSync-based discovery
//     (mountDiscovery.js) cannot tell those two apart.
//   - With Docker socket access (already an existing, opt-in,
//     security-sensitive feature in this codebase -- see dockerClient.js's
//     PANEL_DOCKER_CONTROL_ENABLED), a container CAN look up its own exact
//     Source (host path, byte-for-byte what the operator's `-v`/Unraid
//     template passed) <-> Destination (container path) mapping via
//     `GET /containers/{self}/json`, using its own hostname (Docker's
//     default short container ID, confirmed unbroken by every compose file
//     and the Unraid template this repo ships -- none set hostname: or use
//     host networking, either of which would replace it) as its own
//     container ID. This is a full, exact answer, not a heuristic -- but it
//     is gated entirely behind an opt-in the operator must grant, and the
//     current Unraid template (docker/unraid/zomboid-panel.xml) does not
//     even offer the socket mount.
import fs from "fs";
import http from "http";
import os from "os";

const MOUNTINFO_PATH = "/proc/self/mountinfo";
const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const SELF_INSPECT_TIMEOUT_MS = 3000;

// Parses /proc/self/mountinfo's documented columns:
// https://man7.org/linux/man-pages/man5/proc.5.html ("mountinfo"). Optional
// fields between the mount options and the "-" separator (peer groups,
// master IDs) are common in real output but nothing downstream here reads
// them, so they are skipped rather than parsed individually.
export function parseMountInfo(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(" ");
      const dashIndex = parts.indexOf("-");
      if (dashIndex === -1 || parts.length < dashIndex + 3) return null;
      const [mountId, parentId, majorMinor, root, mountPoint] = parts;
      return {
        mountId,
        parentId,
        majorMinor,
        root,
        mountPoint,
        fsType: parts[dashIndex + 1],
        source: parts[dashIndex + 2],
      };
    })
    .filter(Boolean);
}

// Reads and parses this process's own mountinfo. Returns null (not an empty
// array) when it cannot be read at all -- this dev/Windows machine, or a
// sandboxed runtime with no /proc -- so callers can tell "confirmed zero
// interesting mounts" apart from "could not even ask".
export function getOwnMountInfo(readFile = () => fs.readFileSync(MOUNTINFO_PATH, "utf8")) {
  try {
    return parseMountInfo(readFile());
  } catch {
    return null;
  }
}

// For each container-side path this deployment cares about (the fixed
// targets docker-compose.yml/the Unraid template declare -- /pz-server,
// /zomboid, /app/data, /app/logs -- never anything user-supplied), reports
// whether it is a genuine distinct mount or just part of the image. This is
// the honest answer mountinfo alone CAN give without Docker socket access:
// "nothing is mapped here at all" is a categorically different problem from
// "something is mapped here but it's not what you expect".
export function describeContainerMountPoints(targetPaths, mounts = getOwnMountInfo()) {
  return targetPaths.map((targetPath) => {
    if (mounts === null) return { path: targetPath, mounted: null };
    const mount = mounts.find((m) => m.mountPoint === targetPath);
    return mount
      ? { path: targetPath, mounted: true, majorMinor: mount.majorMinor, deviceRoot: mount.root }
      : { path: targetPath, mounted: false };
  });
}

// This container's own short ID, the way Docker's API expects it for a
// self-inspect call. Docker sets a container's hostname to its own short ID
// by default; every compose file and the Unraid template this repo ships
// leave that default in place (none set hostname: or use host networking,
// either of which would replace it). A hostname that doesn't look like a
// Docker short ID is deliberately reported as null rather than sent to the
// API and misread as identifying some OTHER container.
export function getSelfContainerId(hostname = () => os.hostname()) {
  const value = hostname();
  return /^[0-9a-f]{12}$/i.test(value) ? value : null;
}

// Minimal HTTP-over-unix-socket GET, mirroring dockerClient.js's own
// _requestJson. Duplicated rather than imported: that class scopes socket
// access behind PANEL_DOCKER_CONTROL_ENABLED, a broader permission (control
// over OTHER managed containers) than self-inspecting this container's own
// read-only mount record. Treated as a separate opt-in here on purpose --
// see inspectSelfContainerMounts()'s own comment; consolidate later if that
// distinction turns out not to matter.
function requestDockerJson(socketPath, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, method: "GET", path: requestPath, timeout: SELF_INSPECT_TIMEOUT_MS },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode >= 400) {
            reject(new Error(`Docker API returned ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Docker API returned invalid JSON"));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Docker API timed out")));
    request.on("error", reject);
    request.end();
  });
}

// The RELIABLE translator, when available at all: self-inspects this
// container via the Docker Engine API and returns its exact Source (host
// path, verbatim from the operator's -v/Unraid template) <-> Destination
// (container path) map -- not a heuristic, the literal string Docker itself
// was given. Requires the socket to be mounted into this container. Returns
// { available: false, reason } instead of throwing for every failure mode
// (no socket file, no usable self ID, request failure) -- an honest
// "cannot translate" must never become a false positive.
export async function inspectSelfContainerMounts({
  socketPath = DOCKER_SOCKET_PATH,
  fileExists = fs.existsSync,
  selfContainerId = getSelfContainerId(),
  requestJson = requestDockerJson,
} = {}) {
  if (!fileExists(socketPath)) {
    return { available: false, reason: "no-docker-socket" };
  }
  if (!selfContainerId) {
    return { available: false, reason: "no-self-container-id" };
  }
  try {
    const info = await requestJson(socketPath, `/containers/${selfContainerId}/json`);
    const mounts = Array.isArray(info?.Mounts)
      ? info.Mounts.map((m) => ({
          hostPath: m.Source,
          containerPath: m.Destination,
          type: m.Type,
          readOnly: m.RW === false,
        }))
      : [];
    return { available: true, mounts };
  } catch (error) {
    return { available: false, reason: "docker-api-error", error: error.message };
  }
}

// Given a host path the operator typed and the self-inspected mount map
// above, finds which (if any) of this container's own mounts it falls
// under, and what the equivalent container-side path is. Pure string
// prefix matching against Docker's own literal Source values -- no
// filesystem access, no guessing at Unraid share-vs-disk equivalence (a
// user-share path and its underlying disk path are different strings even
// on the host itself; this only ever matches what Docker itself recorded
// for THIS container).
export function translateHostPath(hostPath, mounts) {
  if (!hostPath || !Array.isArray(mounts)) return null;
  const normalizedHost = hostPath.replace(/\/+$/, "");
  let bestMatch = null;
  for (const mount of mounts) {
    if (!mount.hostPath) continue;
    const normalizedSource = mount.hostPath.replace(/\/+$/, "");
    const isMatch =
      normalizedHost === normalizedSource || normalizedHost.startsWith(`${normalizedSource}/`);
    if (!isMatch) continue;
    // Prefer the LONGEST matching source -- a nested bind mount must win
    // over a wider parent mount that also happens to prefix-match.
    if (!bestMatch || normalizedSource.length > bestMatch.normalizedSource.length) {
      bestMatch = { normalizedSource, mount };
    }
  }
  if (!bestMatch) return null;
  const remainder = normalizedHost.slice(bestMatch.normalizedSource.length);
  return bestMatch.mount.containerPath + remainder;
}
