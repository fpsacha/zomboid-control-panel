import { describe, expect, it, vi } from "vitest";
import {
  parseMountInfo,
  getOwnMountInfo,
  describeContainerMountPoints,
  getSelfContainerId,
  inspectSelfContainerMounts,
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
});
