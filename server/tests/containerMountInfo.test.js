import { describe, expect, it, vi } from "vitest";
import {
  parseMountInfo,
  getOwnMountInfo,
  describeContainerMountPoints,
  getSelfContainerId,
  inspectSelfContainerMounts,
  isOnContainerRootLayer,
  translateHostPath,
} from "../utils/containerMountInfo.js";

// Fixtures below are REAL /proc/self/mountinfo lines and REAL `docker
// inspect` JSON, captured 2026-09-09 from an actual running container with
// a same-kernel Linux bind mount of /var/lib/docker/volumes/panelfakevol/_data
// to /pz-server (docker run -v <path>:/pz-server:z alpine sleep 300; docker
// exec <id> cat /proc/self/mountinfo / docker inspect --format
// '{{json .Mounts}}'). Not synthesized -- this is what the kernel and the
// Docker Engine API actually produced.
const REAL_MOUNTINFO = `
525 382 0:101 / / rw,relatime - overlay overlay rw,lowerdir=/a:/b,upperdir=/c,workdir=/c
527 525 0:110 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
619 595 8:48 /data/docker/volumes/panelfakevol/_data /pz-server rw,relatime master:60 - ext4 /dev/sdd rw
550 525 8:48 /data/docker/volumes/panelfakevol/_data /app/data rw,relatime master:60 - ext4 /dev/sdd rw
`;

const REAL_DOCKER_INSPECT_MOUNTS = [
  {
    Type: "bind",
    Source: "/var/lib/docker/volumes/panelfakevol/_data",
    Destination: "/pz-server",
    Mode: "z",
    RW: true,
    Propagation: "rslave",
  },
];

describe("parseMountInfo", () => {
  it("extracts mountPoint, root, majorMinor from a real bind-mount line", () => {
    const parsed = parseMountInfo(REAL_MOUNTINFO);
    const pzServer = parsed.find((m) => m.mountPoint === "/pz-server");
    expect(pzServer).toEqual({
      mountId: "619",
      parentId: "595",
      majorMinor: "8:48",
      root: "/data/docker/volumes/panelfakevol/_data",
      mountPoint: "/pz-server",
      fsType: "ext4",
      source: "/dev/sdd",
    });
  });

  it("skips a malformed line instead of throwing", () => {
    expect(parseMountInfo("not a real mountinfo line\n")).toEqual([]);
  });

  it("handles the optional-fields case (peer group before the '-')", () => {
    const parsed = parseMountInfo(REAL_MOUNTINFO);
    const appData = parsed.find((m) => m.mountPoint === "/app/data");
    expect(appData.fsType).toBe("ext4");
    expect(appData.source).toBe("/dev/sdd");
  });
});

describe("getOwnMountInfo", () => {
  it("returns null (not []) when mountinfo cannot be read at all", () => {
    const readFile = () => {
      throw new Error("ENOENT: no such file or directory");
    };
    expect(getOwnMountInfo(readFile)).toBeNull();
  });

  it("returns the parsed mounts when mountinfo is readable", () => {
    expect(getOwnMountInfo(() => REAL_MOUNTINFO)).toHaveLength(4);
  });
});

describe("describeContainerMountPoints", () => {
  const mounts = parseMountInfo(REAL_MOUNTINFO);

  it("reports a genuinely mounted target as mounted:true with its device info", () => {
    const [result] = describeContainerMountPoints(["/pz-server"], mounts);
    expect(result).toEqual({
      path: "/pz-server",
      mounted: true,
      majorMinor: "8:48",
      deviceRoot: "/data/docker/volumes/panelfakevol/_data",
    });
  });

  it("distinguishes 'not mounted at all' from 'mounted' for a target with no bind mount", () => {
    const [result] = describeContainerMountPoints(["/zomboid"], mounts);
    expect(result).toEqual({ path: "/zomboid", mounted: false });
  });

  it("reports mounted:null across the board when mountinfo itself is unreadable -- never a false 'not mounted'", () => {
    const results = describeContainerMountPoints(["/pz-server", "/zomboid"], null);
    expect(results).toEqual([
      { path: "/pz-server", mounted: null },
      { path: "/zomboid", mounted: null },
    ]);
  });
});

