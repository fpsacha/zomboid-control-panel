import { reportClientWarning } from "./client-errors";
import { clearAccessToken, getAccessToken, setAccessToken } from "./authToken";
import { toast } from "@/components/ui/use-toast";
import i18n from "@/i18n";

const API_BASE = "/api";

export class ApiError extends Error {
  status?: number;
  code?: string;
  isRetryable: boolean;
  isTimeout: boolean;
  isNetworkError: boolean;
  /**
   * Full parsed JSON payload from the failing response (when available).
   * Lets callers read structured fields the server returned alongside the
   * `error` message — e.g. `code: 'server_running'` and `matched: [...]`
   * from the chunk-cleanup endpoints (issue #5).
   */
  data?: unknown;

  constructor(
    message: string,
    options?: {
      status?: number;
      code?: string;
      isRetryable?: boolean;
      isTimeout?: boolean;
      isNetworkError?: boolean;
      data?: unknown;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options?.status;
    this.code = options?.code;
    this.isRetryable = Boolean(options?.isRetryable);
    this.isTimeout = Boolean(options?.isTimeout);
    this.isNetworkError = Boolean(options?.isNetworkError);
    this.data = options?.data;
  }
}

// Get stored auth token
function getAuthToken(): string | null {
  return getAccessToken();
}

// Add auth headers to request options
function withAuth(options?: RequestInit): RequestInit {
  const token = getAuthToken();
  if (!token) return options || {};

  const headers = new Headers(options?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...options, headers };
}

// Handle 401 responses — try to refresh the token once
let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

// Exported so callers outside the 401-retry path below (App.tsx's socket
// auth, ahead of a reconnect attempt) can reuse the exact same
// isRefreshing/refreshPromise dedupe instead of racing a second,
// independent refresh call against this one.
export async function tryRefreshToken(): Promise<boolean> {
  if (isRefreshing && refreshPromise) return refreshPromise;

  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setAccessToken(data.accessToken);
        return true;
      }
      // Refresh failed — clear token and redirect to login
      clearAccessToken();
      return false;
    } catch {
      clearAccessToken();
      return false;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 5000,
  fetchTimeout: 15000, // 15 second timeout for fetch requests
};

const RETRY_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function requestMethod(options?: RequestInit): string {
  return String(options?.method || "GET").toUpperCase();
}

// Exponential backoff with jitter
function getRetryDelay(attempt: number): number {
  const delay = Math.min(
    RETRY_CONFIG.baseDelay * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelay,
  );
  // Add jitter (±25%)
  return delay * (0.75 + Math.random() * 0.5);
}

// Check if error is retryable
function isRetryableError(error: unknown, response?: Response): boolean {
  if (error instanceof ApiError) {
    return error.isRetryable;
  }
  // Network errors are retryable
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }
  // Abort errors (timeout) are retryable
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  // 5xx errors are retryable
  if (response && response.status >= 500) {
    return true;
  }
  // 429 Too Many Requests is retryable
  if (response?.status === 429) {
    return true;
  }
  return false;
}

function getStatusMessage(status: number): string {
  switch (status) {
    case 400:
      return "The request was invalid. Check the provided values and try again.";
    case 401:
      return "Your session has expired. Sign in again and retry.";
    case 403:
      return "You do not have permission to perform this action.";
    case 404:
      return "The requested resource was not found.";
    case 408:
      return "The request timed out. Try again.";
    case 409:
      return "The request could not be completed because the data changed.";
    case 413:
      return "The submitted content is too large.";
    case 422:
      return "The server rejected the submitted values. Review the form and try again.";
    case 429:
      return "Too many requests were sent. Wait a moment and try again.";
    case 500:
    case 502:
    case 503:
    case 504:
      return "The server is temporarily unavailable. Try again shortly.";
    default:
      return `Request failed with status ${status}.`;
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError(
      "The request timed out. Check your connection and try again.",
      {
        code: "TIMEOUT",
        isRetryable: true,
        isTimeout: true,
        isNetworkError: true,
      },
    );
  }

  if (error instanceof TypeError) {
    return new ApiError(
      "Unable to reach the server. Check your network connection and try again.",
      {
        code: "NETWORK_ERROR",
        isRetryable: true,
        isNetworkError: true,
      },
    );
  }

  if (error instanceof Error) {
    return new ApiError(error.message);
  }

  return new ApiError(
    "An unexpected error occurred while contacting the server.",
  );
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  try {
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
}

function buildResponseError(response: Response, payload?: unknown): ApiError {
  const messageFromPayload =
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
      ? payload.error
      : payload &&
          typeof payload === "object" &&
          "message" in payload &&
          typeof payload.message === "string"
        ? payload.message
        : typeof payload === "string" && payload.trim()
          ? payload.trim()
          : getStatusMessage(response.status);

  // Prefer the server-provided `code` over a generic HTTP_<status> tag so
  // callers can switch on application-level codes like `server_running`.
  const codeFromPayload =
    payload &&
    typeof payload === "object" &&
    "code" in payload &&
    typeof (payload as { code: unknown }).code === "string"
      ? (payload as { code: string }).code
      : `HTTP_${response.status}`;

  return new ApiError(messageFromPayload, {
    status: response.status,
    code: codeFromPayload,
    isRetryable:
      response.status >= 500 ||
      response.status === 429 ||
      response.status === 408,
    data: payload,
  });
}

async function responseHasCode(
  response: Response,
  expectedCode: string,
): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const payload = await response.clone().json();
    return (
      payload !== null &&
      typeof payload === "object" &&
      "code" in payload &&
      payload.code === expectedCode
    );
  } catch {
    return false;
  }
}

async function fetchWithRetry(
  url: string,
  options?: RequestInit & { timeout?: number },
  retries: number = RETRY_CONFIG.maxRetries,
): Promise<Response> {
  let lastError: unknown;
  const effectiveTimeout = options?.timeout || RETRY_CONFIG.fetchTimeout;
  const method = requestMethod(options);
  const transportRetries = RETRY_SAFE_METHODS.has(method) ? retries : 0;
  let authenticationReplayUsed = false;

  for (let attempt = 0; attempt <= transportRetries; attempt++) {
    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

      // If caller provided a signal, abort our controller when it fires
      const externalSignal = options?.signal;
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort(externalSignal.reason);
        } else {
          externalSignal.addEventListener(
            "abort",
            () => controller.abort(externalSignal.reason),
            { once: true },
          );
        }
      }

      try {
        const response = await fetch(url, {
          ...withAuth(options),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // Authentication replay is separate from transport retries. It is
        // allowed once, and only when the server explicitly says the access
        // token expired. This remains safe for mutations because the server
        // rejected the original request before performing it.
        if (
          response.status === 401 &&
          !authenticationReplayUsed &&
          !url.includes("/api/auth/") &&
          (await responseHasCode(response, "TOKEN_EXPIRED"))
        ) {
          authenticationReplayUsed = true;
          const refreshed = await tryRefreshToken();
          if (refreshed) {
            const retryController = new AbortController();
            const retryTimeoutId = setTimeout(
              () => retryController.abort(),
              effectiveTimeout,
            );
            // Retry with new token
            const retryResponse = await fetch(url, {
              ...withAuth(options),
              signal: retryController.signal,
            }).finally(() => clearTimeout(retryTimeoutId));
            if (retryResponse.status === 401) {
              clearAccessToken();
              window.location.reload();
            }
            // The authentication replay is the final send for this logical
            // request. A failure here must be surfaced rather than retried,
            // especially when the request is a mutation.
            return retryResponse;
          } else {
            // Refresh failed — force reload to show login.
            window.location.reload();
            return response;
          }
        }

        // If response is not retryable error, return it
        if (
          !isRetryableError(null, response) ||
          attempt === transportRetries
        ) {
          return response;
        }
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }

      // Wait before retrying
      await new Promise((resolve) =>
        setTimeout(resolve, getRetryDelay(attempt)),
      );
    } catch (error) {
      lastError = toApiError(error);

      // Don't retry if it's the last attempt or non-retryable
      if (
        attempt === transportRetries ||
        !isRetryableError(lastError)
      ) {
        throw lastError;
      }

      reportClientWarning(
        `Request failed, retrying (${attempt + 1}/${transportRetries})...`,
        lastError,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, getRetryDelay(attempt)),
      );
    }
  }

  throw toApiError(lastError);
}

export function apiFetch(endpoint: string, options?: RequestInit) {
  return fetchWithRetry(`${API_BASE}${endpoint}`, options);
}

async function handleResponse<T = any>(response: Response): Promise<T> {
  const data = await parseResponseBody(response);
  if (!response.ok) {
    throw buildResponseError(response, data);
  }
  if (data === null || typeof data !== "object") {
    throw new ApiError("The server returned an invalid response.", {
      status: response.status,
      code: "INVALID_RESPONSE",
    });
  }
  // An HTTP 200 with an explicit `success: false` body is this codebase's
  // other way of saying "this failed" -- RCON/bridge/game actions routinely
  // resolve this way when the underlying server or connector isn't
  // reachable, and a caller that only checks "did the fetch throw" reports
  // success anyway. Strict equality: a response with no `success` field at
  // all (most GETs, many POSTs that just return the created/updated
  // resource) is untouched by this check and returns exactly as before.
  if ((data as { success?: unknown }).success === false) {
    throw buildResponseError(response, data);
  }
  // ~30 config-writing routes (mods.js, serverFiles.js) attach this when the
  // edit itself succeeded but the pre-write backup couldn't be made -- the
  // operator's change landed, but there is now no safety copy of what was
  // there before. Surfaced here, once, through this shared choke point every
  // mutating call already passes through, instead of requiring each of the
  // ~30 call sites to individually remember to check for it.
  const backupWarning = (data as { backupWarning?: unknown }).backupWarning;
  if (typeof backupWarning === "string" && backupWarning) {
    toast({
      variant: "warning",
      title: i18n.t("toastTitle", { ns: "backupWarning" }),
      description: backupWarning,
    });
  }
  return data as T;
}

// Helper for GET requests with retry
function apiGet<T = any>(
  endpoint: string,
  options?: RequestInit & { timeout?: number },
  retries?: number,
): Promise<T> {
  return fetchWithRetry(`${API_BASE}${endpoint}`, options, retries).then((response) =>
    handleResponse<T>(response),
  );
}

// Helper for POST requests with retry
function apiPost<T = any>(
  endpoint: string,
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  return fetchWithRetry(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: options?.signal,
  }).then((response) => handleResponse<T>(response));
}

// Helper for DELETE requests with retry
function apiDelete<T = any>(endpoint: string): Promise<T> {
  return fetchWithRetry(`${API_BASE}${endpoint}`, { method: "DELETE" }).then(
    (response) => handleResponse<T>(response),
  );
}

