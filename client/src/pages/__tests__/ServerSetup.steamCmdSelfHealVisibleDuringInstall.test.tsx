import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SocketContext } from "@/contexts/SocketContext";
import type { Socket } from "socket.io-client";
import ServerSetup from "../ServerSetup";
import { configApi, debugApi, serverApi } from "@/lib/api";
import enServerSetup from "../../locales/en/serverSetup.json";

// windows-steamcmd-selfheal client wiring, 2026-09-10 (god-directed,
// bundled with the Windows self-heal gate fix -- same commit, same
// reasoning: "mirror Linux" is true in the response contract and false on
// the screen without this, and the gap already affects Linux too, not just
// the new Windows path).
//
// steamCmdStatus (the piece of state ensureSteamCmdLinux/ensureSteamCmdWindows's
// steamcmd:status/steamcmd:log events feed) used to render in exactly ONE
// place: Step 1's own "no SteamCMD yet" panel. Once the operator has
// hasSteamCmd===true and reaches Step 2/4 (POST /install), that panel is
// unmounted -- so a self-heal triggered from handleInstall (steamcmd
// missing at install time, a fresh volume or a previous attempt that never
// finished) updated state nothing on screen ever read. The operator saw
// only the one static "Starting installation..." log line for however long
// the self-heal took, an effectively frozen page.
//
// This proves the fix from the operator's actual point of view: get to
// Step 4, click Install, and confirm a steamcmd:status event arriving
// DURING that install (installViaSteamCmd===true) shows up in the visible
// Installation Log panel -- not just in state nothing renders.

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
      // steamcmdPath already configured -- Step 1's own validation
      // (steamCmdPath.length > 0 && hasSteamCmd) is satisfied on mount, no
      // need to drive the manual-path-entry UI just to reach Step 2.
      getAppSettings: vi.fn().mockResolvedValue({ settings: { steamcmdPath: "/opt/steamcmd" } }),
    },
    debugApi: { ...actual.debugApi, getRam: vi.fn().mockRejectedValue(new Error("no RAM info in test env")) },
    serverApi: {
      ...actual.serverApi,
      getBranches: vi.fn().mockResolvedValue({ branches: [] }),
      install: vi.fn(),
    },
  };
});

const getAppSettings = vi.mocked(configApi.getAppSettings);
const getRam = vi.mocked(debugApi.getRam);
const getBranches = vi.mocked(serverApi.getBranches);
const install = vi.mocked(serverApi.install);

function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    emit: vi.fn(),
  };
  return {
    socket: socket as unknown as Socket,
    trigger: (event: string, data?: unknown) => {
      listeners.get(event)?.forEach((h) => h(data));
    },
  };
}

function renderServerSetup(socket: Socket | null) {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={socket}>
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
  localStorage.clear();
});

// Drives the wizard from the mode-select screen to Step 4 and clicks
// Install -- the real UI path an operator takes, not a shortcut into
// component internals.
async function navigateToInstallClick() {
  fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
  await screen.findByText(enServerSetup.full.step1.title);

  // Step 1 already satisfied by the mocked getAppSettings above.
  fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));
  await screen.findByText(enServerSetup.full.step2.title);

  fireEvent.change(screen.getByPlaceholderText(enServerSetup.full.step2.installFolderPlaceholder), {
    target: { value: "/srv/pz-test" },
  });
  fireEvent.change(screen.getByPlaceholderText(enServerSetup.common.serverNamePlaceholder), {
    target: { value: "TestServer" },
  });
  fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));
  await screen.findByText(enServerSetup.full.step3.title);

  // RCON password auto-generates on mount (12 chars) -- only admin password
  // needs filling to clear Step 3's own validation.
  fireEvent.change(screen.getByPlaceholderText(enServerSetup.common.adminPasswordPlaceholder), {
    target: { value: "adminpass123" },
  });
  fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));
  await screen.findByText(enServerSetup.full.step4.title);

  fireEvent.click(screen.getByRole("button", { name: enServerSetup.full.step4.installButton }));
  await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
}

describe("ServerSetup.tsx: a SteamCMD self-heal triggered from Step 4's Install click is visible on screen, not just in state", () => {
  it("adds steamcmd:status progress to the visible Installation Log while installViaSteamCmd is true", async () => {
    getAppSettings.mockResolvedValue({ settings: { steamcmdPath: "/opt/steamcmd" } } as never);
    getRam.mockRejectedValue(new Error("no RAM info in test env"));
    getBranches.mockResolvedValue({ branches: [] } as never);
    install.mockResolvedValue({ success: true } as never);

    const fake = createFakeSocket();
    renderServerSetup(fake.socket);

    await navigateToInstallClick();

    // Before the fix: this event only ever updated steamCmdStatus, which
    // renders exclusively inside Step 1's own (long since unmounted) panel
    // -- nothing on the Step 4 screen the operator is looking at would
    // change. The operator would see only the one static "Starting
    // installation..." line for however long self-heal took.
    fake.trigger("steamcmd:status", {
      status: "downloading",
      message: "SteamCMD missing — downloading it now...",
      progressCode: "STEAMCMD_LINUX_AUTO_DOWNLOAD_START",
    });

    await screen.findByText("SteamCMD missing — downloading it now...");
  });

  it("does NOT add steamcmd:status noise to the log while sitting on Step 4 before Install is clicked (installViaSteamCmd still false)", async () => {
    // The Installation Log panel itself renders on `logs.length > 0` alone
    // (ServerSetup.tsx:2313), independent of `installing` -- so this is a
    // real exercise of the gate, not a vacuous check: if the gate were
    // removed (unconditional addLog), this exact scenario would make the
    // panel appear where today it must not. Reaches Step 4 without ever
    // clicking Install, so installViaSteamCmd stays false throughout.
    getAppSettings.mockResolvedValue({ settings: { steamcmdPath: "/opt/steamcmd" } } as never);
    getRam.mockRejectedValue(new Error("no RAM info in test env"));
    getBranches.mockResolvedValue({ branches: [] } as never);

    const fake = createFakeSocket();
    renderServerSetup(fake.socket);

    fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.full.step1.title);
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));
    await screen.findByText(enServerSetup.full.step2.title);
    fireEvent.change(screen.getByPlaceholderText(enServerSetup.full.step2.installFolderPlaceholder), {
      target: { value: "/srv/pz-test" },
    });
    fireEvent.change(screen.getByPlaceholderText(enServerSetup.common.serverNamePlaceholder), {
      target: { value: "TestServer" },
    });
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));
    await screen.findByText(enServerSetup.full.step3.title);
    fireEvent.change(screen.getByPlaceholderText(enServerSetup.common.adminPasswordPlaceholder), {
      target: { value: "adminpass123" },
    });
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));
    await screen.findByText(enServerSetup.full.step4.title);

    expect(screen.queryByText(enServerSetup.full.step4.logTitle)).not.toBeInTheDocument();

    fake.trigger("steamcmd:status", {
      status: "downloading",
      message: "SteamCMD missing — downloading it now...",
      progressCode: "STEAMCMD_LINUX_AUTO_DOWNLOAD_START",
    });

    // Give the event's effects a tick to land, then confirm the log panel
    // still never appeared -- the event was heard (it always updates
    // steamCmdStatus regardless of the gate) but produced no log entry.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(enServerSetup.full.step4.logTitle)).not.toBeInTheDocument();
  });
});
