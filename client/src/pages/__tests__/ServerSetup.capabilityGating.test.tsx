import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SocketContext } from "@/contexts/SocketContext";
import type { Socket } from "socket.io-client";
import ServerSetup from "../ServerSetup";
import { configApi, serverApi, serversApi } from "@/lib/api";
import enServerSetup from "../../locales/en/serverSetup.json";

// bug-hunt-2026-08-27: ServerSetup.tsx mixes THREE capabilities on one page
// (server.install, panel.settings, server.control) -- god's own "may
// genuinely be page-grain" hypothesis, refuted with the route table. The
// sharpest case: PUT /config/app-settings (Save Path) needs panel.settings,
// not server.install like every button around it -- and TECHNICIAN holds
// server.install/server.control/servers.manage but NOT panel.settings
// (server/services/permissions.js:299-320), so today that one button
// 403s silently for the exact stock role every OTHER button on this page
// works for. This file proves the action is unreachable when denied, not
// just that a button looks disabled -- fires the mocked API and asserts it
// was never called, per this hive's floor rule.

// Radix's Slider (RAM sliders on step2/step3) measures its own DOM node via
// ResizeObserver, which jsdom does not implement -- same stub as
// Events.climateFloatRanges.test.tsx.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;

// jsdom doesn't implement scrollIntoView either -- the install-log
// auto-scroll effect calls it once install:complete populates `logs`.
Element.prototype.scrollIntoView = vi.fn();

let mockCan = (_capability: string) => true;

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "someone", role: "technician", capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => "fake-token",
    can: (capability: string) => mockCan(capability),
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    // apiFetch("/debug/system") and getAppSettings/getRam all fire on mount
    // (platform detection, saved-settings load, auto RAM-detect) and, left
    // real, hit fetchWithRetry's genuine backoff against a server that isn't
    // there in this test env -- multiplied across effects, that blew past
    // vitest's default 60s test timeout. Resolve them immediately instead.
    apiFetch: vi.fn().mockResolvedValue({ ok: false } as Response),
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn().mockResolvedValue({ settings: {} }),
      updateAppSettings: vi.fn(),
    },
    debugApi: { ...actual.debugApi, getRam: vi.fn().mockRejectedValue(new Error("no RAM info in test env")) },
    serverApi: {
      ...actual.serverApi,
      start: vi.fn(),
      getBranches: vi.fn().mockResolvedValue({ branches: [] }),
      downloadSteamCmd: vi.fn(),
    },
    serversApi: { ...actual.serversApi, create: vi.fn(), activate: vi.fn() },
  };
});

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}));

const updateAppSettings = vi.mocked(configApi.updateAppSettings);
const start = vi.mocked(serverApi.start);
const downloadSteamCmd = vi.mocked(serverApi.downloadSteamCmd);
const create = vi.mocked(serversApi.create);
const activate = vi.mocked(serversApi.activate);

// Minimal fake matching only what ServerSetup actually calls (on/off/emit) --
// same shape as ServerSetup.resumeAndActivate.test.tsx's helper.
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