// Helper for PUT requests with retry
function apiPut<T = any>(endpoint: string, body?: unknown): Promise<T> {
  return fetchWithRetry(`${API_BASE}${endpoint}`, {
    method: "PUT",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((response) => handleResponse<T>(response));
}

// Steam branch info
export interface SteamBranch {
  name: string;
  description: string;
  buildId?: string | null;
  timeUpdated?: string | null;
}

// Character export/import types
export interface PerkData {
  level: number;
  xp: number;
}

export interface CharacterStats {
  hunger?: number;
  thirst?: number;
  fatigue?: number;
  stress?: number;
  boredom?: number;
  endurance?: number;
  health?: number;
  panic?: number;
  unhappyness?: number;
}

export interface CharacterInventoryItem {
  fullType: string;
  count?: number;
  condition?: number;
  uses?: number;
  delta?: number;
  contents?: CharacterInventoryItem[];
}

export interface CharacterExportData {
  username: string;
  exportTime?: number;
  perks: Record<string, PerkData>;
  stats?: CharacterStats;
  recipes: string[];
  traits?: string[];
  inventory?: CharacterInventoryItem[];
  wornItems?: Array<{ location: string; fullType: string; condition?: number }>;
  bagInventory?: Record<string, CharacterInventoryItem[]>;
  health?: {
    overall: number;
    infection?: number;
    bodyParts?: Array<{
      type: string;
      health: number;
      isBleeding: boolean;
      isBandaged: boolean;
      hasScratch: boolean;
      hasBite: boolean;
      isBurnt: boolean;
      isCut: boolean;
    }>;
  };
}

export interface CharacterExportResponse {
  success: boolean;
  data: CharacterExportData;
  error?: string;
}

export interface CharacterImportData {
  perks?: Record<string, PerkData>;
  stats?: CharacterStats;
  recipes?: string[];
  inventory?: CharacterInventoryItem[];
}

export interface CharacterImportResponse {
  success: boolean;
  data: {
    message: string;
    restored: {
      perks: number;
      items: number;
    };
  };
  error?: string;
}

// Server API
export const serverApi = {
  getStatus: (options?: { retries?: number }) =>
    apiGet("/server/status", undefined, options?.retries),
  getNetworkInterfaces: (): Promise<{
    interfaces: { name: string; address: string }[];
  }> => apiGet("/server/network-interfaces"),
  start: () => apiPost("/server/start"),
  stop: () => apiPost("/server/stop"),
  forceStop: () => apiPost("/server/force-stop"),
  restart: (warningMinutes?: number) =>
    apiPost("/server/restart", { warningMinutes }),
  restartNow: () => apiPost("/server/restart", { warningMinutes: 0 }),
  save: () => apiPost("/server/save"),
  sendMessage: (message: string) => apiPost("/server/message", { message }),

  // Wipe
  wipePreview: (targets: string[]) =>
    apiPost("/server/wipe/preview", { targets }),
  wipe: (targets: string[], createBackup: boolean = true) =>
    apiPost("/server/wipe", { targets, confirm: true, createBackup }) as Promise<{
      success: boolean;
      backupCreated: boolean;
      backupName: string | null;
    }>,

  // Panel info - returns the panel's own network address
  getPanelInfo: () =>
    apiGet("/panel-info") as Promise<{
      localIp: string;
      port: number;
      url: string;
    }>,

  // Panel restart - restarts the panel process
  restartPanel: () => apiPost("/panel/restart"),

  // Get available Steam branches
  getBranches: (steamcmdPath?: string) =>
    apiGet(
      `/server/branches${steamcmdPath ? `?steamcmdPath=${encodeURIComponent(steamcmdPath)}` : ""}`,
    ) as Promise<{ branches: SteamBranch[]; source: string; message: string }>,

  // SteamCMD Installation
  install: (config: Record<string, unknown>) =>
    apiPost("/server/install", config),

  detectSteamCmd: () =>
    apiGet("/server/steamcmd/detect") as Promise<{
      found: boolean;
      path?: string;
      executable?: string;
      message: string;
    }>,

  // Quick setup (create server config without SteamCMD)
  quickSetup: (config: Record<string, unknown>) =>
    apiPost("/server/quick-setup", config),

  // Configure RCON in server ini file
  configureRcon: (config: { rconPassword: string; rconPort?: number }) =>
    apiPost("/server/configure-rcon", config),

  // Configure network settings (port, UPnP) in server ini file
  configureNetwork: (config: { serverPort?: number; useUpnp?: boolean }) =>
    apiPost("/server/configure-network", config),

  // SteamCMD auto-download
  downloadSteamCmd: (installPath?: string) =>
    apiPost("/server/steamcmd/download", { installPath }),
  checkSteamCmd: (path: string) =>
    apiGet(`/server/steamcmd/check?path=${encodeURIComponent(path)}`),

  // Folder browser
  browseFolder: (initialPath?: string, description?: string) =>
    apiPost("/server/browse-folder", { initialPath, description }),
  listDirectory: (dirPath?: string) =>
    apiPost("/server/list-directory", { dirPath }) as Promise<{
      entries: Array<{
        name: string;
        path: string;
        label?: string;
        isDrive?: boolean;
      }>;
      currentPath: string | null;
      parentPath: string | null;
    }>,

  // Weather
  startRain: (intensity?: number) =>
    apiPost("/server/weather/start-rain", { intensity }),
  stopRain: () => apiPost("/server/weather/stop-rain"),
  startStorm: (duration?: number) =>
    apiPost("/server/weather/start-storm", { duration }),
  stopWeather: () => apiPost("/server/weather/stop"),

  // Events
  triggerChopper: () => apiPost("/server/events/chopper"),
  triggerGunshot: () => apiPost("/server/events/gunshot"),
  triggerLightning: (username?: string) =>
    apiPost("/server/events/lightning", { username }),
  triggerThunder: (username?: string) =>
    apiPost("/server/events/thunder", { username }),
  createHorde: (count: number, username?: string) =>
    apiPost("/server/events/horde", { count, username }),

  // Additional events
  alarm: () => apiPost("/server/alarm"),
  removeZombies: () => apiPost("/server/removezombies"),

  // Lua
  reloadLua: (filename: string) => apiPost("/server/reloadlua", { filename }),

  // Logging
  setLogLevel: (type: string, level: string) =>
    apiPost("/server/log", { type, level }),

  // Statistics
  setStats: (mode: string, period?: number) =>
    apiPost("/server/stats", { mode, period }),

  // Safehouse
  releaseSafehouse: () => apiPost("/server/releasesafehouse"),

  // Server Console Log (server-console.txt)
  getConsoleLog: (lines?: number) =>
    apiGet(`/server/console-log${lines ? `?lines=${lines}` : ""}`),
  streamConsoleLog: (lastSize: number) =>
    apiGet(`/server/console-log/stream?lastSize=${lastSize}`),
  getConsoleErrorCount: (): Promise<{
    exists: boolean
    count: number
    sinceStart: boolean
    truncated?: boolean
  }> => apiGet("/server/console-log/error-count"),
  clearConsoleLog: () => apiPost("/server/console-log/clear"),
};

// Players API
export const playersApi = {
  getPlayers: (options?: { retries?: number }) =>
    apiGet("/players", undefined, options?.retries),
  getWhitelist: () => apiGet<{
    success: boolean
    available: boolean
    accounts: Array<{
      id: number
      username: string
      lastConnection: string | null
      role: string
      authType: number
      steamId: string | null
      ownerId: string | null
      displayName: string | null
    }>
    allowedSteamIds: string[]
    reason?: string
    server?: { id: string | number; name: string }
  }>("/players/whitelist"),
  kick: (username: string, reason?: string) =>
    apiPost("/players/kick", { username, reason }),
  ban: (username: string, banIp?: boolean, reason?: string) =>
    apiPost("/players/ban", { username, banIp, reason }),
  unban: (username: string) => apiPost("/players/unban", { username }),
  setAccessLevel: (username: string, level: string) =>
    apiPost("/players/access-level", { username, level }),
  addToWhitelist: (username: string, password: string) =>
    apiPost("/players/whitelist/add", { username, password }),
  removeFromWhitelist: (username: string) =>
    apiPost("/players/whitelist/remove", { username }),
  addAllowedSteamId: (steamId: string) =>
    apiPost("/players/whitelist/steamid/add", { steamId }),
  removeAllowedSteamId: (steamId: string) =>
    apiPost("/players/whitelist/steamid/remove", { steamId }),
  teleport: (
    player1: string,
    destination?: string | { x: number; y: number; z?: number },
  ) => {
    if (destination && typeof destination === "object") {
      // Coordinate form goes through PanelBridge server-side (server/routes/
      // players.js forwards bridge.teleportPlayer()'s result via res.json
      // unmodified) -- same envelope shape as panelBridgeApi.sendCommand.
      return apiPost<BridgeCommandResult>("/players/teleport", {
        player1,
        x: destination.x,
        y: destination.y,
        z: destination.z ?? 0,
      });
    }

    return apiPost("/players/teleport", { player1, player2: destination });
  },
  addItem: (username: string | null, item: string, count?: number) =>
    apiPost("/players/add-item", { username, item, count }),
  addXp: (username: string, perk: string, amount: number) =>
    apiPost("/players/add-xp", { username, perk, amount }),
  addVehicle: (vehicle: string, username?: string) =>
    apiPost("/players/add-vehicle", { vehicle, username }),
  addVehicleAt: (vehicle: string, x: number, y: number, z = 0) =>
    apiPost("/players/add-vehicle-at", { vehicle, x, y, z }),
  setGodMode: (username: string | null, enabled: boolean) =>
    apiPost("/players/godmode", { username, enabled }),
  setInvisible: (username: string | null, enabled: boolean) =>
    apiPost("/players/invisible", { username, enabled }),
  setNoclip: (username: string | null, enabled: boolean) =>
    apiPost("/players/noclip", { username, enabled }),
  getVehicles: () => apiGet("/players/vehicles"),
  getPerks: () => apiGet("/players/perks"),
  getAccessLevels: () => apiGet("/players/access-levels"),
  // Ban/unban by SteamID
  banSteamId: (steamId: string, reason?: string) =>
    apiPost("/players/banid", { steamId, reason }),
  unbanSteamId: (steamId: string) => apiPost("/players/unbanid", { steamId }),
  getSteamIdBans: () => apiGet("/players/steamid-bans"),
  // Voice ban
  voiceBan: (username: string, enabled: boolean) =>
    apiPost("/players/voiceban", { username, enabled }),
  // Add user with password (for whitelist servers)
  addUser: (username: string, password: string) =>
    apiPost("/players/adduser", { username, password }),
  // Add all connected to whitelist
  addAllToWhitelist: () => apiPost("/players/whitelist/addall"),
  // Activity logs
  getActivityLogs: (player?: string, limit?: number) =>
    apiGet(
      `/players/activity?${player ? `player=${encodeURIComponent(player)}&` : ""}limit=${limit || 100}`,
    ),
  // Player Notes
  getNotes: () => apiGet("/players/notes"),
  getNote: (playerName: string) =>
    apiGet(`/players/notes/${encodeURIComponent(playerName)}`),
  saveNote: (playerName: string, note: string, tags: string[]) =>
    apiPost("/players/notes", { playerName, note, tags }),
  deleteNote: (playerName: string) =>
    apiDelete(`/players/notes/${encodeURIComponent(playerName)}`),
  // Player Stats (playtime tracking)
  getStats: () => apiGet("/players/stats"),
  getStat: (playerName: string) =>
    apiGet(`/players/stats/${encodeURIComponent(playerName)}`),
  // Character export history
  getExports: (username?: string) =>
    apiGet(
      `/players/exports${username ? `?username=${encodeURIComponent(username)}` : ""}`,
    ),
  getExport: (username: string, filename: string) =>
    apiGet(
      `/players/exports/${encodeURIComponent(username)}/${encodeURIComponent(filename)}`,
    ),
  deleteExport: (username: string, filename: string) =>
    apiDelete(
      `/players/exports/${encodeURIComponent(username)}/${encodeURIComponent(filename)}`,
    ),
};

export interface RconTestResult {
  success: boolean;
  error?: "unreachable" | "auth_failed" | "invalid_input" | "internal_error";
  detail: string;
}

// RCON API
export const rconApi = {
  execute: (command: string) => apiPost("/rcon/execute", { command }),
  getStatus: () => apiGet("/rcon/status"),
  connect: (host?: string, port?: number, password?: string) =>
    apiPost("/rcon/connect", { host, port, password }),
  disconnect: () => apiPost("/rcon/disconnect"),
  getHistory: (limit?: number) => apiGet(`/rcon/history?limit=${limit || 100}`),
  getCommands: () => apiGet("/rcon/commands"),
  testConnection: (host: string, port: number, password: string) =>
    apiPost<RconTestResult>("/rcon/test", { host, port, password }),
};

// Scheduler API
export interface ScheduleHistoryEntry {
  id: number;
  task_id: number | null;
  task_name: string;
  command: string;
  success: number;
  message: string | null;
  duration: number | null;
  executed_at: string;
}

export interface RestartWarningSettings {
  locale: "en" | "zh-CN" | "fr" | "de" | "es" | "ht";
  template: string;
}

export interface SchedulerStatus {
  activeTasks: number;
  autoRestartEnabled: boolean;
  modUpdateRestartPending: boolean;
  timezone?: string;
  configuredTimezone?: string | null;
  timezoneFallback?: { configured: string; effective: string } | null;
  restartWarning?: RestartWarningSettings;
  restartWarningPresets?: Record<RestartWarningSettings["locale"], string>;
}

export const schedulerApi = {
  getStatus: () => apiGet("/scheduler/status") as Promise<SchedulerStatus>,
  getTasks: () => apiGet("/scheduler/tasks"),
  createTask: (
    name: string,
    cronExpression: string,
    command: string,
    serverId?: string | number,
  ) =>
    apiPost("/scheduler/tasks", { name, cronExpression, command, serverId }),
  updateTask: (
    id: number,
    name: string,
    cronExpression: string,
    command: string,
    enabled: boolean,
    serverId?: string | number,
  ) =>
    apiPut(`/scheduler/tasks/${id}`, {
      name,
      cronExpression,
      command,
      enabled,
      serverId,
    }),
  deleteTask: (id: number) => apiDelete(`/scheduler/tasks/${id}`),
  runTask: (id: number) => apiPost(`/scheduler/tasks/${id}/run`),
  restartNow: (warningMinutes?: number) =>
    apiPost("/scheduler/restart-now", { warningMinutes }) as Promise<{
      success: boolean;
      message: string;
      warningMinutes: number;
    }>,
  getCronPresets: () => apiGet("/scheduler/cron-presets"),
  validateCron: (cronExpression: string) =>
    apiPost("/scheduler/validate-cron", { cronExpression }) as Promise<{
      valid: boolean;
      error?: string;
      code?: string;
    }>,
  getHistory: (limit?: number, taskId?: number) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", limit.toString());
    if (taskId) params.set("taskId", taskId.toString());
    const query = params.toString();
    return apiGet(`/scheduler/history${query ? `?${query}` : ""}`) as Promise<{
      history: ScheduleHistoryEntry[];
    }>;
  },
  clearHistory: () => apiDelete("/scheduler/history"),
  setTimezone: (timezone: string) =>
    apiPut("/scheduler/timezone", { timezone }) as Promise<{
      success: boolean;
      timezone: string;
      configuredTimezone: string | null;
      timezoneFallback: { configured: string; effective: string } | null;
    }>,
  setRestartWarning: (restartWarning: RestartWarningSettings) =>
    apiPut("/scheduler/restart-warning", restartWarning) as Promise<{
      success: boolean;
      restartWarning: RestartWarningSettings;
    }>,
};

// Mods API
export const modsApi = {
  getStatus: (options?: RequestInit) => apiGet("/mods/status", options),
  getTrackedMods: (options?: RequestInit) => apiGet("/mods/tracked", options),
  trackMod: (workshopId: string) => apiPost("/mods/track", { workshopId }),
  untrackMod: (workshopId: string) => apiDelete(`/mods/track/${workshopId}`),

  // Ignored mods (prevent auto-re-tracking)
  getIgnoredMods: () => apiGet("/mods/ignored"),
  unignoreMod: (workshopId: string) => apiDelete(`/mods/ignored/${workshopId}`),
  clearAllIgnoredMods: () => apiDelete("/mods/ignored"),

  // Ignored mod-conflict pairs (false positives on the variant detector)
  getIgnoredModPairs: () =>
    apiGet("/mods/ignored-pairs") as Promise<
      Array<{
        mod_a: string;
        mod_b: string;
        reason?: string | null;
        server_id?: string | null;
        ignored_at: string;
      }>
    >,
  addIgnoredModPair: (modIdA: string, modIdB: string, reason?: string) =>
    apiPost("/mods/ignored-pairs", { modIdA, modIdB, reason }),
  removeIgnoredModPair: (modIdA: string, modIdB: string) =>
    fetchWithRetry(`${API_BASE}/mods/ignored-pairs`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modIdA, modIdB }),
    }).then(handleResponse),
  checkUpdates: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/check-updates", undefined, options),
  getServerMods: () => apiGet("/mods/server-mods"),
  syncFromServer: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/sync-from-server", undefined, options),
  clearUpdates: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/clear-updates", undefined, options),
  start: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/start", undefined, options),
  stop: (options?: { signal?: AbortSignal }) =>
    apiPost("/mods/stop", undefined, options),
  setAutoRestart: (enabled: boolean) =>
    apiPost("/mods/auto-restart", { enabled }),
  setRestartOptions: (options: {
    warningMinutes?: number;
    delayIfPlayersOnline?: boolean;
    maxDelayMinutes?: number;
    checkInterval?: number;
  }) => apiPut("/mods/restart-options", options),
  cancelPendingRestart: () => apiPost("/mods/cancel-pending-restart"),
  getWorkshopStatus: () => apiGet("/mods/workshop-status"),

  // Import a Steam Workshop collection
  importCollection: (collectionUrl: string) =>
    apiPost("/mods/import-collection", { collectionUrl }),

  // Get info for a single mod
  getModInfo: (workshopId: string) =>
    apiPost("/mods/get-mod-info", { workshopId }),

  // Write mods configuration to server .ini file
  writeToIni: (
    mods: Array<{ workshopId: string; modId: string }>,
    mapFolders?: string[],
  ) => apiPost("/mods/write-to-ini", { mods, mapFolders }),

  // Get current mod configuration from .ini file
  getCurrentConfig: () => apiGet("/mods/current-config"),

  // Add a single mod to server .ini file (appends to existing)
  addToIni: (workshopId: string, modId?: string) =>
    apiPost("/mods/add-to-ini", { workshopId, modId }),

  // Remove a single mod from server .ini file (removes from both WorkshopItems= and Mods=)
  removeFromIni: (workshopId: string, modId?: string, modIds?: string[]) =>
    apiPost("/mods/remove-from-ini", { workshopId, modId, modIds }),

  // Batch remove multiple mods from tracking AND server .ini in one operation
  batchRemove: (workshopIds: string[]) =>
    apiPost("/mods/batch-remove", { workshopIds }),

  // Refresh display names for tracked mods with placeholder names (tries disk then Steam API)
  refreshNames: (workshopIds?: string[]) =>
    apiPost("/mods/refresh-names", { workshopIds }) as Promise<{
      success: boolean;
      checked: number;
      diskResolved: number;
      steamResolved: number;
      totalResolved: number;
      unresolved: number;
    }>,

  // List mods that exist on disk in the workshop folder but are NOT enabled in the server INI.
  listDiskOnly: () =>
    apiGet("/mods/disk-only") as Promise<{
      mods: Array<{ workshop_id: string; name: string }>;
      reason?: string;
    }>,

  // Enable a disk-only mod by appending its workshop ID to the INI WorkshopItems=.
  enableDiskMod: (workshopId: string) =>
    apiPost("/mods/enable-disk-mod", { workshopId }) as Promise<{
      success: boolean;
      workshopId: string;
      modIdsAdded: number;
    }>,

  // Delete a mod from disk: removes the workshop folder and strips it from the INI.
  deleteDiskMod: (workshopId: string) =>
    apiPost("/mods/delete-disk-mod", { workshopId }) as Promise<{
      success: boolean;
      workshopId: string;
      deletedFromDisk: boolean;
      modIdsStripped: number;
    }>,

  // Batch delete: removes multiple workshop folders + strips them from the INI in one INI write.
  batchDeleteDiskMods: (workshopIds: string[]) =>
    apiPost("/mods/batch-delete-disk-mods", { workshopIds }) as Promise<{
      success: boolean;
      total: number;
      deletedFromDisk: number;
      modIdsStripped: number;
      results: Array<{ workshopId: string; deletedFromDisk: boolean }>;
    }>,

  // Smart triage for orphan WorkshopItems= entries.
  // Per ID: ignored or missing → drop from WorkshopItems=; downloaded → add its mod IDs to Mods=.
  resolveOrphanWorkshop: (workshopIds: string[]) =>
    apiPost("/mods/resolve-orphan-workshop", { workshopIds }) as Promise<{
      success: boolean;
      total: number;
      counts: {
        enabled: number;
        droppedIgnored: number;
        droppedMissing: number;
        droppedNoModInfo: number;
      };
      modIdsAdded: number;
      wsDropped: number;
      breakdown: Array<{
        workshopId: string;
        action: string;
        modIds: string[];
      }>;
    }>,

  // Toggle a single mod ID on/off in the Mods= line
  toggleModId: (modId: string, enabled: boolean) =>
    apiPost("/mods/toggle-mod-id", { modId, enabled }) as Promise<{
      success: boolean;
      modId: string;
      enabled: boolean;
      totalMods: number;
    }>,

  // Batch toggle multiple mod IDs on/off in a single INI write
  batchToggleModIds: (changes: Array<{ modId: string; enabled: boolean }>) =>
    apiPost("/mods/batch-toggle-mod-ids", { changes }) as Promise<{
      success: boolean;
      changed: number;
      totalMods: number;
    }>,

  // Repair Map= entries - remove invalid map entries that don't have actual map data on disk
  repairMapEntries: () =>
    apiPost("/mods/repair-map-entries") as Promise<{
      success: boolean;
      removed: string[];
      added?: string[];
      remaining: string[];
      message: string;
    }>,

  // Deduplicate mod IDs - remove duplicate entries from Mods= line
  deduplicateModIds: () =>
    apiPost("/mods/deduplicate-mod-ids") as Promise<{
      success: boolean;
      removed: string[];
      removedCount: number;
      remaining: number;
      message: string;
    }>,

  // Missing Dependencies: Add a single resolved dep to INI
  addMissingDep: (workshopId: string, modId?: string) =>
    apiPost("/mods/add-missing-dep", { workshopId, modId }) as Promise<{
      success: boolean;
      workshopId: string;
      modId: string | null;
      wsAdded: boolean;
      modIdAdded: boolean;
      mapFolders: string[];
      message: string;
    }>,

  // Missing Dependencies: Batch add all resolved deps
  addAllResolvedDeps: (deps: Array<{ workshopId: string; modId?: string }>) =>
    apiPost("/mods/add-all-resolved-deps", { deps }) as Promise<{
      success: boolean;
      total: number;
      wsAdded: number;
      modIdsAdded: number;
      mapFolders: string[];
      // Per-item outcome, one entry per requested dep, same field names as
      // the single-add sibling above (addMissingDep) -- see
      // server/routes/mods.js's own comment on why. The aggregate counts
      // above can't tell a caller WHICH dep (if any) never got a real Mod
      // ID resolved; callers must check each entry's own `modId` for null
      // to decide per-row success, not the aggregate counts or the absence
      // of a thrown error (a batch with one unresolved dep out of three
      // still returns success:true, by design, since the other two did
      // apply and a hard failure would discard those too).
      results: Array<{
        workshopId: string;
        modId: string | null;
        wsAdded: boolean;
        modIdAdded: boolean;
      }>;
      message: string;
    }>,

  // Missing Dependencies: Search Steam Workshop for a mod by name/ID
  searchWorkshopMods: (
    query: string,
    opts?: {
      parentName?: string;
      parentWorkshopId?: string;
      parentModId?: string;
    },
  ) =>
    apiPost("/mods/search-workshop-mods", {
      query,
      ...(opts || {}),
    }) as Promise<{
      success: boolean;
      query: string;
      variantsTried?: string[];
      steamSearchEnabled?: boolean;
      steamSearchAttempted?: boolean;
      results: Array<{
        workshopId: string;
        modId?: string;
        modName: string;
        description?: string;
        subscriberCount?: number;
        source: "local" | "steam";
        isDownloaded: boolean;
        matchedVariant?: string;
        relevance?: number;
      }>;
      searchUrl: string;
    }>,

  // Missing Dependencies: Auto-resolve unresolved deps via local scan
  resolveMissingDeps: (
    deps: Array<{ missingDep: string; resolvedWorkshopId?: string }>,
  ) =>
    apiPost("/mods/resolve-missing-deps", { deps }) as Promise<{
      success: boolean;
      deps: Array<{
        missingDep: string;
        resolvedWorkshopId?: string;
        resolvedModName?: string;
      }>;
      resolvedCount: number;
    }>,

  // ── Workshop collection sync ────────────────────────────────────────
  collectionDiff: () =>
    apiGet("/mods/collection/diff") as Promise<{
      ok: boolean;
      error?: string;
      title?: string | null;
      inCollection: string[];
      toAdd: string[];
      toRemove: string[];
      collectionOnly?: string[];
      items: Array<{
        workshopId: string;
        name: string | null;
        status: "synced" | "to-add" | "collection-only" | "tracked-only";
        inTracked: boolean;
        inCollection: boolean;
        inServer: boolean;
      }>;
      collectionId: string | null;
      autoSync: boolean;
      hasCredentials: boolean;
      tokenExpiry: number | null;
      tokenExpired: boolean;
      trackedCount: number;
      serverConfigRead?: boolean;
    }>,
  collectionAddItem: (workshopId: string) =>
    apiPost("/mods/collection/items", { workshopId }) as Promise<{
      ok: true;
      workshopId: string;
      action: "add";
    }>,
  collectionRemoveItem: (workshopId: string) =>
    apiDelete(`/mods/collection/items/${workshopId}`) as Promise<{
      ok: true;
      workshopId: string;
      action: "remove";
    }>,
  collectionUntrack: (workshopId: string) =>
    apiDelete(`/mods/collection/tracking/${workshopId}`) as Promise<{
      ok: true;
      workshopId: string;
      removed: boolean;
      message: string;
    }>,
  purgeMod: (workshopId: string, name?: string | null) =>
    apiPost("/mods/purge", { workshopId, name }) as Promise<{
      success: boolean;
      workshopId: string;
      name: string | null;
      collection: { attempted: boolean; ok: boolean; error: string | null };
      deletedFromDisk: boolean;
      modIdsStripped: number;
      mapFoldersStripped: number;
    }>,
  collectionSync: () =>
    apiPost("/mods/collection/sync", {}) as Promise<{
      success: boolean;
      collectionId: string;
      added: string[];
      removed: string[];
      errors: Array<{ action: "add" | "remove"; id: string; error: string }>;
      message: string;
    }>,
  collectionTest: () =>
    apiPost("/mods/collection/test", {}) as Promise<{
      success: boolean;
      collectionId: string;
      title: string | null;
      itemCount: number;
      message: string;
    }>,
  collectionBrowsers: () =>
    apiGet("/mods/collection/browsers") as Promise<{
      supported: boolean;
      platform: string;
      browsers: Array<{
        id: string;
        label: string;
        family: string;
        detected: boolean;
      }>;
    }>,
  // On success the server extracts AND saves the credentials in one step
  // (2026-08-26 bug hunt: the raw values never need to cross the wire, since
  // nothing displays them) -- `saved: true` and no sessionid/steamLoginSecure
  // fields. On failure the shape is unchanged: no credentials were found or
  // extractable, so there's nothing to omit.
  collectionExtractCookies: (browser: string) =>
    apiPost("/mods/collection/extract-cookies", { browser }) as Promise<{
      ok: boolean;
      browser: string;
      saved?: boolean;
      sessionid?: string | null;
      steamLoginSecure?: string | null;
      missing?: string[];
      notes?: string[];
      error?: string | null;
    }>,
  collectionSaveCookies: (sessionid: string, steamLoginSecure: string) =>
    apiPost("/mods/collection/extension-push", { sessionid, steamLoginSecure }) as Promise<{
      ok: boolean;
      message: string;
    }>,

  // Sync mod IDs from downloaded workshop mods - reads mod.info files and updates Mods= in ini
  syncModIds: () => apiPost("/mods/sync-mod-ids"),

  // Discover all mod IDs from a workshop item (for mods with multiple IDs)
  discoverModIds: (
    workshopId?: string,
    workshopUrl?: string,
    options?: { signal?: AbortSignal },
  ) =>
    apiPost(
      "/mods/discover-mod-ids",
      { workshopId, workshopUrl },
      options,
    ) as Promise<{
      success: boolean;
      workshopId: string;
      name: string;
      description: string | null;
      modIds: string[];
      hasMultipleModIds: boolean;
      sources: Array<{ modId: string; source: string }>;
      isMap: boolean;
      mapFolders: string[];
      isDownloaded: boolean;
      tags: string[];
    }>,

  // Add mod with specific mod IDs selected (for multi-ID mods)
  addModAdvanced: (
    workshopId: string,
    selectedModIds?: string[],
    includeAllModIds?: boolean,
    displayName?: string,
    mapFolder?: string,
  ) =>
    apiPost("/mods/add-mod-advanced", {
      workshopId,
      selectedModIds,
      includeAllModIds,
      displayName,
      mapFolder,
    }) as Promise<{
      success: boolean;
      workshopId: string;
      addedModIds: string[];
      totalModIdsInConfig: number;
      workshopAlreadyExisted: boolean;
      mapFoldersAdded: string[];
      message: string;
    }>,

  // Mod Presets
  getPresets: () => apiGet("/mods/presets"),
  createPreset: (name: string, description?: string) =>
    apiPost("/mods/presets", { name, description }),
  updatePreset: (
    id: number,
    data: {
      name?: string;
      description?: string;
      workshopIds?: string[];
      modIds?: string[];
    },
  ) => apiPut(`/mods/presets/${id}`, data),
  deletePreset: (id: number) => apiDelete(`/mods/presets/${id}`),
  applyPreset: (id: number) => apiPost(`/mods/presets/${id}/apply`),

  // Mod Load Order
  saveModOrder: (modIds: string[]) => apiPost("/mods/save-order", { modIds }),

  // Mod Conflict Scanner
  getConflicts: (options?: RequestInit) =>
    apiGet<import("@/types").ConflictScanResult>("/mods/conflicts", options),
  getCachedConflicts: () =>
    apiGet<
      | (import("@/types").ConflictScanResult & {
          stale?: boolean;
          _workshopIdsSnapshot?: string[];
          _modIdsSnapshot?: string[];
        })
      | null
    >("/mods/conflicts/cached"),
};

