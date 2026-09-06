import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// bug-hunt-2026-09-04..06, activeServerChanged sweep: an "active server"
// concept was added to a panel that started single-server, and every page
// below either (a) resolved its data implicitly against "whichever server
// is active" server-side without ever re-reading that value after mount,
// or (b) took an action (RCON, a file delete, a save) that the backend also
// resolves against "whichever server is active right now" -- so switching
// the active server elsewhere in the app left the page showing (or acting
// on) the PREVIOUS server while the real target had already moved. Twelve
// pages got fixed one at a time over three sessions; see each page's own
// commit for the specific shape (block-and-warn for persisted form state
// -- ServerConfig/Backups/Mods/ChunkCleaner -- vs. reload-unconditionally
// for read-only displays -- Console/Dashboard/Settings/Players/Events/
// Chat/Debug/WorldMap).
//
// THIS IS A TEXT-LEVEL GUARD, NOT BEHAVIOURAL COVERAGE (same technique and
// same caveat as worldMapTileUrl.wiringGuard.test.ts): it reads each page
// file off disk and asserts the literal `activeServerChanged` handler
// registration is still present. It cannot tell whether the handler does
// the RIGHT thing, only that a handler exists at all. That is deliberately
// the whole point: the risk this guards against is not any ONE of these
// twelve pages regressing (a render test would catch that, at a much
// higher cost, one page at a time) -- it is page THIRTEEN shipping with an
// implicit-active-server resolution and no listener, which is exactly how
// all twelve of these got here in the first place. Every server-scoped
// page from here on either adds itself to this list (with a listener) or
// to the exclusion list below (with a reason) -- an omission from both is
// the hole this test exists to close.
//
// EXCLUDED, each independently verified (not assumed) to have NO
// activeServerChanged-shaped risk -- traced to the actual execution/
// storage layer, not just "the page looks similar":
//   - Scheduler.tsx: a task's target is a STORED server_id, resolved once
//     at creation/update time and never re-resolved from "whatever's
//     active" later. Execution (both cron fire and manual "Run now") calls
//     _resolveServicesForTask(), which opens a TEMPORARY RCON/ServerManager
//     connection scoped to task.server_id whenever that differs from the
//     currently-active server (server/services/scheduler.js:777-819). A
//     stored target and a re-resolved target are different architectures;
//     only the latter has this bug.
//   - Templates.tsx: a global config-snapshot library, applied to any
//     server later by explicit choice -- no server-scoping signals at all.
//   - Discord.tsx: one global bot config for the whole panel, not per-server.
//   - ServerFinder.tsx: browses OTHER public servers on the internet;
//     "activeServers" there is an unrelated stats counter, not this panel's
//     active-server concept.
//   - ServerSetup.tsx: is itself the SOURCE of activeServerChanged (creates
//     and activates servers) -- a consumer-side fix here would have been
//     exactly the kind of thing a mechanical sweep applies wrongly.
//
// Servers.tsx and Layout.tsx also contain a real activeServerChanged
// listener today, but are deliberately NOT in this guard's list: Servers.tsx
// IS the page that performs the switch (aware of it by construction, not
// because a vulnerability was found and fixed there), and Layout.tsx is the
// app shell, not a routed page this sweep ever scoped. Neither belongs in
// a list whose purpose is "pages that consume the event to stay correct."

const SERVER_SCOPED_PAGES = [
  "Mods.tsx",
  "ChunkCleaner.tsx",
  "Backups.tsx",
  "ServerConfig.tsx",
  "Settings.tsx",
  "Console.tsx",
  "Dashboard.tsx",
  "Players.tsx",
  "Events.tsx",
  "Chat.tsx",
  "Debug.tsx",
  "WorldMap.tsx",
] as const;

// Tolerates both quote styles and an optional-chaining socket reference
// (`socket.on(...)` / `socket?.on(...)`) -- ?.on( still contains the
// literal substring .on( that this pattern anchors on.
const ACTIVE_SERVER_CHANGED_HANDLER_RE = /\.on\(\s*['"]activeServerChanged['"]/;

function readPageSource(fileName: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "src/pages", fileName), "utf8");
}

describe("activeServerChanged sweep guard (text-level only, see file header)", () => {
  for (const fileName of SERVER_SCOPED_PAGES) {
    it(`${fileName} registers an activeServerChanged handler`, () => {
      const source = readPageSource(fileName);
      expect(source).toMatch(ACTIVE_SERVER_CHANGED_HANDLER_RE);
    });
  }
});
