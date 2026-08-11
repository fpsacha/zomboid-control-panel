import { describe, expect, it } from "vitest";
import { isManagedContainer, lifecycleTimeoutMs, parseContainerStats } from "../services/dockerClient.js";

describe("Docker managed-container boundary", () => {
  it("accepts only containers explicitly opted into panel management", () => {
    expect(isManagedContainer({ Labels: { "zomboid-panel.managed": "true" } })).toBe(true);
    expect(isManagedContainer({ Config: { Labels: { "zomboid-panel.managed": "true" } } })).toBe(true);
    expect(isManagedContainer({ Labels: { "zomboid-panel.role": "pz-server" } })).toBe(false);
    expect(isManagedContainer({ Image: "ich777/steamcmd:projectzomboid", Labels: {} })).toBe(false);
  });
});

describe("lifecycleTimeoutMs", () => {
  it("waits out the container's own stop grace period", () => {
    // A modded B42 world sets stop_grace_period: 90s, which Compose writes to
    // the container as StopTimeout. Anything shorter aborts the socket and
    // reports a failure on a stop Docker went on to complete.
    const container = { Config: { StopTimeout: 90 } };
    expect(lifecycleTimeoutMs("stop", container)).toBeGreaterThan(90_000);
    expect(lifecycleTimeoutMs("restart", container)).toBeGreaterThan(
      lifecycleTimeoutMs("stop", container),
    );
  });

  it("falls back to Docker's own default when the container sets no timeout", () => {
    expect(lifecycleTimeoutMs("stop", { Config: {} })).toBe(10_000 + 30_000);
    expect(lifecycleTimeoutMs("stop", undefined)).toBe(10_000 + 30_000);
  });

  it("does not budget a shutdown window for a start", () => {
    expect(lifecycleTimeoutMs("start", { Config: { StopTimeout: 90 } })).toBe(30_000);
  });
});

describe("parseContainerStats", () => {
  it("calculates bounded CPU, memory, network, and disk counters", () => {
    expect(parseContainerStats({
      cpu_stats: { system_cpu_usage: 2000, online_cpus: 2, cpu_usage: { total_usage: 500, percpu_usage: [250, 250] } },
      precpu_stats: { system_cpu_usage: 1000, cpu_usage: { total_usage: 200 } },
      memory_stats: { usage: 512, limit: 1024 },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 5, tx_bytes: 7 } },
      blkio_stats: { io_service_bytes_recursive: [{ op: "Read", value: 3 }, { op: "Write", value: 4 }] },
    })).toEqual({
      cpuPercent: 60,
      memoryUsed: 512,
      memoryLimit: 1024,
      memoryPercent: 50,
      networkRx: 15,
      networkTx: 27,
      diskRead: 3,
      diskWrite: 4,
    });
  });
});