// Chunks API (Chunk Cleaner)
// Large saves can have 50k+ chunk files — directory traversal takes time, so we
// use a generous timeout. The chunk scan streams `chunkScan:progress` over the
// socket, so the UI shows real progress; we allow up to 10 min for slow UNC
// shares rather than aborting at 60s and leaving the map blank.
export const chunksApi = {
  getSaves: (customPath?: string) =>
    apiGet(
      `/chunks/saves${customPath ? `?customPath=${encodeURIComponent(customPath)}` : ""}`,
      { timeout: 60000 },
    ),
  getChunks: (saveName: string, customPath?: string, scanId?: string) => {
    const params = new URLSearchParams();
    if (customPath) params.set("customPath", customPath);
    if (scanId) params.set("scanId", scanId);
    const qs = params.toString();
    return apiGet(
      `/chunks/chunks/${encodeURIComponent(saveName)}${qs ? `?${qs}` : ""}`,
      { timeout: 600000 },
    );
  },
  getStats: (saveName: string, customPath?: string) =>
    apiGet(
      `/chunks/stats/${encodeURIComponent(saveName)}${customPath ? `?customPath=${encodeURIComponent(customPath)}` : ""}`,
      { timeout: 60000 },
    ),
  deleteChunks: (
    saveName: string,
    chunks: Array<{
      file: string;
      x: number;
      y: number;
      source?: string;
      cellX?: number;
      cellY?: number;
    }>,
    createBackup: boolean = true,
    customPath?: string,
    deleteVehicles: boolean = false,
    force: boolean = false,
  ) =>
    apiPost("/chunks/delete-chunks", {
      saveName,
      chunks,
      createBackup,
      customPath,
      deleteVehicles,
      force,
    }),
  deleteRegion: (
    saveName: string,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    createBackup: boolean = true,
    invert: boolean = false,
    customPath?: string,
    deleteVehicles: boolean = false,
    force: boolean = false,
  ) =>
    apiPost("/chunks/delete-region", {
      saveName,
      minX,
      maxX,
      minY,
      maxY,
      createBackup,
      invert,
      customPath,
      deleteVehicles,
      force,
    }),
  browse: (browsePath?: string) =>
    apiGet(
      `/chunks/browse${browsePath ? `?path=${encodeURIComponent(browsePath)}` : ""}`,
    ),
  suggestedPaths: () =>
    apiGet<{
      candidates: Array<{ path: string; exists: boolean; hasSaves: boolean }>;
      platform: string;
    }>("/chunks/suggested-paths"),
  savePath: (p: string) =>
    apiPost<{
      ok: boolean;
      target: "server" | "setting";
      serverId?: string;
      path: string;
    }>("/chunks/save-path", { path: p }),
};