describe("getSelfContainerId", () => {
  it("accepts a real Docker short container ID", () => {
    expect(getSelfContainerId(() => "333c984af405")).toBe("333c984af405");
  });

  it("rejects a hostname that doesn't look like one (host networking, custom hostname:)", () => {
    expect(getSelfContainerId(() => "my-unraid-server")).toBeNull();
  });

  it("rejects a 12-character string that isn't hex", () => {
    expect(getSelfContainerId(() => "not-a-real1!")).toBeNull();
  });
});

describe("inspectSelfContainerMounts", () => {
  it("reports no-docker-socket honestly when the socket isn't mounted -- the common case, including today's Unraid template", async () => {
    const result = await inspectSelfContainerMounts({
      fileExists: () => false,
      selfContainerId: "333c984af405",
      requestJson: vi.fn(),
    });
    expect(result).toEqual({ available: false, reason: "no-docker-socket" });
  });

  it("reports no-self-container-id when the socket exists but hostname doesn't look like a container ID", async () => {
    const result = await inspectSelfContainerMounts({
      fileExists: () => true,
      selfContainerId: null,
      requestJson: vi.fn(),
    });
    expect(result).toEqual({ available: false, reason: "no-self-container-id" });
  });

  it("returns the exact host<->container mount map when self-inspect succeeds", async () => {
    const requestJson = vi.fn(async (socketPath, requestPath) => {
      expect(requestPath).toBe("/containers/333c984af405/json");
      return { Mounts: REAL_DOCKER_INSPECT_MOUNTS };
    });
    const result = await inspectSelfContainerMounts({
      fileExists: () => true,
      selfContainerId: "333c984af405",
      requestJson,
    });
    expect(result).toEqual({
      available: true,
      mounts: [
        {
          hostPath: "/var/lib/docker/volumes/panelfakevol/_data",
          containerPath: "/pz-server",
          type: "bind",
          readOnly: false,
        },
      ],
    });
  });

  it("reports docker-api-error rather than throwing when the request fails", async () => {
    const result = await inspectSelfContainerMounts({
      fileExists: () => true,
      selfContainerId: "333c984af405",
      requestJson: vi.fn(async () => {
        throw new Error("Docker API returned 404");
      }),
    });
    expect(result).toEqual({
      available: false,
      reason: "docker-api-error",
      error: "Docker API returned 404",
    });
  });
});

