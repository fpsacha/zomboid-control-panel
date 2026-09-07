import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SocketContext } from "@/contexts/SocketContext";
import ServerSetup from "../ServerSetup";
import { configApi, debugApi, serverApi } from "@/lib/api";
import enServerSetup from "../../locales/en/serverSetup.json";

// bug-hunt-2026-09-06 (client silent-failure lane, dispatched after tonight's
// server uploadStream crash): handleAutoDownloadSteamCmd's only terminal
// signal is the 'steamcmd:status'/'steamcmd:log' socket channel -- the
// awaited serverApi.downloadSteamCmd() call only confirms the download was
// LAUNCHED. Before this fix, a dropped/never-emitted terminal event left
// downloadingSteamCmd (and the button it disables) stuck true forever with
// zero indication anything went wrong -- the same "nobody's listening" class
// as tonight's server uploadStream crash, manifesting as silence instead of
// a crash. Servers.steamStallRecovery.test.tsx covers the sibling
// installStalled/steamStalled watchdogs (same interval-based shape); this
// file covers downloadStalled specifically because it's reachable without
// navigating the full 4-step wizard.
//
// The fix deliberately does NOT re-enable the button (a second click would
// launch a second real download racing the first) -- it just stops staying
// silent, surfacing an honest "may still be downloading" status instead.

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
Element.prototype.scrollIntoView = vi.fn();

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "someone", role: "admin", capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => "fake-token",
    can: () => true,
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    apiFetch: vi.fn().mockResolvedValue({ ok: false } as Response),
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn().mockResolvedValue({ settings: {} }),
    },
    debugApi: { ...actual.debugApi, getRam: vi.fn().mockRejectedValue(new Error("no RAM info in test env")) },
    serverApi: {
      ...actual.serverApi,
      getBranches: vi.fn().mockResolvedValue({ branches: [] }),
      downloadSteamCmd: vi.fn(),
    },
  };
});

const getAppSettings = vi.mocked(configApi.getAppSettings);
const getRam = vi.mocked(debugApi.getRam);
const getBranches = vi.mocked(serverApi.getBranches);
const downloadSteamCmd = vi.mocked(serverApi.downloadSteamCmd);

function renderServerSetup() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ServerSetup />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe("ServerSetup.tsx: auto-download SteamCMD surfaces an honest stall status if steamcmd:status/steamcmd:log never arrives", () => {
  it('replaces the in-progress download status with a stall status after DOWNLOAD_STALL_MS, without re-enabling the button', async () => {
    getAppSettings.mockResolvedValue({ settings: {} } as never);
    getRam.mockRejectedValue(new Error("no RAM info in test env"));
    getBranches.mockResolvedValue({ branches: [] } as never);
    downloadSteamCmd.mockResolvedValue({ success: true } as never);

    // Installed before rendering: handleAutoDownloadSteamCmd's click starts
    // the watchdog's setInterval, which must be a FAKE interval from the
    // moment it's created -- shouldAdvanceTime keeps findBy/waitFor usable.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderServerSetup();
      fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
      await screen.findByText(enServerSetup.full.step1.title);

      const installButton = screen.getByRole("button", { name: enServerSetup.full.step1.installButton });
      fireEvent.click(installButton);
      await waitFor(() => expect(downloadSteamCmd).toHaveBeenCalledTimes(1));

      // steamCmdStatus is set to this "launched" message synchronously on
      // click and never advances further -- no socket exists in this render,
      // so no steamcmd:log/steamcmd:status can ever overwrite it.
      const downloadingButton = await screen.findByRole("button", { name: enServerSetup.toasts.startingDownloadLog });
      expect(downloadingButton).toBeDisabled();
      expect(screen.queryByText(enServerSetup.full.step1.downloadStalledStatus)).not.toBeInTheDocument();

      // Just under the 3-minute threshold: still silent-but-honest, no
      // status change yet.
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 - 1000);
      expect(screen.getByRole("button", { name: enServerSetup.toasts.startingDownloadLog })).toBeDisabled();

      // Cross the threshold (watchdog ticks every 15s).
      await vi.advanceTimersByTimeAsync(20_000);

      const stalledButton = await screen.findByRole("button", { name: enServerSetup.full.step1.downloadStalledStatus });
      // Deliberately still disabled -- unlike Servers.tsx's dialog (which had
      // no other way out at all), a second click here would race a second
      // real SteamCMD download against the first.
      expect(stalledButton).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });
});