// Config API
export const configApi = {
  getAppSettings: () => apiGet("/config/app-settings"),
  updateAppSettings: (settings: Record<string, unknown>) =>
    apiPut("/config/app-settings", { settings }),
  getCorsDiagnostics: () =>
    apiGet("/config/cors-debug") as Promise<{
      diagnostics: {
        allowAll: boolean;
        allowPrivateNetworks: boolean;
        debug: boolean;
        customOrigins: string[];
        effectiveAllowedOrigins: string[];
        blocked: Array<{
          id: number;
          origin: string;
          source: string;
          blockedAt: string;
        }>;
        blockedCount: number;
        lastLoadedAt: string | null;
      };
    }>,
  reloadCorsDiagnostics: () =>
    apiPost("/config/cors-debug/reload") as Promise<{
      success: boolean;
      diagnostics: {
        allowAll: boolean;
        allowPrivateNetworks: boolean;
        debug: boolean;
        customOrigins: string[];
        effectiveAllowedOrigins: string[];
        blocked: Array<{
          id: number;
          origin: string;
          source: string;
          blockedAt: string;
        }>;
        blockedCount: number;
        lastLoadedAt: string | null;
      };
    }>,
  clearCorsBlockedOrigins: () =>
    apiDelete("/config/cors-debug/blocked") as Promise<{
      success: boolean;
      diagnostics: {
        allowAll: boolean;
        allowPrivateNetworks: boolean;
        debug: boolean;
        customOrigins: string[];
        effectiveAllowedOrigins: string[];
        blocked: Array<{
          id: number;
          origin: string;
          source: string;
          blockedAt: string;
        }>;
        blockedCount: number;
        lastLoadedAt: string | null;
      };
    }>,
  testRcon: () => apiPost<ConfigTestRconResult>("/config/test-rcon"),
};

// Result of testing the currently-saved RCON config (as opposed to
// RconTestResult above, which tests arbitrary unsaved credentials). Failure
// carries the same "unreachable" vs "auth_failed" split as RconTestResult
// (server/routes/config.js POST /test-rcon) so callers can tell "host is
// down" apart from "host is up, password is stale" instead of collapsing
// both into one generic failure.
export interface ConfigTestRconResult {
  success: boolean;
  connected: boolean;
  message?: string;
  warning?: boolean;
  error?: "unreachable" | "auth_failed";
  detail?: string;
}

// Discord API
export const discordApi = {
  getStatus: () => apiGet("/discord/status"),
  getConfig: () => apiGet("/discord/config"),
  updateConfig: (
    token: string,
    guildId: string,
    adminRoleId?: string,
    channelId?: string,
    autoStart?: boolean,
    modRoleId?: string,
    chatRelayEnabled?: boolean,
    chatRelayChannelId?: string,
    chatRelayScope?: "public" | "no-yell" | "general",
  ) =>
    apiPut("/discord/config", {
      token,
      guildId,
      adminRoleId,
      modRoleId,
      channelId,
      autoStart,
      chatRelayEnabled,
      chatRelayChannelId,
      chatRelayScope,
    }),
  resetConfig: () => apiPost("/discord/reset"),
  start: () => apiPost("/discord/start"),
  stop: () => apiPost("/discord/stop"),
  testToken: (token: string) => apiPost("/discord/test", { token }),
  sendTestMessage: () => apiPost("/discord/test-message"),
  getWebhookEvents: () => apiGet("/discord/webhook-events"),
  updateWebhookEvents: (
    events: Record<string, { enabled: boolean; template: string }>,
  ) => apiPut("/discord/webhook-events", { events }),
  getPermissions: () =>
    apiGet("/discord/permissions") as Promise<{
      permissions: Record<string, string>;
    }>,
  updatePermissions: (permissions: Record<string, string>) =>
    apiPut("/discord/permissions", { permissions }) as Promise<{
      success: boolean;
      permissions: Record<string, string>;
    }>,
};

// Server Instance Type
export interface ServerInstance {
  id: string | number;
  name: string;
  serverName: string;
  installPath: string;
  zomboidDataPath: string | null;
  serverConfigPath: string | null;
  dockerContainerName?: string | null;
  dockerContainerId?: string | null;
  branch?: string;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  serverPort: number;
  minMemory: number;
  maxMemory: number;
  useNoSteam: boolean;
  useDebug: boolean;
  useUpnp?: boolean;
  isRemote: boolean;
  // Only set on /servers/active: the remote Server folder is reachable over SFTP.
  remoteConfigConfigured?: boolean;
  isActive: boolean;
  startCommand: string;
  lifecycleProvider?: "direct" | "systemd" | "openrc";
  adminPassword: string;
  createdAt: string;
}

// Mount discovery — probes common Docker bind-mount locations for PZ server
// files so a fresh panel can offer a one-click "connect this" profile.
export interface DiscoveredMount {
  installPath: string;
  dataPath: string | null;
  source: string;
  serverNames: string[];
  hasStartScript: boolean;
  hasPanelBridge: boolean;
}

// One signal (host / server / bridge) from GET /servers/active/status — see
// server/utils/serverStatusModel.js for the full set of `status` values per
// signal (they differ: host uses running/stopped/unknown/not-applicable,
// server uses connected/disconnected/connecting, bridge uses
// active/offline/not-installed).
export interface ServerStatusSignal {
  status: string;
  label: string;
  detail: string | null;
}

export interface ComposedServerStatus {
  provider: string;
  selected: boolean;
  host: ServerStatusSignal;
  server: ServerStatusSignal;
  bridge: ServerStatusSignal;
  summary: string;
}

// Servers API (multi-server management)
export const serversApi = {
  getAll: () => apiGet("/servers") as Promise<{
    servers: ServerInstance[];
    lifecycleCapabilities?: {
      supported: boolean;
      platform: string;
      containerized: boolean;
      providers: Array<"direct" | "systemd" | "openrc">;
    };
  }>,
  getActive: () =>
    apiGet("/servers/active") as Promise<{ server: ServerInstance }>,
  getComposedStatus: (options?: { retries?: number }) =>
    apiGet("/servers/active/status", undefined, options?.retries) as Promise<ComposedServerStatus>,
  getResolvedActive: async () => {
    const data = (await apiGet("/servers")) as { servers: ServerInstance[] };
    return {
      server:
        data.servers.find((server) => server.isActive) ??
        data.servers[0] ??
        null,
    };
  },
  getStatus: (options?: { retries?: number }) =>
    apiGet("/servers/status", undefined, options?.retries) as Promise<{
      servers: Array<{
        id: string;
        name: string;
        running: boolean;
        pid: string | null;
        isActive: boolean;
        stateUnknown?: boolean;
      }>;
      detectedProcesses: number;
      detectionError: string | null;
    }>,
  getRconStatuses: () =>
    apiGet("/servers/rcon-status") as Promise<{
      servers: Array<{ id: string; status: "connected" | "unreachable" | "auth_failed" | "unconfigured" | "unavailable" }>;
    }>,
  get: (id: string | number) =>
    apiGet(`/servers/${id}`) as Promise<{ server: ServerInstance }>,
  create: (
    config: Partial<ServerInstance> & {
      // Set instead of rconPassword when importing a server detected by
      // /auto-scan or /detect -- those never return the ini's RCON
      // password, so the server re-reads it from this reference at
      // creation time.
      importIniFrom?: { dataPath: string; serverName: string };
    },
  ) =>
    apiPost("/servers", config) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
  update: (id: string | number, updates: Partial<ServerInstance>) =>
    apiPut(`/servers/${id}`, updates) as Promise<{
      server: ServerInstance;
      message: string;
      warnings?: string[];
    }>,
  getLifecycleTemplate: (
    id: string | number,
    provider: "systemd" | "openrc",
  ) =>
    apiGet(
      `/servers/${id}/lifecycle-template?provider=${encodeURIComponent(provider)}`,
    ) as Promise<{
      provider: "systemd" | "openrc";
      serviceName: string;
      filename: string;
      installPath: string;
      content: string;
      commands: string[];
      warning: string;
    }>,
  activateLifecycleProvider: (
    id: string | number,
    provider: "direct" | "systemd" | "openrc",
  ) =>
    apiPost(`/servers/${id}/lifecycle-provider`, {
      provider,
      confirm: true,
    }) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
  delete: (id: string | number) =>
    apiDelete(`/servers/${id}`) as Promise<{
      success: boolean;
      message: string;
    }>,
  activate: (id: string | number) =>
    apiPost(`/servers/${id}/activate`) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
  steamUpdate: (
    steamcmdPath: string,
    installPath: string,
    branch: string = "stable",
  ) =>
    apiPost("/server/steam-update", {
      steamcmdPath,
      installPath,
      branch,
      validateFiles: false,
    }) as Promise<{ success: boolean; message: string }>,
  steamVerify: (
    steamcmdPath: string,
    installPath: string,
    branch: string = "stable",
  ) =>
    apiPost("/server/steam-update", {
      steamcmdPath,
      installPath,
      branch,
      validateFiles: true,
    }) as Promise<{ success: boolean; message: string }>,

  // Probe common Docker bind-mount locations for PZ server files.
  discoverMounts: () =>
    apiGet("/servers/discover-mounts") as Promise<{
      mounts: DiscoveredMount[];
    }>,

  // Turn a discover-mounts result into a fully-populated server profile —
  // RCON settings are read server-side from the discovered server's own INI.
  createFromDiscovery: (data: {
    installPath: string;
    dataPath: string;
    serverName?: string;
    name?: string;
  }) =>
    apiPost("/servers/create-from-discovery", data) as Promise<{
      server: ServerInstance;
      message: string;
    }>,
};

export interface DockerContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface DockerContainerStats {
  cpuPercent: number;
  memoryUsed: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  diskRead: number;
  diskWrite: number;
}

export const dockerApi = {
  getStatus: () => apiGet("/docker/status") as Promise<{
    enabled: boolean;
    available: boolean;
    containers: DockerContainerSummary[];
  }>,
  getStats: () => apiGet("/docker/stats") as Promise<{
    containers: Record<string, DockerContainerStats>;
  }>,
  runAction: (id: string, action: "start" | "stop" | "restart", serverId: string | number) =>
    apiPost(`/docker/containers/${encodeURIComponent(id)}/${action}`, { serverId }) as Promise<{
      success: boolean;
      message?: string;
      error?: string;
    }>,
};

