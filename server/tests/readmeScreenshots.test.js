import { describe, expect, it } from "vitest";
import fs from "node:fs";

// The README's screenshots once came from a real panel and showed the host's
// public IP. They are now taken from the demo build (client/src/lib/demo.ts),
// so what keeps real addresses out of them is the demo data itself: only
// loopback, private-range and documentation addresses may appear there.

const PRIVATE_OR_TEST = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^255\./,
  /^192\.0\.2\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
];

describe("README screenshots", () => {
  it("the README shows the dashboard screenshot", () => {
    expect(fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8")).toContain("(Screenshots/screenshot-dashboard-v2.png)");
  });

  it("the demo data the screenshots are taken from holds no public IPv4 address", () => {
    const demo = fs.readFileSync(new URL("../../client/src/lib/demo.ts", import.meta.url), "utf8");
    const addresses = demo.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
    const valid = addresses.filter((ip) => ip.split(".").every((part) => Number(part) <= 255));
    const exposed = valid.filter((ip) => !PRIVATE_OR_TEST.some((range) => range.test(ip)));
    expect(exposed).toEqual([]);
  });
});