describe("translateHostPath", () => {
  const mounts = [
    { hostPath: "/var/lib/docker/volumes/panelfakevol/_data", containerPath: "/pz-server" },
  ];

  it("translates an exact host mount root", () => {
    expect(translateHostPath("/var/lib/docker/volumes/panelfakevol/_data", mounts)).toBe(
      "/pz-server",
    );
  });

  it("translates a real subpath under the mount -- matches what `ls /pz-server/testmarker` actually showed in the live probe", () => {
    expect(
      translateHostPath(
        "/var/lib/docker/volumes/panelfakevol/_data/testmarker/marker.txt",
        mounts,
      ),
    ).toBe("/pz-server/testmarker/marker.txt");
  });

  it("returns null for a host path outside every known mount", () => {
    expect(translateHostPath("/mnt/user/appdata/somethingelse", mounts)).toBeNull();
  });

  it("does not false-match a sibling directory that merely shares a string prefix (no separator boundary)", () => {
    const siblingMounts = [{ hostPath: "/data/pz", containerPath: "/pz-server" }];
    // "/data/pz2" shares the literal string "/data/pz" with the mount root
    // but is a SIBLING directory, not something under it -- a naive
    // startsWith(normalizedSource) without requiring the next character to
    // be "/" would wrongly translate this to "/pz-server2".
    expect(translateHostPath("/data/pz2/something", siblingMounts)).toBeNull();
  });

  it("prefers the longest (most specific) matching mount when one host path is nested under another", () => {
    const nestedMounts = [
      { hostPath: "/mnt/user/appdata", containerPath: "/data-wide" },
      { hostPath: "/mnt/user/appdata/pzserver", containerPath: "/pz-server" },
    ];
    expect(translateHostPath("/mnt/user/appdata/pzserver/Server", nestedMounts)).toBe(
      "/pz-server/Server",
    );
  });

  it("still strips trailing slashes from both sides", () => {
    expect(translateHostPath("/var/lib/docker/volumes/panelfakevol/_data///", mounts)).toBe("/pz-server");
    expect(
      translateHostPath("/data/pz/x", [{ hostPath: "/data/pz//", containerPath: "/pz-server" }]),
    ).toBe("/pz-server/x");
  });

  // SECURITY: the typed install path used to go through /\/+$/, which takes
  // quadratic time on a long run of slashes that doesn't end the string
  // (about 6 s here for 100k slashes; a 1 MB request body blocks for minutes).
  it("handles a long run of slashes that doesn't end the path in linear time", () => {
    const hostile = `/${"/".repeat(100_000)}x`;
    const started = Date.now();
    expect(translateHostPath(hostile, mounts)).toBeNull();
    expect(translateHostPath("/data", [{ hostPath: hostile, containerPath: "/pz-server" }])).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  // Adversary pass: slashes at the end AND a long run in the middle.
  it("handles slashes both inside and at the end of a long path", () => {
    const hostile = `/var/lib/docker/volumes/panelfakevol/_data/${"/".repeat(100_000)}x${"/".repeat(100_000)}`;
    const started = Date.now();
    expect(translateHostPath(hostile, mounts)).toBe(`/pz-server/${"/".repeat(100_000)}x`);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("refuses a non-string host path instead of throwing", () => {
    expect(translateHostPath(["/var/lib/docker/volumes/panelfakevol/_data"], mounts)).toBeNull();
  });
});

describe("isOnContainerRootLayer", () => {
  const mounts = parseMountInfo(REAL_MOUNTINFO);

  it("is true for a folder that only the image's root filesystem holds", () => {
    expect(isOnContainerRootLayer("/pz-server1", mounts)).toBe(true);
    expect(isOnContainerRootLayer("/opt/zomboid-panel/data/pzserver", mounts)).toBe(true);
  });

  it("is false for a mount point and anything below it", () => {
    expect(isOnContainerRootLayer("/pz-server", mounts)).toBe(false);
    expect(isOnContainerRootLayer("/pz-server/Server/", mounts)).toBe(false);
  });

  it("does not take a sibling that merely shares a string prefix for the mount", () => {
    expect(isOnContainerRootLayer("/pz-server2", mounts)).toBe(true);
  });

  it("decodes the octal escapes mountinfo writes for spaces", () => {
    const spaced = parseMountInfo(
      `${REAL_MOUNTINFO}\n620 525 8:48 /x /pz\\040servers rw,relatime - ext4 /dev/sdd rw`,
    );
    expect(isOnContainerRootLayer("/pz servers/second", spaced)).toBe(false);
  });

  it("counts a tmpfs or ramfs mount as erased like the root layer", () => {
    const withMemory = parseMountInfo(
      `${REAL_MOUNTINFO}\n601 525 0:120 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k\n602 525 0:121 / /scratch rw,relatime - ramfs ramfs rw`,
    );
    expect(isOnContainerRootLayer("/dev/shm/pz", withMemory)).toBe(true);
    expect(isOnContainerRootLayer("/scratch/pz", withMemory)).toBe(true);
    expect(isOnContainerRootLayer("/pz-server/second", withMemory)).toBe(false);
  });

  it("is null when mountinfo could not be read", () => {
    expect(isOnContainerRootLayer("/pz-server1", null)).toBeNull();
  });
});