// Server Files API (INI, Sandbox, Spawn Points)
export interface SpawnPoint {
  worldX: number;
  worldY: number;
  posX: number;
  posY: number;
  posZ?: number;
}

// Spawn points are organized by profession (e.g., unemployed, policeofficer, etc.)
export type SpawnPointsByProfession = Record<string, SpawnPoint[]>;

export interface SpawnRegion {
  name: string;
  file: string;
  isServerFile?: boolean;
}

export interface SandboxData {
  VERSION: number;
  settings: Record<string, string | number | boolean>;
  ZombieLore: Record<string, string | number | boolean>;
  ZombieConfig: Record<string, string | number | boolean>;
  MultiplierConfig: Record<string, string | number | boolean>;
  Map: Record<string, string | number | boolean>;
  Basement: Record<string, string | number | boolean>;
  Music?: Record<string, string | number | boolean>;
  Debug?: Record<string, string | number | boolean>;
}

export interface UtilitiesChangeResult {
  message?: string;
  power?: boolean;
  water?: boolean;
  hydroPowerOn?: boolean;
  debug?: string[];
  // false when the in-game change could not be mirrored into SandboxVars.lua,
  // which means a server restart will undo it.
  persisted?: boolean;
  persistReason?: string | null;
}

// server-files/backups' own shape (config-file .bak backups made by the
// server-files subsystem -- see serverFiles.js's GET /backups) -- distinct
// from backup.js/backupService.js's full .zip server backups below
// (ServerBackupArchive). These two were both named BackupFile until
// 2026-08-27: TypeScript silently merged the same-named interfaces into one
// type requiring every field from both, so the merged type falsely claimed
// this shape always carries name/path too (see ServerBackupArchive's
// comment for the mirror image of this note, and
// eslint-rules/no-duplicate-interface-name.js for the rule that now catches
// this class of collision repo-wide).
export interface ConfigBackupFile {
  filename: string;
  size: number;
  created: string;
}

export interface BackupHistoryRecord {
  id: string;
  fileName: string;
  createdAt: string;
  size: number;
  serverId: string | number | null;
  serverName: string;
}

export interface BackupSnapshot {
  schemaVersion: number;
  createdAt: string;
  server: { id: string | number | null; name: string; provider: string };
  serverIni: Record<string, string>;
  sandboxVars: Record<string, string | number | boolean>;
}

export interface ConfigTemplate {
  id: string;
  name: string;
  description: string;
  type: "ini" | "sandbox" | "both";
  created: string;
  modified: string;
  hasIni: boolean;
  hasSandbox: boolean;
}

export interface ConfigTemplateDetail extends ConfigTemplate {
  ini?: Record<string, string>;
  iniRaw?: string;
  sandboxRaw?: string;
  serverName?: string;
}

export const serverFilesApi = {
  // Paths
  getPaths: () =>
    apiGet("/server-files/paths") as Promise<{
      configPath: string;
      serverName: string;
      files: {
        ini: string;
        sandbox: string;
        spawnpoints: string;
        spawnregions: string;
      };
      exists: {
        ini: boolean;
        sandbox: boolean;
        spawnpoints: boolean;
        spawnregions: boolean;
      };
    }>,

  // INI
  getIni: () =>
    apiGet("/server-files/ini") as Promise<{
      settings: Record<string, string>;
      path: string;
      serverName: string;
      duplicateKeys?: Array<{ key: string; count: number }>;
    }>,
  saveIni: (settings: Record<string, string>) =>
    apiPut("/server-files/ini", { settings }) as Promise<{
      success: boolean;
      message: string;
      path: string;
      settings: Record<string, string>;
      restartRequired?: boolean;
    }>,

  // Sandbox
  getSandbox: () =>
    apiGet("/server-files/sandbox") as Promise<{
      sandbox: SandboxData;
      path: string;
      serverName: string;
    }>,
  saveSandbox: (sandbox: SandboxData) =>
    apiPut("/server-files/sandbox", { sandbox }) as Promise<{
      success: boolean;
      created: boolean;
      message: string;
      path: string;
      unpersistedKeys?: string[];
      restartRequired?: boolean;
    }>,
  validateSandbox: () =>
    apiGet("/server-files/sandbox/validate") as Promise<{
      valid: boolean;
      braceDepth: number;
    }>,
  repairSandbox: () =>
    apiPost("/server-files/sandbox/repair") as Promise<{
      success: boolean;
      alreadyValid?: boolean;
      repaired?: boolean;
      changes?: string[];
      message?: string;
      error?: string;
      restartRequired?: boolean;
    }>,

  // Spawn Points (keyed by profession)
  getSpawnPoints: () =>
    apiGet("/server-files/spawnpoints") as Promise<{
      spawnpoints: SpawnPointsByProfession;
      path: string;
    }>,
  saveSpawnPoints: (spawnpoints: SpawnPointsByProfession) =>
    apiPut("/server-files/spawnpoints", { spawnpoints }),

  // Spawn Regions
  getSpawnRegions: () =>
    apiGet("/server-files/spawnregions") as Promise<{
      spawnregions: SpawnRegion[];
      path: string;
    }>,
  saveSpawnRegions: (spawnregions: SpawnRegion[]) =>
    apiPut("/server-files/spawnregions", { spawnregions }),

  // Raw file access
  getRaw: (type: "ini" | "sandbox" | "spawnpoints" | "spawnregions") =>
    apiGet(`/server-files/raw/${type}`) as Promise<{
      content: string;
      path: string;
      filename: string;
    }>,
  saveRaw: (
    type: "ini" | "sandbox" | "spawnpoints" | "spawnregions",
    content: string,
  ) => apiPut(`/server-files/raw/${type}`, { content }),

  // Backups
  getBackups: () =>
    apiGet("/server-files/backups") as Promise<{
      backups: ConfigBackupFile[];
      path: string;
    }>,
  restoreBackup: (filename: string) =>
    apiPost(`/server-files/restore/${filename}`),

  // Reload options
  saveAndReload: () => apiPost("/server-files/save-and-reload"),

  saveSandboxOption: (
    name: string,
    value: string | number | boolean,
  ): Promise<{ success: boolean; persisted: boolean }> =>
    apiPut("/server-files/sandbox-option", { name, value }),

  // Config Templates
  getTemplates: () =>
    apiGet("/server-files/templates") as Promise<{
      templates: ConfigTemplate[];
    }>,
  getTemplate: (id: string) =>
    apiGet(`/server-files/templates/${id}`) as Promise<ConfigTemplateDetail>,
  saveAsTemplate: (data: {
    name: string;
    description?: string;
    includeIni?: boolean;
    includeSandbox?: boolean;
  }) =>
    apiPost("/server-files/templates", data) as Promise<{
      success: boolean;
      id: string;
      name: string;
      message: string;
    }>,
  applyTemplate: (
    id: string,
    options?: { applyIni?: boolean; applySandbox?: boolean },
  ) =>
    apiPost(`/server-files/templates/${id}/apply`, options || {}) as Promise<{
      success: boolean;
      applied: string[];
      message: string;
      backupWarnings?: string[];
    }>,
  updateTemplate: (id: string, data: { name?: string; description?: string }) =>
    apiPut(`/server-files/templates/${id}`, data),
  deleteTemplate: (id: string) => apiDelete(`/server-files/templates/${id}`),

  // File browser (for image path fields)
  browseFiles: (browsePath?: string, extensions?: string[]) => {
    const params = new URLSearchParams();
    if (browsePath) params.set("path", browsePath);
    if (extensions?.length) params.set("extensions", extensions.join(","));
    return apiGet(`/server-files/browse-files?${params}`) as Promise<{
      currentPath: string;
      parent: string | null;
      directories: string[];
      files: { name: string; ext: string }[];
    }>;
  },
  fetchImagePreview: async (filePath: string): Promise<string> => {
    const response = await apiFetch(
      `/server-files/image-preview?path=${encodeURIComponent(filePath)}`,
    );
    if (!response.ok)
      throw new ApiError("Failed to load image preview", {
        status: response.status,
      });
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  },
};

// =============================================
// SIMULATION TEMPLATES API (server/routes/templates.js)
// Named "Sim*" to avoid colliding with the unrelated raw ini/sandbox
// ConfigTemplate types above (server/routes/serverFiles.js templates).
// =============================================
export interface SimTemplateMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  pzBuild: string;
  createdAt?: string;
}

export interface SimTemplateModRef {
  workshopId: string;
  modId?: string;
  name?: string;
}

export type SimTemplateValueMap = Record<string, string | number | boolean>;

export interface SimTemplate {
  schemaVersion: number;
  meta: SimTemplateMeta;
  sandboxVars: Record<string, SimTemplateValueMap>;
  serverIni: SimTemplateValueMap;
  iniExclusions: string[];
  mods: SimTemplateModRef[];
  map: { mapId: string };
  difficulty: { level?: string };
  isBuiltin?: boolean;
}

export interface SimTemplateDiff {
  serverIni: Array<{ key: string; from: unknown; to: unknown }>;
  sandboxVars: Array<{
    section: string;
    key: string;
    from: unknown;
    to: unknown;
  }>;
  summary: { iniChanges: number; sandboxChanges: number; totalChanges: number };
}

export interface SimTemplateApplyResult {
  success: boolean;
  ini: { appliedKeys: string[] } | null;
  sandbox:
    | { applied: Array<{ section: string; key: string }>; skipped: Array<{ section: string; key: string }> }
    | { skipped: true; reason: string }
    | null;
  backups: string[];
  error?: string;
}