function renderServerSetup(socket: Socket | null = null) {
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

describe("ServerSetup.tsx: Save SteamCMD path gates on panel.settings, not server.install", () => {
  async function openManualSteamCmdSection() {
    renderServerSetup();
    fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.full.step1.title);
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.full.step1.manualTrigger }));
    const pathInput = await screen.findByPlaceholderText(enServerSetup.full.step1.manualPathPlaceholder);
    fireEvent.change(pathInput, { target: { value: "/opt/steamcmd" } });
    return screen.getByRole("button", { name: enServerSetup.full.step1.savePathButton });
  }

  it("disables Save Path and never calls the API when the role holds server.install but lacks panel.settings (the stock TECHNICIAN case)", async () => {
    mockCan = (capability) => capability !== "panel.settings";
    const saveButton = await openManualSteamCmdSection();

    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("enables Save Path and calls the API when the role holds panel.settings", async () => {
    mockCan = () => true;
    updateAppSettings.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof configApi.updateAppSettings>>);
    const saveButton = await openManualSteamCmdSection();

    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    await waitFor(() => expect(updateAppSettings).toHaveBeenCalledWith({ steamcmdPath: "/opt/steamcmd" }));
  });

  it("leaves the auto-download button gated on server.install alone, unaffected by a panel.settings denial", async () => {
    mockCan = (capability) => capability !== "panel.settings";
    renderServerSetup();
    fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.full.step1.title);

    const downloadButton = screen.getByRole("button", { name: enServerSetup.full.step1.installButton });
    expect(downloadButton).not.toBeDisabled();
  });

  // bug-hunt-2026-09-08 (gate-not-destination sweep): the test above stopped
  // at not.toBeDisabled() -- the button was never clicked, so a regression
  // in handleAutoDownloadSteamCmd's own body (as opposed to the !canInstall
  // disabled expression) would have sat green.
  it("reaches serverApi.downloadSteamCmd when the auto-download button is clicked, holding server.install", async () => {
    mockCan = () => true;
    renderServerSetup();
    fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.full.step1.title);

    const downloadButton = screen.getByRole("button", { name: enServerSetup.full.step1.installButton });
    expect(downloadButton).not.toBeDisabled();
    fireEvent.click(downloadButton);

    await waitFor(() => expect(downloadSteamCmd).toHaveBeenCalledTimes(1));
  });
});

describe("ServerSetup.tsx: Start Server Now (shared by both post-install completion screens) gates on server.control", () => {
  // Both the full-wizard and quick-setup "Start Server Now" buttons call the
  // same extracted handleStartServerNow (ServerSetup.tsx) -- reaching the
  // quick-setup completion screen (3 steps) is far less form-filling than
  // the full wizard's 4, and proves the shared handler's guard either way.
  async function reachQuickPostCreate() {
    const { socket, trigger } = createFakeSocket();
    const { container } = renderServerSetup(socket);

    fireEvent.click(screen.getByText(enServerSetup.modeSelect.quickCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.quick.step1.title);
    fireEvent.change(screen.getByPlaceholderText(enServerSetup.quick.step1.locationPlaceholder), {
      target: { value: "/opt/pz-server" },
    });
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));

    await screen.findByText(enServerSetup.quick.step2.title);
    fireEvent.change(screen.getByPlaceholderText(enServerSetup.common.serverNamePlaceholder), {
      target: { value: "myserver" },
    });
    const passwordInputs = container.querySelectorAll('input[type="password"]');
    expect(passwordInputs.length).toBe(2); // RCON password, then admin password, in that DOM order
    fireEvent.change(passwordInputs[0], { target: { value: "rconpass123" } });
    fireEvent.change(passwordInputs[1], { target: { value: "adminpass123" } });
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));

    await screen.findByText(enServerSetup.quick.step3.title);

    create.mockResolvedValue({ server: { id: 1 } } as Awaited<ReturnType<typeof serversApi.create>>);
    activate.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof serversApi.activate>>);
    trigger("install:complete", {
      success: true,
      serverName: "myserver",
      installPath: "/opt/pz-server",
      rconPort: 27015,
      rconPassword: "rconpass123",
      serverPort: 16261,
      minMemory: 4096,
      maxMemory: 8192,
      branch: "public",
    });

    return screen.findByRole("button", { name: enServerSetup.common.startServerButton });
  }

  it("disables Start Server Now and never calls the API when the role lacks server.control", async () => {
    mockCan = (capability) => capability !== "server.control";
    const startButton = await reachQuickPostCreate();

    expect(startButton).toBeDisabled();
    fireEvent.click(startButton);
    expect(start).not.toHaveBeenCalled();
  });

  it("enables Start Server Now and calls the API when the role holds server.control", async () => {
    mockCan = () => true;
    start.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof serverApi.start>>);
    const startButton = await reachQuickPostCreate();

    expect(startButton).not.toBeDisabled();
    fireEvent.click(startButton);
    await waitFor(() => expect(start).toHaveBeenCalled());
  });
});
