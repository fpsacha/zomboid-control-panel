import { describe, expect, it } from "vitest";
import { findServerErrors } from "../utils/serverErrorFinder.js";

// SECURITY (2026-10-28): Problems found reads the panel's in-memory log, and
// that log also holds text from POST /api/debug/client-errors, which takes
// reports before sign-in (a broken login page must still be able to report
// itself). Its warning line is "[ClientError] <message>". The Windows
// process-scan finding matched its signature anywhere in a line, so a
// stranger posting three reports raised "the panel's check for the server
// process failed" on every admin's Problems found. Only ServerManager's own
// line counts now.

const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const at = (i) => new Date(NOW + i * 10_000).toISOString();

function serverManagerLine(i) {
  return {
    level: "warn",
    source: "Server",
    timestamp: at(i),
    message: "getServerProcessDetails: Windows process scan failed (timed out), cannot determine server state",
  };
}

// What routes/debug.js logs for a client report (escapeLogText leaves this
// printable text as is).
function clientReport(i, message) {
  return {
    level: "warn",
    source: "API:Debug",
    timestamp: at(i),
    message: `[ClientError] ${message}`,
  };
}

describe("Problems found: a client error report can't pose as a failing process scan", () => {
  it("ignores reports that carry the process-scan signature", () => {
    const forged = "getServerProcessDetails: Windows process scan failed (timed out), cannot determine server state";
    const panelLog = [0, 1, 2, 3].map((i) => clientReport(i, forged));
    expect(findServerErrors({ panelLog }).findings).toEqual([]);
  });

  // Adversary pass: the report's other fields (error detail, page URL) are
  // appended after the message, and a line break is escaped by the logger,
  // so neither puts the signature at the start of a line either.
  it("ignores the signature in a report's detail, URL or after an escaped line break", () => {
    const sig = "Windows process scan failed (timed out)";
    const panelLog = [
      clientReport(0, `x -- ${sig}`),
      clientReport(1, `x (page: http://p/${sig})`),
      clientReport(2, `x\\ngetServerProcessDetails: ${sig}`),
      clientReport(3, `x\\rgetServerProcessDetails: ${sig}`),
    ];
    expect(findServerErrors({ panelLog }).findings).toEqual([]);
  });

  it("still counts ServerManager's own warnings, with forged reports mixed in", () => {
    const panelLog = [
      serverManagerLine(0),
      clientReport(1, "getServerProcessDetails: Windows process scan failed (timed out)"),
      serverManagerLine(2),
      serverManagerLine(3),
    ];
    const { findings } = findServerErrors({ panelLog });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "processScanFailing", count: 3, params: { n: 3, timedOut: true } });
  });
});