export const templatesApi = {
  list: () => apiGet("/templates") as Promise<{ templates: SimTemplate[] }>,
  get: (id: string) =>
    apiGet(`/templates/${encodeURIComponent(id)}`) as Promise<{
      template: SimTemplate;
    }>,
  // Create either from scratch (pass name/description/tags/sandboxVars/serverIni)
  // or a full exported template object re-saved as a new user template.
  create: (input: Record<string, unknown>) =>
    apiPost("/templates", input) as Promise<{
      success: boolean;
      template?: SimTemplate;
      error?: string;
    }>,
  import: (template: unknown) =>
    apiPost("/templates/import", { template }) as Promise<{
      success: boolean;
      template?: SimTemplate;
      error?: string;
    }>,
  // Returns the raw template JSON (server sets Content-Disposition, but we
  // fetch it as data and build our own .pztemplate.json blob client-side —
  // see downloadExport — so the extension matches this feature's format).
  export: (id: string) =>
    apiGet(`/templates/${encodeURIComponent(id)}/export`) as Promise<SimTemplate>,
  downloadExport: async (id: string, filenameBase: string) => {
    const template = await apiGet<SimTemplate>(
      `/templates/${encodeURIComponent(id)}/export`,
    );
    const blob = new Blob([JSON.stringify(template, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filenameBase || id}.pztemplate.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
  preview: (id: string, serverId: string | number) =>
    apiPost(`/templates/${encodeURIComponent(id)}/preview`, {
      serverId,
    }) as Promise<{ success: boolean; diff?: SimTemplateDiff; error?: string }>,
  apply: (
    id: string,
    serverId: string | number,
    options?: { backup?: boolean; applyIni?: boolean; applySandbox?: boolean },
  ) =>
    apiPost(`/templates/${encodeURIComponent(id)}/apply`, {
      serverId,
      options,
    }) as Promise<SimTemplateApplyResult>,
  delete: (id: string) =>
    apiDelete(`/templates/${encodeURIComponent(id)}`) as Promise<{
      success: boolean;
      error?: string;
    }>,
  // A hidden built-in never appears in list() -- it's not deleted, just
  // filtered out server-side (server/services/templateService.js) -- so
  // these two are the only way to see one again and bring it back.
  listHidden: () => apiGet("/templates/hidden") as Promise<{ templates: SimTemplate[] }>,
  unhide: (id: string) =>
    apiPost(`/templates/${encodeURIComponent(id)}/unhide`, {}) as Promise<{
      success: boolean;
      error?: string;
    }>,
};

// Wire shape of every response from POST /panel-bridge/command. `data.verified`
// is present on every successful mutating command as of the verify-gating pass
// (2026-08-23) -- typed here (rather than left as the `apiPost<T = any>`
// default) specifically so the next person adding a bridge call site is TOLD
// the field exists instead of having to already know to look for it. See
// client/src/lib/bridgeVerify.ts for how to interpret it (three states, not a
// boolean -- a missing key means an out-of-date bridge mod, not "unconfirmed").
export interface BridgeCommandResult<T = Record<string, unknown>> {
  success: boolean;
  data?: T & { verified?: "confirmed" | "unverifiable" };
  error?: string;
}

// Panel Bridge API (for direct Lua mod communication)
export const panelBridgeApi = {
  // Get bridge status
  getStatus: () =>
    apiGet("/panel-bridge/status") as Promise<{
      configured: boolean;
      bridgePath: string | null;
      isRunning: boolean;
      pendingCommands: number;
      modConnected: boolean;
      consecutiveFailures?: number;
      hasFileWatcher?: boolean;
      transport?: {
        type: "local" | "sftp";
        running: boolean;
        cachePath?: string | null;
        lastSyncAt?: number | null;
        lastLatencyMs?: number | null;
        lastError?: string | null;
        pollIntervalSeconds?: number | null;
      };
      config?: {
        statusStaleMs: number;
        pollIntervalMs: number;
        statusCheckMs: number;
      };
      statusFile?: {
        exists: boolean;
        path?: string;
        size?: number;
        modified?: string;
        age?: number;
        ageSeconds?: number;
        error?: string;
      };
      connection?: {
        healthy: boolean;
        canSendCommands: boolean;
        summary: string;
        issues: string[];
        checks: {
          bridgePathConfigured: boolean;
          bridgePathExists: boolean;
          bridgePathReadable: boolean;
          bridgePathWritable: boolean;
          commandsFilePresent: boolean;
          commandsFileReadable: boolean;
          resultsFilePresent: boolean;
          resultsFileReadable: boolean;
          statusFilePresent: boolean;
          statusFileReadable: boolean;
          statusFresh: boolean;
          statusAgeMs: number | null;
        };
      };
      modStatus: {
        alive: boolean;
        version: string;
        serverName: string;
        playerCount: number;
        players: string[];
        path: string;
        timestamp: number;
        age?: number;
        error?: string;
      } | null;
      detectedPaths: {
        serverName: string;
        installPath: string;
        zomboidDataPath: string;
      } | null;
    }>,

  // Auto-configure bridge from server (uses db settings)
  // If serverId is provided, use that server; otherwise use active server
  autoConfigure: (serverId?: string | number) =>
    apiPost("/panel-bridge/auto-configure", { serverId }) as Promise<{
      success: boolean;
      message?: string;
      bridgePath: string;
      serverName: string;
      source: string;
      hasStatus: boolean;
      searchedPaths: Array<{
        path: string;
        source: string;
        hasStatus: boolean;
        hasInit: boolean;
      }>;
      error?: string;
    }>,

  // Scan paths for a specific server ID to preview where bridge would connect
  scanForServer: (serverId: string | number) =>
    apiGet(`/panel-bridge/scan-server/${serverId}`) as Promise<{
      success: boolean;
      serverName: string;
      paths: Array<{
        path: string;
        source: string;
        hasStatus: boolean;
        hasInit: boolean;
        exists: boolean;
      }>;
      recommendedPath: string | null;
      error?: string;
    }>,

  // Auto-detect bridge path from server name (manual entry)
  autoDetect: (serverName: string, zomboidUserFolder?: string) =>
    apiPost("/panel-bridge/auto-detect", { serverName, zomboidUserFolder }),

  // Configure the bridge with Zomboid save path
  configure: (zomboidSavePath: string) =>
    apiPost("/panel-bridge/configure", { zomboidSavePath }),

  // Configure the bridge with a direct panelbridge folder path (manual override)
  configureDirect: (bridgePath: string) =>
    apiPost("/panel-bridge/configure-direct", { bridgePath }) as Promise<{
      success: boolean;
      message?: string;
      bridgePath: string;
      error?: string;
    }>,

  configureSftp: (config: {
    host: string;
    port: string;
    username: string;
    password: string;
    bridgePath: string;
    pollIntervalSeconds: string;
  }) => apiPost("/panel-bridge/sftp/configure", config) as Promise<{
    success: boolean;
    bridgePath: string;
    transport: { type: "sftp"; running: boolean; lastLatencyMs?: number | null };
  }>,

  listSftpLogs: (config: {
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    logPath?: string;
  }) => apiPost("/panel-bridge/sftp/logs/list", config) as Promise<{
    success: boolean;
    logPath: string;
    files: Array<{ name: string; size: number; modifiedAt: string | null }>;
  }>,

  listSftpConfigFiles: (config: {
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    configPath?: string;
  }) => apiPost("/panel-bridge/sftp/config/list", config) as Promise<{
    success: boolean;
    configPath: string;
    files: Array<{ name: string; size: number; modifiedAt: string | null }>;
  }>,

  tailSftpLog: (config: {
    name: string;
    maxBytes?: number;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    logPath?: string;
  }) => apiPost("/panel-bridge/sftp/logs/tail", config) as Promise<{
    success: boolean;
    name: string;
    size: number;
    truncated: boolean;
    bytesReturned: number;
    content: string;
  }>,

  testSftp: (config: {
    host: string;
    port: string;
    username: string;
    password: string;
    bridgePath: string;
    pollIntervalSeconds: string;
  }) => apiPost("/panel-bridge/sftp/test", config) as Promise<{
    success: boolean;
    statusExists: boolean;
    foldersReady: boolean;
    latencyMs: number;
    nextStep: string;
  }>,

  // Start the bridge
  start: () => apiPost("/panel-bridge/start"),

  // Stop the bridge
  stop: () => apiPost("/panel-bridge/stop"),

  // Refresh bridge state (restart with fresh state)
  refresh: () => apiPost("/panel-bridge/refresh"),

  // Scan for all panelbridge folders
  scanPaths: () =>
    apiGet("/panel-bridge/scan-paths") as Promise<{
      foundBridges: Array<{
        path: string;
        serverName: string;
        baseDir: string;
        hasStatus: boolean;
        hasInit: boolean;
        statusAge: number | null;
        modVersion: string | null;
        isActive: boolean;
      }>;
      scannedDirs: string[];
      currentPath: string | null;
      isRunning: boolean;
      modConnected: boolean;
    }>,

  // Ping the mod
  ping: () => apiGet("/panel-bridge/ping"),

  // Send a command to the game
  sendCommand: <T = Record<string, unknown>>(
    action: string,
    args?: Record<string, unknown>,
  ) =>
    apiPost<BridgeCommandResult<T>>("/panel-bridge/command", { action, args }),

  // Server-wide helicopter event (2026-08-30). Zero-arg, no dedicated route
  // -- same generic-passthrough shape trigger already used before this
  // (VALID_ACTIONS in server/routes/panelBridge.js), not a new pattern.
  // See PanelBridge.lua's handlers.triggerHelicopterEvent/
  // stopHelicopterEvent for why there's no per-player targeting: the only
  // confirmed real API (testHelicopter/endHelicopter) is server-wide.
  triggerHelicopterEvent: () =>
    apiPost<BridgeCommandResult<{ message: string }>>(
      "/panel-bridge/command",
      { action: "triggerHelicopterEvent", args: {} },
    ),
  stopHelicopterEvent: () =>
    apiPost<BridgeCommandResult<{ message: string }>>(
      "/panel-bridge/command",
      { action: "stopHelicopterEvent", args: {} },
    ),

  // Get weather info
  getWeather: () =>
    apiGet("/panel-bridge/weather") as Promise<{
      success: boolean;
      data: {
        temperature: number;
        humidity: number;
        windSpeed: number;
        windAngle: number;
        fogIntensity: number;
        cloudIntensity: number;
        precipitationIntensity: number;
        isRaining: boolean;
        isSnowing: boolean;
        isThunderStorming: boolean;
        dayLight: number;
        nightStrength: number;
        desaturation: number;
        viewDistance: number;
        ambient: number;
      };
    }>,

  // Get server info from mod
  getServerInfo: () => apiGet("/panel-bridge/server-info"),

  // Weather controls
  triggerBlizzard: (duration?: number) =>
    apiPost("/panel-bridge/weather/blizzard", { duration }),
  triggerTropicalStorm: (duration?: number) =>
    apiPost("/panel-bridge/weather/tropical-storm", { duration }),
  triggerStorm: (duration?: number) =>
    apiPost("/panel-bridge/weather/storm", { duration }),
  stopWeather: () => apiPost("/panel-bridge/weather/stop"),
  setSnow: (enabled: boolean) =>
    apiPost("/panel-bridge/weather/snow", { enabled }),
  // Generates a real B42 weather front (WeatherPeriod, via
  // ClimateManager.transmitGenerateWeather/triggerCustomWeather) -- distinct
  // from triggerBlizzard/triggerTropicalStorm/triggerStorm, which each fire
  // one fixed preset stage. This is the adjustable one: an operator picks
  // strength and whether the front is cold, warm, or stationary.
  // frontType: 0 = stationary, 1 = cold, 2 = warm (mapped to the game's own
  // FRONT_COLD/STATIONARY/WARM constants server-side).
  generateWeather: (strength?: number, frontType?: number) =>
    apiPost("/panel-bridge/weather/generate", { strength, frontType }),

  // Rain & Lightning (v1.1.0)
  startRain: (intensity?: number) =>
    apiPost("/panel-bridge/weather/rain/start", { intensity }),
  stopRain: () => apiPost("/panel-bridge/weather/rain/stop"),
  triggerLightning: (
    x?: number,
    y?: number,
    strike?: boolean,
    light?: boolean,
    rumble?: boolean,
  ) =>
    apiPost("/panel-bridge/weather/lightning", { x, y, strike, light, rumble }),

  // Climate controls (v1.1.0)
  getClimateFloats: () =>
    apiGet("/panel-bridge/climate/floats") as Promise<{
      success: boolean;
      data: {
        floats: Array<{
          id: number;
          name: string;
          actualName: string;
          value: number;
          min: number;
          max: number;
          isAdminEnabled: boolean;
        }>;
      };
    }>,
  setClimateFloat: (floatId: number, value: number, enable?: boolean) =>
    apiPost("/panel-bridge/climate/float", { floatId, value, enable }),
  resetClimateOverrides: () => apiPost("/panel-bridge/climate/reset"),

  // Game time controls (v1.1.0)
  getGameTime: () =>
    apiGet("/panel-bridge/time") as Promise<{
      success: boolean;
      data: {
        year: number;
        month: number;
        day: number;
        hour: number;
        minute: number;
        dayOfWeek: number;
        worldAgeHours: number;
        moonPhase: number;
        nightsSurvived: number;
        // Optional: added 2026-08-30 (panelbridge-audit) to the Lua
        // handler's response, and read defensively (typeof check, not a
        // required field) by Events.tsx's time-speed slider -- a bridge
        // mod predating that Lua change simply won't send it yet.
        multiplier?: number;
      };
    }>,
  setGameTime: (options: {
    hour?: number;
    day?: number;
    month?: number;
    year?: number;
  }) => apiPost("/panel-bridge/time", options),

  // World controls (v1.1.0)
  getWorldStats: () =>
    apiGet("/panel-bridge/world/stats") as Promise<{
      success: boolean;
      data: { serverName: string; map: string; zombiesInCell: number };
    }>,

  // Zombie count in currently loaded cells only (PanelBridge.lua's own
  // caveat -- not a world-wide total, Project Zomboid has no such number).
  getZombieCount: () =>
    apiGet("/panel-bridge/zombies/count") as Promise<{
      success: boolean;
      data: { zombieCount: number; note: string };
    }>,
  saveWorld: () => apiPost("/panel-bridge/world/save"),

  // Player controls (v1.1.0)
  getAllPlayerDetails: () =>
    apiGet("/panel-bridge/players") as Promise<{
      success: boolean;
      data: {
        players: Array<{
          username: string;
          displayName: string;
          x: number;
          y: number;
          z: number;
          accessLevel: string;
          isAlive: boolean;
          hunger?: number;
          thirst?: number;
          fatigue?: number;
          health?: number;
          isInfected?: boolean;
        }>;
      };
    }>,
  getPlayerDetails: (username: string) =>
    apiGet(`/panel-bridge/players/${encodeURIComponent(username)}`) as Promise<{
      success: boolean;
      data: {
        username?: string;
        displayName?: string;
        x?: number;
        y?: number;
        z?: number;
        accessLevel?: string;
        isAlive?: boolean;
        isAsleep?: boolean;
        isSneaking?: boolean;
        isRunning?: boolean;
        // Any field PZ's Stats/BodyDamage couldn't read is OMITTED (not
        // defaulted to 0) -- see PanelBridge.lua's statGet(). Never treat an
        // absent key here as "0", only as "unknown".
        stats?: {
          hunger?: number;
          thirst?: number;
          fatigue?: number;
          stress?: number;
          boredom?: number;
          unhappiness?: number;
          pain?: number;
          endurance?: number;
        };
        health?: {
          overallBodyHealth?: number;
          isInfected?: boolean;
          isBleeding?: boolean;
          health?: number;
          temperature?: number;
          wetness?: number;
        };
      };
      error?: string;
    }>,
  teleportPlayerBridge: (username: string, x: number, y: number, z?: number) =>
    apiPost(`/panel-bridge/players/${encodeURIComponent(username)}/teleport`, {
      x,
      y,
      z,
    }),

  // Kill player -- permanent character loss in a permadeath game, unlike
  // heal/godmode/invisible/noclip which route through the generic
  // sendCommand passthrough. There is no players.js-native equivalent (the
  // way teleport/give-item have one) for this action to shadow, so this
  // dedicated route (server/routes/panelBridge.js's POST
  // /players/:username/kill) is the one genuine live path, not a redundant
  // second one -- keep calling it here rather than switching to
  // sendCommand('killPlayer', ...) later.
  killPlayer: (username: string) =>
    apiPost<BridgeCommandResult<{ message: string; username: string; isDead: boolean; debug: string }>>(
      `/panel-bridge/players/${encodeURIComponent(username)}/kill`,
    ),

  // Server message (v1.1.0)
  sendServerMessage: (message: string, color?: string) =>
    apiPost("/panel-bridge/message", { message, color }),

  // Chat system (v1.4.0) - uses ChatServer API
  sendToServerChat: (message: string, alert?: boolean) =>
    apiPost("/panel-bridge/chat/alert", { message, alert: alert ?? false }),

  sendToAdminChat: (message: string) =>
    apiPost("/panel-bridge/chat/admin", { message }),

  sendToGeneralChat: (message: string, author?: string) =>
    apiPost("/panel-bridge/chat/general", {
      message,
      author: author?.trim() || "Server",
    }),

  // Whether the game's native ChatServer API is available right now, or
  // sendToServerChat/sendToAdminChat/sendToGeneralChat above are falling
  // back to player:Say/RCON. chatServerAvailable and rconFallback are
  // logical opposites of the same underlying fact (Lua reports both for
  // readability) -- only chatServerAvailable is surfaced client-side.
  // getChatInfo's other field (availableChats, a hardcoded description
  // list) is API documentation, not live state, and is not fetched here.
  getChatInfo: () =>
    apiGet("/panel-bridge/chat/info") as Promise<{
      success: boolean;
      data: { chatServerAvailable: boolean; rconFallback: boolean };
    }>,

  // Sandbox options (v1.1.0)
  getSandboxOptions: () => apiGet("/panel-bridge/sandbox"),

  // Get available commands
  getCommands: () =>
    apiGet("/panel-bridge/commands") as Promise<{
      commands: Array<{
        action: string;
        description: string;
        args: Record<string, string>;
      }>;
    }>,

  // Get mod installation info (includes suggested install path)
  getModPath: () =>
    apiGet("/panel-bridge/mod-path") as Promise<{
      modPath: string;
      exists: boolean;
      files: string[];
      suggestedInstallPath: string | null;
    }>,

  // Auto-install mod to server's Lua folder (optionally specify serverId)
  installModAuto: (serverId?: string | number) =>
    apiPost("/panel-bridge/install-mod-auto", { serverId }) as Promise<{
      success: boolean;
      message: string;
      path: string;
      serverName: string;
      error?: string;
    }>,

  // Install mod to server (manual path - Lua folder)
  installMod: (serverLuaPath: string) =>
    apiPost("/panel-bridge/install-mod", { serverLuaPath }),

  // =============================================
  // V1.2.0 SOUND/NOISE CONTROLS
  // =============================================

  // Play sound at world coordinates (attracts zombies)
  playWorldSound: (
    x: number,
    y: number,
    z?: number,
    radius?: number,
    volume?: number,
  ) =>
    apiPost("/panel-bridge/sound/world", {
      x,
      y,
      z: z ?? 0,
      radius: radius ?? 50,
      volume: volume ?? 100,
    }),

  // Play sound near a player's location
  playSoundNearPlayer: (username: string, radius?: number, volume?: number) =>
    apiPost("/panel-bridge/sound/near-player", {
      username,
      radius: radius ?? 50,
      volume: volume ?? 100,
    }),

  // Trigger a gunshot sound (high radius)
  triggerGunshotBridge: (options: {
    x?: number;
    y?: number;
    z?: number;
    username?: string;
  }) => apiPost("/panel-bridge/sound/gunshot", options),

  // Trigger an alarm sound
  triggerAlarmBridge: (options: {
    x?: number;
    y?: number;
    z?: number;
    username?: string;
  }) => apiPost("/panel-bridge/sound/alarm", options),

  // Create custom noise
  createNoise: (options: {
    x?: number;
    y?: number;
    z?: number;
    radius?: number;
    volume?: number;
    username?: string;
  }) => apiPost("/panel-bridge/sound/noise", options),

  // =============================================
  // AIRDROP SYSTEM
  // =============================================

  // Deploy an airdrop at world coordinates
  triggerAirdrop: (options: {
    x: number;
    y: number;
    preset?: "military" | "medical" | "food" | "building" | "weapons" | "tools";
    items?: Array<{ itemType: string; count?: number }>;
    announce?: boolean;
    attractZombies?: boolean;
    soundRadius?: number;
  }) => {
    if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) {
      return Promise.reject(new Error("Invalid coordinates"));
    }
    return apiPost("/panel-bridge/command", {
      action: "airdrop",
      args: { ...options, x: Math.round(options.x), y: Math.round(options.y) },
    });
  },

  // =============================================
  // V1.4.0 INFRASTRUCTURE (POWER/WATER) CONTROLS
  // =============================================

  // Get utilities (power/water) status
  getUtilitiesStatus: () =>
    apiGet("/panel-bridge/utilities/status") as Promise<{
      success: boolean;
      data: {
        hydroPowerOn: boolean;
        powerOn: boolean;
        waterOn: boolean;
        elecShut: string;
        waterShut: string;
        elecShutModifier: number;
        waterShutModifier: number;
        // The Lua replicates the game's own power-shutoff formula
        // (ISButtonPrompt.lua:421 -- elecShutModifier > -1 AND worldAgeDays
        // < elecShutModifier) to compute powerOn/waterOn above; these are
        // the inputs to that formula, so the UI can show WHY, not just the
        // on/off verdict.
        currentWorldDay: number;
        nightsSurvived: number;
      };
    }>,

  // Restore utilities (turn power/water back on)
  restoreUtilities: (power?: boolean, water?: boolean) =>
    apiPost("/panel-bridge/utilities/restore", {
      power: power !== false,
      water: water !== false,
    }) as Promise<UtilitiesChangeResult>,

  // Shut off utilities
  shutOffUtilities: (power?: boolean, water?: boolean) =>
    apiPost("/panel-bridge/utilities/shutoff", {
      power: power !== false,
      water: water !== false,
    }) as Promise<UtilitiesChangeResult>,

  // =============================================
  // V1.5.0 CHARACTER EXPORT/IMPORT
  // =============================================

  // Export character data (XP, perks, skills, traits)
  exportCharacter: (username: string): Promise<CharacterExportResponse> =>
    apiPost("/panel-bridge/character/export", { username }),

  // Import character data (apply XP, perks to player)
  importCharacter: (
    username: string,
    data: CharacterImportData,
  ): Promise<CharacterImportResponse> =>
    apiPost("/panel-bridge/character/import", { username, data }),

  // =============================================
  // ZOMBIE CONTROLS
  // =============================================

  // Spawn horde near a player (50-70 tiles away)
  spawnHordeNear: (username: string, count: number) =>
    apiPost<BridgeCommandResult>("/panel-bridge/zombies/spawn-near", { username, count }),

  // Spawn horde behind a player based on facing direction
  spawnHordeBehind: (username: string, count: number) =>
    apiPost<BridgeCommandResult>("/panel-bridge/zombies/spawn-behind", { username, count }),

  // Clear ALL zombies from loaded cells
  clearAllZombies: () => apiPost("/panel-bridge/zombies/clear-all"),
  clearZombiesNearPlayer: (username: string, radius?: number) =>
    apiPost("/panel-bridge/zombies/clear-near-player", { username, radius }),

  // =============================================
  // ITEM & VEHICLE CATALOG
  // =============================================

  // Get cached item catalog
  getCatalogItems: () =>
    apiGet("/panel-bridge/catalog/items") as Promise<{
      items: Array<{
        id: string;
        name: string;
        category: string;
        weight: number;
      }>;
      count: number;
      scannedAt: string | null;
    }>,

  // Get cached vehicle catalog
  getCatalogVehicles: () =>
    apiGet("/panel-bridge/catalog/vehicles") as Promise<{
      vehicles: Array<{
        id: string;
        name: string;
        mass: number;
        seats: number;
      }>;
      count: number;
      scannedAt: string | null;
    }>,

  // Trigger item catalog scan (requires running server)
  scanCatalogItems: () =>
    apiPost("/panel-bridge/catalog/scan-items") as Promise<{
      items: Array<{
        id: string;
        name: string;
        category: string;
        weight: number;
      }>;
      count: number;
      scannedAt: string;
    }>,

  // Trigger vehicle catalog scan (requires running server)
  scanCatalogVehicles: () =>
    apiPost("/panel-bridge/catalog/scan-vehicles") as Promise<{
      vehicles: Array<{
        id: string;
        name: string;
        mass: number;
        seats: number;
      }>;
      count: number;
      scannedAt: string;
    }>,
};

// =============================================
// BACKUP API
// =============================================
export interface BackupSettings {
  enabled: boolean;
  schedule: string;
  maxBackups: number;
  includeDb: boolean;
}

export interface BackupStatus extends BackupSettings {
  backupInProgress: boolean;
  restoreInProgress: boolean;
  lastBackup: {
    name: string;
    path: string;
    size: number;
    created: string;
  } | null;
  backupCount: number;
  savesPath: string | null;
  backupsPath: string | null;
  savesExists: boolean;
  // Only populated while `enabled` is true -- the newest schedule_history
  // entry for the backup job, independent of whether it actually produced a
  // file. `lastBackup` above stays silent about a scheduler that has been
  // failing every attempt; this is what lets the UI say so.
  lastScheduledBackupAttempt: {
    success: boolean;
    message: string | null;
    executedAt: string;
  } | null;
}

// backup.js/backupService.js's own shape (full .zip server backups --
// listBackups()/createBackup() in backupService.js) -- distinct from
// server-files/backups' config-file .bak backups above (ConfigBackupFile).
// See that interface's comment for why these have separate names now.
export interface ServerBackupArchive {
  name: string;
  path: string;
  size: number;
  created: string;
}

export interface BackupContentsInfo {
  description: string;
  includes: string[];
  location: string;
  note: string;
}

export const backupApi = {
  // Get backup status and settings
  getStatus: (): Promise<BackupStatus> => apiGet("/backup/status"),

  // Get info about what backups contain
  getInfo: (): Promise<BackupContentsInfo> => apiGet("/backup/info"),

  // Get list of backups
  listBackups: (): Promise<{ backups: ServerBackupArchive[] }> => apiGet("/backup/list"),

  getHistory: (serverId?: string | number) =>
    apiGet(`/backup/history${serverId != null ? `?serverId=${encodeURIComponent(serverId)}` : ""}`) as Promise<{
      records: BackupHistoryRecord[];
    }>,

  getSnapshot: (name: string): Promise<{ success: boolean; snapshot?: BackupSnapshot; message?: string }> =>
    apiGet(`/backup/${encodeURIComponent(name)}/snapshot`),

  // Update backup settings
  updateSettings: (
    settings: Partial<BackupSettings>,
  ): Promise<{ success: boolean; settings: BackupSettings }> =>
    apiPost("/backup/settings", settings),

  // Create a manual backup
  createBackup: (options?: {
    includeDb?: boolean;
  }): Promise<{
    success: boolean;
    backup?: ServerBackupArchive;
    duration?: number;
    message?: string;
  }> => apiPost("/backup/create", options || {}),

  // Delete a backup
  deleteBackup: (
    name: string,
  ): Promise<{ success: boolean; message?: string }> =>
    fetchWithRetry(`${API_BASE}/backup/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }).then((response) =>
      handleResponse<{ success: boolean; message?: string }>(response),
    ),

  // Restore a backup
  restoreBackup: (
    name: string,
    options?: { createPreRestoreBackup?: boolean },
  ): Promise<{
    success: boolean;
    message?: string;
    duration?: number;
  }> => apiPost(`/backup/restore/${encodeURIComponent(name)}`, options || {}),

  // Delete backups older than X days
  deleteOlderThan: (
    days: number,
  ): Promise<{
    success: boolean;
    deleted?: number;
    failed?: number;
    deletedNames?: string[];
    message?: string;
  }> => apiPost("/backup/delete-older-than", { days }),

  // Get download URL for a backup (use downloadBackup for authenticated downloads)
  getDownloadUrl: (name: string): string =>
    `${API_BASE}/backup/download/${encodeURIComponent(name)}`,

  // Upload a .zip from the user's machine into the backups folder.
  // Streams the raw bytes to /backup/upload with the original filename
  // sent as a header so it can be sanitized server-side. The stored file
  // ends up prefixed with "uploaded-" and shows up in the regular list.
  uploadBackup: async (
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<{
    success: boolean;
    name: string;
    size: number;
    message: string;
  }> => {
    // Raw XHR (not fetchWithRetry) because it needs upload progress events,
    // which the fetch API cannot report. That means it does NOT get
    // fetchWithRetry's automatic "refresh once on TOKEN_EXPIRED, then
    // replay" behaviour for free -- every other mutating call in this file
    // gets that for free through handleResponse/fetchWithRetry, so this one
    // reimplements it by hand rather than silently doing without: a large
    // backup upload can easily outlast the 15m access token TTL (see
    // server/services/auth.js's own comment on why 15m), and a user
    // returning after being idle that long would otherwise see a raw 401
    // instead of a transparent refresh-and-retry like everywhere else.
    const sendOnce = (
      token: string | null,
    ): Promise<{ status: number; payload: any }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE}/backup/upload`, true);
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.setRequestHeader("Content-Type", "application/zip");
        xhr.setRequestHeader("X-Backup-Filename", file.name);
        if (onProgress) {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable)
              onProgress(Math.round((e.loaded / e.total) * 100));
          };
        }
        xhr.onload = () => {
          let payload: any = null;
          try {
            payload = JSON.parse(xhr.responseText);
          } catch {
            /* non-JSON */
          }
          resolve({ status: xhr.status, payload });
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.onabort = () => reject(new Error("Upload aborted"));
        xhr.send(file);
      });

    let { status, payload } = await sendOnce(getAuthToken());
    if (status === 401 && payload?.code === "TOKEN_EXPIRED") {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        ({ status, payload } = await sendOnce(getAuthToken()));
      }
    }

    if (status >= 200 && status < 300 && payload?.success) {
      return payload;
    }
    throw new Error(payload?.error || `Upload failed (HTTP ${status})`);
  },

  // Download a backup file with authentication
  downloadBackup: async (name: string): Promise<void> => {
    const response = await fetchWithRetry(
      `${API_BASE}/backup/download/${encodeURIComponent(name)}`,
    );
    if (!response.ok) {
      const payload = await parseResponseBody(response);
      throw buildResponseError(response, payload);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};

// Debug API
export const debugApi = {
  getRam: (): Promise<{
    totalGB: number;
    freeGB: number;
    recommendedMin: number;
    recommendedMax: number;
  }> => apiGet("/debug/ram"),
  getPerformanceHistory: (
    limit: number = 30,
  ): Promise<{
    history: Array<{
      timestamp: string;
      playerCount: number;
      memoryUsed: number;
      pzMemUsed?: number;
      cpuUsage?: number;
      hostMemUsed?: number;
      hostMemTotal?: number;
    }>;
  }> => apiGet(`/debug/performance-history?limit=${limit}`),
};

// Auth API
export const authApi = {
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean; message?: string }> =>
    apiPost("/auth/change-password", { currentPassword, newPassword }),

  getRecoveryCodes: (): Promise<{
    configured: boolean;
    remaining: number;
    total: number;
    createdAt: string | null;
  }> => apiGet("/auth/recovery-codes"),

  generateRecoveryCodes: (): Promise<{
    success: boolean;
    codes: string[];
    createdAt: string;
  }> => apiPost("/auth/recovery-codes", {}),

  regenerateJwtSecret: (): Promise<{ success: boolean; message?: string }> =>
    apiPost("/auth/regenerate-jwt-secret", {}),
};

// Servers detection API helpers (added to serversApi)
export const serversDetectApi = {
  detect: (params: {
    dataPath: string;
    installPath?: string;
  }): Promise<Record<string, unknown>> =>
    apiPost("/servers/detect", params) as Promise<Record<string, unknown>>,
  autoScan: (params: {
    scanPath: string;
    maxDepth?: number;
  }): Promise<Record<string, unknown>> =>
    apiPost("/servers/auto-scan", params) as Promise<Record<string, unknown>>,
  // confirm: true is hardcoded here, not threaded through as a parameter --
  // same shape as serverApi.wipe below: every caller of this function is
  // already behind its own confirmation dialog before it's ever invoked, so
  // there's no real call site where the confirmation isn't already implied.
  deleteFiles: (path: string): Promise<unknown> =>
    apiPost("/server/delete-files", { path, confirm: true }),
};

// Update Checker API
export interface UpdateStatus {
  updateAvailable: boolean;
  installed: {
    buildId: string;
    branch: string;
    lastUpdated: string | null;
  };
  latest: {
    buildId: string;
    branch: string;
    timeUpdated: string | null;
    description: string | null;
  };
  lastCheck: string;
}

// 2026-08-26: persisted server-side (not a live-only socket event) so any
// page can read it cold, long after the unattended run finished -- see
// server/services/updateChecker.js's own comment on _recordAutoUpdateResult
// for why. `reason` is a stable key (never a raw message), translated
// client-side the same way every other coded failure in this app is.
export interface AutoUpdateResult {
  status: "success" | "failed";
  at: string;
  dismissed: boolean;
  // failure-only
  reason?: string;
  params?: Record<string, string | number> | null;
  phase?: "not-started" | "before-stop" | "updating";
  serverUp?: boolean | null;
  // success-only
  appliedVersion?: string | null;
}

export interface UpdateCheckerStatus {
  updateAvailable: UpdateStatus | null;
  gameVersion: string | null;
  lastCheck: string | null;
  intervalMinutes: number;
  isChecking: boolean;
  lastAutoUpdateResult: AutoUpdateResult | null;
}

export interface PanelUpdateAsset {
  name: string;
  size?: number;
  downloadUrl?: string;
}

export interface PanelUpdateStatus {
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  isChecking: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  lastCheck: string | null;
  lastError: string | null;
  updateMode?: "binary" | "docker";
  stagedUpdate: { version: string | null; path: string } | null;
  lastApplyResult: PanelUpdateApplyResult | null;
}

export interface PanelUpdateApplyResult {
  status: "success" | "failed";
  appliedVersion?: string;
  pendingVersion?: string;
  currentVersion?: string;
  at: string;
  stagedStillPresent?: boolean;
  helperLog?: string | null;
  likelyCause?:
    | "helper_blocked"
    | "av_quarantine"
    | "rename_locked"
    | "permission"
    | "no_helper_log"
    | "rollback_failed"
    | "unknown";
  // Only meaningful when likelyCause is "rollback_failed" -- see
  // isRollbackRetryLikely()'s doc comment in panelUpdateChecker.js. Absent
  // for every other cause (this question doesn't apply to them), not a
  // stale false.
  rollbackRetryLikely?: boolean;
  canRetryApply?: boolean;
  panelFolder?: string;
}

export interface PanelUpdateMessage {
  key: string;
  params?: Record<string, string | number>;
}

export interface PanelUpdatePreflight {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  blockerDetails?: PanelUpdateMessage[];
  warningDetails?: PanelUpdateMessage[];
  info: {
    isPackaged?: boolean;
    platform?: string;
    updateMode?: "binary" | "docker";
    dockerUpdater?: boolean;
    alreadyCurrent?: boolean;
    exePath?: string;
    exeDir?: string;
    asset?: { name: string; size: number };
    writable?: boolean;
    freeBytes?: number | null;
    oneDrive?: boolean;
    syncSuspect?: boolean;
    programFiles?: boolean;
    stagedUpdate?: { version: string | null; path: string };
    oldPath?: string;
    temporaryDirectory?: string;
    applyLogPath?: string;
    restartAssessment?: RestartAssessment;
  };
}

export interface RestartAssessment {
  gameServers: "preserved" | "at-risk" | "unknown";
  requiresConfirmation: boolean;
  reason: string;
}

export interface PanelUpdateActionResult {
  success: boolean;
  message?: string;
  error?: string;
  preflight?: PanelUpdatePreflight;
}

export const updateApi = {
  // Check for updates (force = true to refresh from Steam)
  check: (
    force: boolean = false,
  ): Promise<UpdateStatus | UpdateCheckerStatus> =>
    apiGet(`/server/update-check?force=${force}`),

  // Get current status without checking
  getStatus: (): Promise<UpdateCheckerStatus> =>
    apiGet("/server/update-check/status"),

  // Set check interval in minutes
  setInterval: (
    minutes: number,
  ): Promise<{ success: boolean; intervalMinutes: number }> =>
    apiPost("/server/update-check/interval", { minutes }),

  // Acknowledge the last automatic-update result -- shared server-side
  // state, not per-browser, so it stops showing for every admin/device at
  // once (see the server route's own comment).
  dismissAutoUpdateResult: (): Promise<UpdateCheckerStatus> =>
    apiPost("/server/update-check/auto-update-result/dismiss"),
};

export const mapApi = {
  // The B42 map build the backend resolved: its geometry, which the client
  // needs to address tiles at all, plus enough to build direct-to-upstream
  // tile URLs and load them from the browser instead of through this
  // server's proxy — see the /api/map/resolve route for why.
  resolve: (): Promise<{
    root: string;
    b42Dir: string;
    b41Path: string;
    tileSize: number;
    width: number;
    height: number;
    maxLevel: number;
    // Deepest level actually worth requesting -- see mapProxy.js's
    // discoverRenderedMaxLevel. maxLevel alone is the theoretical full DZI
    // pyramid depth, not evidence the tile host rendered that deep.
    renderedMaxLevel: number;
    // Isometric projection origin from the build's own map_info.json.
    // Absent if map.projectzomboid.com couldn't be reached.
    x0?: number;
    y0?: number;
    sqr?: number;
    scale?: number;
  }> => apiGet("/map/resolve"),
  vehicles: (): Promise<{ vehicles: Array<{ id: number; x: number; y: number }> }> =>
    apiGet("/map/vehicles"),
};

export const panelUpdateApi = {
  check: (): Promise<PanelUpdateStatus> => apiGet("/panel/update-check"),
  getStatus: (): Promise<PanelUpdateStatus> => apiGet("/panel/update-status"),
  preflight: (): Promise<PanelUpdatePreflight> =>
    apiGet("/panel/update-preflight"),
  download: (confirm: boolean = false): Promise<PanelUpdateActionResult> =>
    apiPost("/panel/update-download", { confirm }),
  getApplyLog: (): Promise<{ log: string | null; logPath: string }> =>
    apiGet("/panel/update-apply-log"),
};

// Disk-space + write circuit-breaker health (P0 data-loss surfacing)
export interface DiskSpaceStatus {
  path: string | null;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
  warning: boolean;
  critical: boolean;
}

export interface DiskSpaceReport {
  saveVolume: DiskSpaceStatus | null;
  panelData: DiskSpaceStatus;
}

export interface CircuitBreakerStatus {
  open: boolean;
  lastError: string | null;
  failCount: number;
  cooldownEndsAt: string | null;
}

export interface StorageHealth {
  diskSpace: DiskSpaceReport;
  circuitBreaker: CircuitBreakerStatus;
}

export interface RuntimeInfo {
  platform: string;
  family: "windows" | "posix" | "unknown";
  pathSeparator: string;
  temporaryDirectory: string;
  serviceManager: "systemd" | "openrc" | "container" | "none" | "unknown";
  restartAssessment: RestartAssessment;
}

export const systemApi = {
  getDiskSpace: (): Promise<DiskSpaceReport> => apiGet("/system/disk-space"),
  getStorageHealth: (): Promise<StorageHealth> =>
    apiGet("/system/storage-health"),
  // UI copy can safely remain neutral when this optional discovery request
  // fails; avoid delaying unrelated screens with transport backoff.
  getRuntime: (): Promise<RuntimeInfo> => apiGet("/system/runtime", undefined, 0),
};

// ============================================
// Rights matrix -- roles & capabilities (server/routes/permissions.js).
// Capability `key` values are load-bearing wire values shared with the
// server's own CAPABILITIES catalogue (server/services/permissions.js) --
// render them, never rename them client-side.
// ============================================

export interface CapabilityInfo {
  key: string;
  label: string;
  description: string;
}

export interface CapabilityGroup {
  group: string;
  capabilities: CapabilityInfo[];
}

export interface RoleInfo {
  id: string;
  name: string;
  capabilities: string[];
  isSeeded: boolean;
  createdAt: string;
  updatedAt?: string;
  memberCount: number;
}

export const permissionsApi = {
  getCapabilities: (): Promise<{ groups: CapabilityGroup[] }> =>
    apiGet("/permissions/capabilities"),

  getRoles: (): Promise<{ roles: RoleInfo[] }> => apiGet("/permissions/roles"),

  createRole: (data: {
    name: string;
    capabilities: string[];
  }): Promise<{ success: boolean; role: RoleInfo }> =>
    apiPost("/permissions/roles", data),

  updateRole: (
    id: string,
    data: {
      name?: string;
      capabilities?: string[];
      confirmSelfCapabilityLoss?: boolean;
    },
  ): Promise<{ success: boolean; role: RoleInfo }> =>
    apiPut(`/permissions/roles/${encodeURIComponent(id)}`, data),

  deleteRole: (
    id: string,
    reassignTo?: string,
  ): Promise<{
    success: boolean;
    deleted: boolean;
    reassigned: number;
    reassignedTo: string | null;
  }> =>
    apiDelete(
      `/permissions/roles/${encodeURIComponent(id)}${
        reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : ""
      }`,
    ),
};

// User account list + role assignment (server/routes/auth.js). Kept as its
// own export rather than folded into authApi in place -- this whole block
// was appended at end-of-file so it can't collide with concurrent edits
// elsewhere in authApi.
export interface ManagedUserAccount {
  id: string;
  username: string;
  role: string;
  roleId: string | null;
  createdAt: string;
  lastLogin: string | null;
}

export const usersApi = {
  list: (): Promise<{ users: ManagedUserAccount[] }> => apiGet("/auth/users"),

  create: (data: {
    username: string;
    password: string;
    role: "admin" | "technician" | "moderator";
  }): Promise<{ success: boolean; user: ManagedUserAccount }> =>
    apiPost("/auth/users", data),

  assignRole: (
    userId: string,
    roleId: string,
  ): Promise<{ success: boolean; user: ManagedUserAccount }> =>
    apiFetch(`/auth/users/${encodeURIComponent(userId)}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleId }),
    }).then((response) => handleResponse(response)),

  remove: (
    userId: string,
  ): Promise<{ success: boolean; user: { id: string; username: string } }> =>
    apiDelete(`/auth/users/${encodeURIComponent(userId)}`),
};

// OIDC settings (server/routes/oidc.js "Settings" section, gated on
// panel.settings) -- built by Kevin to the shape agreed in advance. Every
// field here mirrors the server's own publicSettingsShape() exactly.
export interface OidcSettingsFields {
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  providerName: string;
  allowInsecureHttp: boolean;
}

export interface OidcSettings extends OidcSettingsFields {
  clientSecretConfigured: boolean;
  configured: boolean;
}

export interface OidcSettingsWithEnv extends OidcSettings {
  envOverrides: Record<keyof OidcSettingsFields | "clientSecret", boolean>;
  suggestedRedirectUri: string;
}

export type OidcSettingsUpdate = Partial<OidcSettingsFields> & { clientSecret?: string };

// The resolved endpoints and advertised scopes from a successful test --
// mirrors server/services/oidc.js's describeDiscoveredMetadata() exactly.
export interface OidcDiscoveredMetadata {
  issuer: string;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  scopesSupported: string[];
}

export const oidcSettingsApi = {
  get: (): Promise<OidcSettingsWithEnv> => apiGet("/auth/oidc/settings"),

  update: (updates: OidcSettingsUpdate): Promise<{ success: boolean } & OidcSettings> =>
    apiFetch("/auth/oidc/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }).then((response) => handleResponse(response)),

  // Resolves ONLY on a confirmed-good credential check (server-side
  // `success: true`) -- handleResponse() throws on `success: false`, so
  // both "confirmed rejected" and "could not determine" arrive as a thrown
  // ApiError instead, distinguished by its `.code` ("credentials_rejected"
  // vs "undetermined"). See OidcSettings.tsx's handleTestConnection.
  testConnection: (
    updates: OidcSettingsUpdate,
  ): Promise<{ success: true; metadata: OidcDiscoveredMetadata }> =>
    apiPost("/auth/oidc/test-connection", updates),
};
