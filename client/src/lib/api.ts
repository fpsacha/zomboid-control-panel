import { reportClientWarning } from "./client-errors";
import { clearAccessToken, forgetSessionUser, getAccessToken, getSessionUserId, setAccessToken } from "./authToken";
import { toast } from "@/components/ui/use-toast";
import i18n from "@/i18n";
import { hostTimeToLocal } from "./hostClock";
import { rememberTrustedDeviceFrom, rememberTrustedDeviceToken } from "./trustedDevice";
import { decodeJwtUserId } from "./jwt";
import type { LeaderboardDiagnostics } from "./leaderboardDiagnostics";

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
  /**
   * Seconds the server said to wait before retrying (parsed from the
   * response's `Retry-After` header), when the failing response carried
   * one. Every rate limiter in this app (express-rate-limit with
   * standardHeaders: true) already sends this on a 429 -- undefined here
   * previously meant the client discarded it, not that the server never
   * sent it, so "try again later" never said when.
   */
  retryAfterSeconds?: number;
  /**
   * True when `message` is this client's own stock English text for `status`
   * (the failing response carried no message of its own), so
   * getUserErrorMessage() may swap in the translated equivalent. A message
   * the server wrote is never marked: it can be more specific than any
   * stock text, and it is shown as sent.
   */
  isStatusFallback: boolean;
  /**
   * `message` as it was before the English " Try again in N seconds."
   * suffix was appended (only set when one was), so getUserErrorMessage()
   * can put a translated suffix after it instead.
   */
  messageBeforeRetryAfter?: string;

  constructor(
    message: string,
    options?: {
      status?: number;
      code?: string;
      isRetryable?: boolean;
      isTimeout?: boolean;
      isNetworkError?: boolean;
      data?: unknown;
      retryAfterSeconds?: number;
      isStatusFallback?: boolean;
      messageBeforeRetryAfter?: string;
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
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.isStatusFallback = Boolean(options?.isStatusFallback);
    this.messageBeforeRetryAfter = options?.messageBeforeRetryAfter;
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

// The user a refresh hands back (server/routes/auth.js POST /refresh).
export interface SessionUser {
  id: string;
  username: string;
  role: string;
  capabilities: string[] | null;
}

export type RefreshOutcome = { ok: true; user: SessionUser | null } | { ok: false };

type RefreshAnswer = { status: number; payload: unknown }; // status 0: never reached the panel

// Handle 401 responses — try to refresh the token once
let refreshPromise: Promise<RefreshOutcome> | null = null;
// The POST itself, apart from refreshPromise, so a sign-out can wait for its
// Set-Cookie to land without waiting on the refresh's own wait for that
// sign-out.
let refreshRequest: Promise<RefreshAnswer> | null = null;

// SECURITY (2026-10-08, auth audit #14/#16): bumped when this tab signs out
// or hears that another tab did. A refresh that started under an older
// generation must not set its token, or it would bring the signed-out
// session back in this tab.
let authGeneration = 0;
let signOutPromise: Promise<boolean> | null = null;
// When this tab last had the refresh cookie rotated (see
// signedOutInAnotherTab).
let lastRotatedAt = Number.NEGATIVE_INFINITY;

export function bumpAuthGeneration(): void {
  authGeneration += 1;
}

const AUTH_LOCK_NAME = "pz-auth-refresh";
// REFRESH_RACE retries: up to 4, each after a random 150-900 ms, all well
// inside the panel's 30 s grace. A fixed delay sent the losing tabs back
// together, so with 3 or more tabs one lost again and ran out of retries.
const REFRESH_RACE_RETRIES = 4;
const REFRESH_RACE_RETRY_MIN_MS = 150;
const REFRESH_RACE_RETRY_SPREAD_MS = 750;
const AUTH_REQUEST_TIMEOUT_MS = 15000;
// A refresh is never cut at 15 s: the panel still rotates the cookie when
// the answer comes late, and a browser that never stored that Set-Cookie
// sends the replaced one next, which the panel takes for a stolen token
// and signs the account out everywhere. Sign-out keeps the 15 s limit (an
// aborted one is reported as failed).
const REFRESH_REQUEST_TIMEOUT_MS = 120000;
const RECENT_ROTATION_MS = 5000;

// Every tab shares one refresh cookie and the server rotates it on each use,
// so two tabs refreshing at once used to sign one of them out (audit #19).
// navigator.locks (HTTPS and localhost only) runs them one after another,
// each sending the cookie the last one set; on plain HTTP the server's
// REFRESH_RACE answer covers it instead (refreshWithRaceRetry below).
async function withAuthLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== "function") return task();
  try {
    return await locks.request(AUTH_LOCK_NAME, () => task());
  } catch {
    // The lock manager refused (a page being torn down). The tasks here
    // never throw themselves, so this is the lock failing: run unserialized
    // rather than leave a caller (the socket's auth callback) waiting.
    return task();
  }
}

function payloadCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function postAuth(path: string, timeoutMs = AUTH_REQUEST_TIMEOUT_MS): Promise<RefreshAnswer> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // Not JSON (a proxy's error page): the status alone decides.
    }
    return { status: res.status, payload };
  } catch {
    return { status: 0, payload: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function refreshWithRaceRetry(): Promise<RefreshAnswer> {
  const generation = authGeneration;
  // A sign-out started meanwhile stops the retries: it is waiting for this
  // refresh, and has no use for its answer.
  const signingOut = () => generation !== authGeneration;
  let answer = await postAuth("/api/auth/refresh", REFRESH_REQUEST_TIMEOUT_MS);
  for (let retry = 0; retry < REFRESH_RACE_RETRIES; retry += 1) {
    if (answer.status !== 401 || payloadCode(answer.payload) !== "REFRESH_RACE" || signingOut()) break;
    // Another tab rotated the cookie a moment ago; by now this browser
    // holds the new one, so another try normally succeeds.
    const delay = REFRESH_RACE_RETRY_MIN_MS + Math.random() * REFRESH_RACE_RETRY_SPREAD_MS;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (signingOut()) break;
    answer = await postAuth("/api/auth/refresh", REFRESH_REQUEST_TIMEOUT_MS);
  }
  return answer;
}

async function runRefresh(): Promise<RefreshOutcome> {
  // A sign-out in progress decides first: once it lands there is no session
  // left to refresh.
  if (signOutPromise && (await signOutPromise)) return { ok: false };

  const generation = authGeneration;
  // The token may already be gone (a failed refresh dropped it): the account
  // this tab showed still decides (audit #15, review 1-02).
  const previousUserId = decodeJwtUserId(getAccessToken()) ?? getSessionUserId();
  const request = withAuthLock(refreshWithRaceRetry);
  refreshRequest = request;
  const answer = await request;
  if (refreshRequest === request) refreshRequest = null;
  const data = answer.payload as {
    accessToken?: unknown;
    user?: SessionUser | null;
    deviceToken?: unknown;
  } | null;
  // Set only by the panel's own answer, which also set a new refresh cookie.
  const newToken = answer.status >= 200 && answer.status < 300 && typeof data?.accessToken === "string"
    ? data.accessToken
    : null;
  if (newToken) lastRotatedAt = Date.now();

  if (generation !== authGeneration) {
    // Signed out while this was in flight. Only a sign-out from this tab
    // that failed leaves the session, and so this answer, standing.
    const signOut = signOutPromise;
    if (!signOut) {
      // Another tab signed out. Without navigator.locks (plain HTTP) this
      // refresh's Set-Cookie can land after that tab's clear and leave a
      // working 30-day cookie: end the session it put back. With no cookie
      // left, the panel answers 200 and does nothing.
      if (newToken) void withAuthLock(() => postAuth("/api/auth/logout"));
      return { ok: false };
    }
    if (await signOut) return { ok: false };
  }

  if (newToken) {
    const userId = typeof data?.user?.id === "string" ? data.user.id : null;
    if (previousUserId && userId && userId !== previousUserId) {
      // SECURITY (2026-10-08, audit #15): the shared cookie now belongs to
      // another account (someone signed in as them in another tab). Going on
      // as them while this tab still shows the old name would run, and log,
      // every action under the wrong account. Reload to show who it is.
      clearAccessToken();
      window.location.reload();
      return { ok: false };
    }
    setAccessToken(newToken);
    // Also where a browser back from SSO first gets one (see
    // lib/trustedDevice.ts).
    rememberTrustedDeviceToken(data?.user?.username, data?.deviceToken);
    return { ok: true, user: data?.user ?? null };
  }

  // Only the panel refusing the cookie ends the session (audit #20). A
  // network error, 429 or 5xx, or a REFRESH_RACE that outlasted its retry,
  // left the cookie as it was, so the token stays for the next try.
  if (answer.status === 401 && payloadCode(answer.payload) !== "REFRESH_RACE") {
    clearAccessToken();
  }
  return { ok: false };
}

// One refresh at a time per tab; every caller (checkAuth, the 401 replay
// below, the socket auth provider, the upload replays) shares it.
export function refreshSession(): Promise<RefreshOutcome> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = runRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function tryRefreshToken(): Promise<boolean> {
  return (await refreshSession()).ok;
}

/**
 * Ends this browser's session on the panel. Resolves true only when the
 * panel confirmed it; false means the refresh cookie may still work, so the
 * caller must not show this tab as signed out (audit #14: on a shared PC the
 * next person to open the panel would be signed in as this user).
 */
export function endServerSession(): Promise<boolean> {
  if (signOutPromise) return signOutPromise;
  bumpAuthGeneration();
  const pendingRefresh = refreshRequest;
  const attempt = (async () => {
    try {
      // A refresh already on the wire lands first: its Set-Cookie arriving
      // after the logout's clear would leave a live session in the cookie
      // jar. The lock does the same for another tab's refresh.
      await pendingRefresh;
      const answer = await withAuthLock(() => postAuth("/api/auth/logout"));
      // Only the panel's own { success: true } confirms the cookie was
      // cleared: a proxy's maintenance page or a captive portal can answer
      // 200 too, without the panel ever seeing the sign-out.
      return answer.status >= 200 && answer.status < 300
        && (answer.payload as { success?: unknown } | null)?.success === true;
    } catch {
      return false;
    }
  })();
  signOutPromise = attempt;
  void attempt.finally(() => {
    if (signOutPromise === attempt) signOutPromise = null;
  });
  return attempt;
}

/**
 * Another tab of this browser signed out (AuthContext hears it on the
 * pz-auth channel). Drops this tab's session and any refresh it has in
 * flight. If this tab's refresh rotated the cookie a moment ago, its
 * Set-Cookie may have landed after the other tab's clear (plain HTTP has no
 * navigator.locks to order them), so the session it put back is ended too.
 * Only then: a tab that was frozen and hears this late must not end a newer
 * sign-in.
 */
export function signedOutInAnotherTab(): void {
  bumpAuthGeneration();
  clearAccessToken();
  forgetSessionUser();
  if (Date.now() - lastRotatedAt < RECENT_ROTATION_MS) {
    void withAuthLock(() => postAuth("/api/auth/logout"));
  }
}

// The 401s worth one refresh and replay: an expired token, or a request
// sent with no token at all (one dropped after a failed refresh) that the
// panel answered AUTH_REQUIRED (audit #20). When that refresh fails, every
// caller reloads: checkAuth then shows the sign-in screen, or signs back in
// if the failure was passing, instead of leaving a tab that looks signed in
// while every call fails.
export function isRefreshableAuthFailure(status: number, code: unknown, sentToken: boolean): boolean {
  if (status !== 401) return false;
  return code === "TOKEN_EXPIRED" || (!sentToken && code === "AUTH_REQUIRED");
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
    default:
      // Every 5xx reads the same: a proxy's 502/504, Cloudflare's 52x and a
      // plain 500 with no body are all "the panel is not answering right
      // now". errorMessage.ts maps each text here to a translated errors.json
      // key (HTTP_STATUS_<n>, HTTP_5XX, HTTP_4XX); keep the two in step.
      return status >= 500
        ? "The server is temporarily unavailable. Try again shortly."
        : `Request failed with status ${status}.`;
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

// `Retry-After` is either delta-seconds (the shape express-rate-limit's
// standardHeaders mode sends) or an HTTP-date (the other RFC 7231-permitted
// form, used by some infra like nginx/Cloudflare in front of the panel).
// Returns null when absent or unparseable rather than 0 -- 0 would read as
// "retry immediately," a false claim we have no basis for making.
function parseRetryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const asDeltaSeconds = Number(header);
  if (Number.isFinite(asDeltaSeconds) && asDeltaSeconds >= 0) {
    return Math.round(asDeltaSeconds);
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  }
  return null;
}

function formatRetryAfter(seconds: number): string {
  if (seconds <= 0) return "a moment";
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// Exported for its own regression test only (Retry-After parsing/formatting)
// -- not part of this module's public surface for callers, who should keep
// going through apiFetch/the *Api objects.
export function buildResponseError(response: Response, payload?: unknown): ApiError {
  const payloadMessage =
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
          : null;
  const isStatusFallback = payloadMessage === null;
  const messageFromPayload = payloadMessage ?? getStatusMessage(response.status);

  // Every rate limiter in this app sends Retry-After on a 429
  // (express-rate-limit, standardHeaders: true) -- previously discarded
  // here, so "too many requests, try again later" never said how long
  // later. The server-provided message (messageFromPayload, above) already
  // says WHAT happened; this appends WHEN, rather than replacing either
  // that message or getStatusMessage's own generic fallback -- both keep
  // meaning what they already meant, just completed.
  const retryAfterSeconds = parseRetryAfterSeconds(response);
  const message =
    retryAfterSeconds !== null
      ? `${messageFromPayload} Try again in ${formatRetryAfter(retryAfterSeconds)}.`
      : messageFromPayload;

  // Prefer the server-provided `code` over a generic HTTP_<status> tag so
  // callers can switch on application-level codes like `server_running`.
  const codeFromPayload =
    payload &&
    typeof payload === "object" &&
    "code" in payload &&
    typeof (payload as { code: unknown }).code === "string"
      ? (payload as { code: string }).code
      : `HTTP_${response.status}`;

  return new ApiError(message, {
    status: response.status,
    code: codeFromPayload,
    isRetryable:
      response.status >= 500 ||
      response.status === 429 ||
      response.status === 408,
    data: payload,
    retryAfterSeconds: retryAfterSeconds ?? undefined,
    isStatusFallback,
    messageBeforeRetryAfter: retryAfterSeconds !== null ? messageFromPayload : undefined,
  });
}

async function responseCode(response: Response): Promise<string | undefined> {
  try {
    return payloadCode(await response.clone().json());
  } catch {
    return undefined;
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
        const sentToken = getAuthToken() !== null;
        const response = await fetch(url, {
          ...withAuth(options),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // Authentication replay is separate from transport retries. It is
        // allowed once, and only when the server explicitly says the access
        // token expired, or that it got none (isRefreshableAuthFailure).
        // This remains safe for mutations because the server rejected the
        // original request before performing it.
        if (
          response.status === 401 &&
          !authenticationReplayUsed &&
          !url.includes("/api/auth/") &&
          isRefreshableAuthFailure(401, await responseCode(response), sentToken)
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

// `retries` caps the transport retries of a GET (fetchWithRetry's default
// otherwise); 0 for a caller that polls or offers its own Retry.
export function apiFetch(endpoint: string, options?: RequestInit & { timeout?: number; retries?: number }) {
  const { retries, ...init } = options ?? {};
  return fetchWithRetry(`${API_BASE}${endpoint}`, init, retries);
}

// Exported so AuthContext.tsx/Login.tsx's pre-auth calls (login, setup,
// password reset -- routes with no token yet, so every other *Api object's
// own convenience wrapper doesn't apply) can go through the same envelope
// (buildResponseError's classification, Retry-After parsing, the fetchWithRetry
// timeout/replay logic) instead of hand-rolling ApiError construction after a
// raw fetch(), as they did before 2026-09-08's auth-transport-parity fix.
export async function handleResponse<T = any>(response: Response): Promise<T> {
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
  options?: { signal?: AbortSignal; timeout?: number },
): Promise<T> {
  return fetchWithRetry(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: options?.signal,
    timeout: options?.timeout,
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

export interface PortRange {
  start: number;
  end: number;
}

// GET /server/setup-plan
export interface UsedServerPorts {
  id: string;
  name: string;
  serverName: string;
  installPath: string;
  // The profile's data folder, or the game's default when it names none.
  dataPath: string | null;
  gamePort: number | null;
  udpPort: number | null;
  rconPort: number | null;
}

// PZ_SAVE_PATH: the data folder of an install that names none, for the
// PZ_SERVER_PATH install only, or for every install when installPath is null.
export interface EnvironmentDataPath {
  installPath: string | null;
  dataPath: string;
}

export interface ServerSetupPlan {
  usedPorts: UsedServerPorts[];
  suggestedPorts: {
    gamePort: number | null;
    rconPort: number | null;
    withinPublishedRange: boolean | null;
  };
  allInOne: {
    serversRoot: string | null;
    publishedGamePorts: PortRange | null;
  } | null;
  // Outside the all-in-one image: the active install's parent folder, where
  // another server's folders go, in the host's own path shape.
  hostLayout: {
    serversRoot: string | null;
    separator: "/" | "\\";
  } | null;
  // The names already in whichever of the two roots applies, empty without
  // one.
  serversRootEntries: string[];
  environmentDataPath: EnvironmentDataPath | null;
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
  // startTime arrives on the host's clock; see hostTimeToLocal().
  getStatus: (options?: { retries?: number }) =>
    apiGet("/server/status", undefined, options?.retries).then((status) =>
      status && typeof status === "object"
        ? { ...status, startTime: hostTimeToLocal(status.startTime, status.serverTime) }
        : status,
    ),
  getNetworkInterfaces: (): Promise<{
    interfaces: { name: string; address: string }[];
  }> => apiGet("/server/network-interfaces"),
  // ignoreUnknownState: the operator confirmed "start anyway" after a
  // SERVER_START_STATE_UNKNOWN refusal (process detection keeps failing).
  start: (options?: { ignoreUnknownState?: boolean }) =>
    apiPost("/server/start", options?.ignoreUnknownState ? { ignoreUnknownState: true } : undefined),
  // Unlike /server/start and /server/restart (both explicitly "return
  // immediately, progress via socket/poll" -- see their own server-side
  // comments), POST /server/stop and /server/force-stop hold the request
  // open for the full graceful-shutdown chain: RCON save (rcon.js's own
  // commandTimeout is 10s), then either RCON quit (another ~10s) or, for a
  // Docker-managed server, dockerClient.js's lifecycleTimeoutMs -- the
  // container's configured StopTimeout (10s default, but operator-set,
  // uncapped here) plus a 30s grace period before Docker escalates to
  // SIGKILL. A Docker-managed stop can legitimately take 40s+ even on a
  // default config. Same STALL_MS-class timeout as the rest of this file's
  // "waits on the game server" endpoints, not a blanket bump -- /start and
  // /restart stay on the generic default because they're genuinely fast.
  stop: () => apiPost("/server/stop", undefined, { timeout: 3 * 60 * 1000 }),
  forceStop: () =>
    apiPost("/server/force-stop", undefined, { timeout: 3 * 60 * 1000 }),
  restart: (warningMinutes?: number) =>
    apiPost("/server/restart", { warningMinutes }),
  restartNow: () => apiPost("/server/restart", { warningMinutes: 0 }),
  save: () => apiPost("/server/save"),
  sendMessage: (message: string) => apiPost("/server/message", { message }),

  // Wipe
  wipePreview: (targets: string[]) =>
    apiPost("/server/wipe/preview", { targets }),
  // POST /wipe awaits a full pre-wipe backup (server/routes/server.js's own
  // comment calls it "the multi-minute pre-wipe backup") before the
  // destructive delete even starts -- same held-open-request shape as
  // backupApi.createBackup below, just reached through a different route.
  wipe: (targets: string[], createBackup: boolean = true) =>
    apiPost(
      "/server/wipe",
      { targets, confirm: true, createBackup },
      { timeout: 10 * 60 * 1000 },
    ) as Promise<{
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

  // Ports and folders for another server on this host -- see
  // server/services/serverPortPlan.js.
  getSetupPlan: () => apiGet("/server/setup-plan") as Promise<ServerSetupPlan>,

  // SteamCMD Installation
  install: (config: Record<string, unknown>) =>
    apiPost("/server/install", config),

  detectSteamCmd: () =>
    apiPost("/server/steamcmd/detect") as Promise<{
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
  // `identity` is the token the previous answer carried: it names the file
  // lastSize belongs to, so the server can tell this page the log was
  // recreated even when another page already saw it happen.
  streamConsoleLog: (lastSize: number, identity?: string) =>
    apiGet(
      `/server/console-log/stream?lastSize=${lastSize}${
        identity ? `&identity=${encodeURIComponent(identity)}` : ""
      }`,
    ),
  getConsoleErrorCount: (): Promise<{
    exists: boolean
    count: number
    sinceStart: boolean
    truncated?: boolean
  }> => apiGet("/server/console-log/error-count"),
  clearConsoleLog: () => apiPost("/server/console-log/clear"),
  // The game's server-console.txt alone (secrets redacted by the server),
  // saved under the name the server gives it.
  downloadConsoleLog: async (): Promise<void> => {
    const response = await fetchWithRetry(`${API_BASE}/server/console-log/download`);
    if (!response.ok) {
      const payload = await parseResponseBody(response);
      throw buildResponseError(response, payload);
    }
    const disposition = response.headers.get("content-disposition") || "";
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] || "server-console.txt";
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

// Players API
export const playersApi = {
  getPlayers: (options?: { retries?: number }) =>
    apiGet("/players", undefined, options?.retries),
  getWhitelist: (options?: { retries?: number }) => apiGet<{
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
  }>("/players/whitelist", undefined, options?.retries),
  kick: (username: string, reason?: string) =>
    apiPost("/players/kick", { username, reason }),
  ban: (username: string, banIp?: boolean, reason?: string) =>
    apiPost("/players/ban", { username, banIp, reason }),
  unban: (username: string) => apiPost("/players/unban", { username }),
  setAccessLevel: (username: string, level: string, confirm?: boolean) =>
    apiPost("/players/access-level", { username, level, confirm }),
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
  getPerks: (options?: { retries?: number }) =>
    apiGet("/players/perks", undefined, options?.retries),
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
  getActivityLogs: (player?: string, limit?: number, options?: { retries?: number }) =>
    apiGet(
      `/players/activity?${player ? `player=${encodeURIComponent(player)}&` : ""}limit=${limit || 100}`,
      undefined,
      options?.retries,
    ),
  // Player Notes
  getNotes: (options?: { retries?: number }) =>
    apiGet("/players/notes", undefined, options?.retries),
  getNote: (playerName: string) =>
    apiGet(`/players/notes/${encodeURIComponent(playerName)}`),
  saveNote: (playerName: string, note: string, tags: string[]) =>
    apiPost("/players/notes", { playerName, note, tags }),
  deleteNote: (playerName: string) =>
    apiDelete(`/players/notes/${encodeURIComponent(playerName)}`),
  // Player Stats (playtime tracking)
  getStats: (options?: { retries?: number }) =>
    apiGet("/players/stats", undefined, options?.retries),
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
  // Set only for the two system-triggered restarts (Manual restart / Auto
  // Restart) -- null for a real user-named scheduled task, which stays
  // task_name verbatim (it's the user's own text, not ours to translate).
  task_name_key?: "manualRestart" | "autoRestart" | null;
  command: string;
  success: number;
  message: string | null;
  // Same key-beside-text convention for the message: set only where the
  // panel wrote the message itself (see ScheduledBackupAttempt.messageKey).
  message_key?: ScheduleMessageKey | null;
  message_params?: ScheduleMessageParams | null;
  duration: number | null;
  executed_at: string;
}

export interface RestartWarningSettings {
  locale: "en" | "zh-CN" | "fr" | "de" | "es" | "ht" | "pt-BR";
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
  getStatus: (options?: { retries?: number }) =>
    apiGet("/scheduler/status", undefined, options?.retries) as Promise<SchedulerStatus>,
  getTasks: (options?: { retries?: number }) =>
    apiGet("/scheduler/tasks", undefined, options?.retries),
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
  getCronPresets: (options?: { retries?: number }) =>
    apiGet("/scheduler/cron-presets", undefined, options?.retries),
  validateCron: (cronExpression: string) =>
    apiPost("/scheduler/validate-cron", { cronExpression }) as Promise<{
      valid: boolean;
      error?: string;
      code?: string;
    }>,
  getHistory: (limit?: number, taskId?: number, options?: { retries?: number }) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", limit.toString());
    if (taskId) params.set("taskId", taskId.toString());
    const query = params.toString();
    return apiGet(
      `/scheduler/history${query ? `?${query}` : ""}`,
      undefined,
      options?.retries,
    ) as Promise<{
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

// What adding a workshop item to the server ini amounted to (server/routes/
// mods.js additionStatus): "added" = a mod ID was written to Mods=;
// "already-configured" = nothing needed changing; "workshop-only" = no mod ID
// is known yet (not downloaded), so only WorkshopItems= changed and the mod
// does not load until its ID is known (start the server, then Sync Mod IDs).
export type ModAdditionStatus = "added" | "already-configured" | "workshop-only";

export interface AddToIniBulkItemResult {
  workshopId: string;
  status: ModAdditionStatus | "invalid";
  addedModIds?: string[];
  alternativeModIds?: string[];
  mapFoldersAdded?: string[];
  workshopAlreadyExisted?: boolean;
  detectionSource?: string | null;
  code?: string;
}

export interface AddToIniBulkResult {
  success: boolean;
  total: number;
  added: number;
  alreadyConfigured: number;
  workshopOnly: number;
  invalid: number;
  mapFoldersAdded: string[];
  results: AddToIniBulkItemResult[];
  backupWarning?: string;
}

// Mod Groups (server/routes/mods.js, /mods/groups...). `modIds` is ordered:
// the list order is the load order those mods must keep.
export type ModGroupColorName =
  | "slate" | "red" | "orange" | "amber" | "lime" | "green" | "teal" | "sky" | "blue" | "violet" | "pink";

export interface ModGroup {
  id: string;
  name: string;
  description: string;
  modIds: string[];
  createdAt: string;
  updatedAt: string;
  // A group saved before these existed reads back as null / false.
  color?: ModGroupColorName | null;
  // The members also load as one contiguous block.
  keepTogether?: boolean;
  // Where smart sort puts the group (null: anywhere). Absent on older servers.
  placement?: ModGroupPlacement;
}

export interface ModGroupInput {
  name: string;
  description?: string;
  modIds: string[];
  color?: ModGroupColorName | null;
  keepTogether?: boolean;
  placement?: ModGroupPlacement;
}

// The export / import file: a group without its id and dates, so it can be
// imported into another panel.
export interface ModGroupDocument {
  schema: 1;
  kind: "zcp-mod-group";
  name: string;
  description?: string;
  modIds: string[];
  color?: ModGroupColorName | null;
  keepTogether?: boolean;
  placement?: ModGroupPlacement;
}

// POST /mods/groups/:id/enable
export interface ModGroupEnableResult {
  enabled: string[];
  alreadyEnabled: string[];
  // Members found in no Workshop item on disk: they could not be enabled.
  missing: string[];
  workshopItemsAdded: string[];
  groupsAdjusted: string[];
  backupWarning?: string;
}

// POST /mods/groups/:id/disable
export interface ModGroupDisableResult {
  disabled: string[];
  // Also in another group whose mods are all enabled, so they stay.
  keptShared: string[];
  notEnabled: string[];
  // PanelBridge's own mod while its Workshop delivery manages it.
  keptManaged?: string[];
  backupWarning?: string;
}

// GET /mods/groups/suggestions. `reason` is an English machine phrase the
// client does not show: it words its own text from `kind` and the counts.
export interface ModGroupSuggestion {
  key: string;
  kind: "dependency" | "prefix" | "workshop-item";
  name: string;
  modIds: string[];
  reason?: string;
  /** dependency: how many of the mods require the library (the rest joined from an overlapping suggestion). */
  dependents?: number;
  /** dependency whose users are not otherwise related: the library's name; titled "Mods that use <library>". */
  library?: string;
}

// GET /mods/notes, PUT /mods/notes/:workshopId. One note per Workshop item,
// shared by every admin of the panel.
export interface ModNote {
  text: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ModGroupStatusEntry {
  id: string;
  inOrder: boolean;
  // Members that are in the active server's Mods= list, of `total` members.
  present: number;
  total: number;
  missing: string[];
}

export interface ModGroupsStatus {
  groups: ModGroupStatusEntry[];
  // Every group is in order in the server's saved Mods= list.
  inOrder: boolean;
  // Groups (or mods) whose orders contradict each other, so no load order can
  // satisfy all of them.
  conflicts: string[];
}

export interface ModGroupsApplyResult {
  changed: boolean;
  moved: string[];
  order: string[];
  written: boolean;
  conflicts: string[];
}

// POST /mods/save-order. With "keep group order" on, the server moves group
// members back into their group order and says which mods it moved.
export interface SaveModOrderResult {
  message?: string;
  modCount?: number;
  groupsAdjusted?: string[];
  groupConflicts?: string[];
}

// Load order as Build 42 really applies it (server/utils/modLoadOrder.js):
// optional fields of GET /mods/current-config and of the conflict scan.
export type ModInfoListField = "require" | "loadModAfter" | "loadModBefore" | "incompatible";

// A mod.info list entry the game cannot match (it splits on "," only and
// keeps spaces). In require= it keeps the mod from loading.
export interface ModInfoIssue {
  field: ModInfoListField;
  entry: string;
  code: "emptyEntry" | "blankEntry" | "whitespace" | "semicolon";
}

// Extra fields of each GET /mods/current-config workshopModMap entry.
export interface ModOrderingFields {
  loadAfter?: string[];
  loadBefore?: string[];
  incompatible?: string[];
  modInfoIssues?: ModInfoIssue[];
}

export type OrderingConstraintReason = "require" | "loadAfter" | "loadBefore" | "patch" | "conflictWinner";

// `before` must load before `after`. require is enforced by the game;
// loadAfter/loadBefore are declared by the mods; patch (named like a patch
// for the other mod) and conflictWinner (keeps the current winner) are soft.
export interface OrderingConstraint {
  before: string;
  after: string;
  reason: OrderingConstraintReason;
  reasons?: OrderingConstraintReason[];
  declaredBy?: string;
}

export type OrderWarningCode =
  | "requireCycle"
  | "requireNotFound"
  | "requireUnavailable"
  | "requireEntryInvalid"
  | "requireAutoLoaded"
  | "requireReordered"
  | "loadAfterViolated"
  | "loadBeforeViolated"
  | "declaredIncompatible"
  | "modInfoListIssue"
  | "modNotFound";

export interface OrderWarning {
  code: OrderWarningCode;
  severity: "high" | "medium" | "low" | "info";
  modId: string;
  via?: string;
  missing?: string;
  caseMatch?: string;
  dependency?: string;
  other?: string;
  cycle?: string[];
  field?: ModInfoListField;
  entry?: string;
  issue?: ModInfoIssue["code"];
}

export interface ModOrderAnalysis {
  // The order the dedicated server loads Mods= in (required mods first).
  effectiveModOrder?: string[];
  orderWarnings?: OrderWarning[];
  orderingConstraints?: OrderingConstraint[];
}

export type ConflictRuleSeverity = "high" | "medium" | "low" | "info";

export type ConflictKind =
  | "file-override"
  | "lua-override"
  | "script-file-override"
  | "script-override"
  | "translation-override"
  | "clothing-override"
  | "lua-global-clash"
  | "declared-incompatible";

// Translated in the conflictsPanel namespace under reasons.<code>.
export type ConflictReason =
  | "assetOverride"
  | "mapFileOverride"
  | "dataFileOverride"
  | "luaFileOverride"
  | "scriptFileReplaced"
  | "scriptFileOverride"
  | "scriptDefinitionOverride"
  | "scriptDefinitionMerge"
  | "translationKeyOverride"
  | "translationUnreadable"
  | "clothingOutfitOverride"
  | "clothingItemOverride"
  | "luaGlobalRedefined"
  | "luaVariantClash"
  | "declaredIncompatible"
  | "intendedPatch"
  | "patchLoadsBeforeTarget";

// Extra fields of each scan pairs[].files[] entry (its severity may also be
// "info": an intended override by a declared patch).
export interface ConflictFileRuleFields {
  kind?: ConflictKind;
  reason?: ConflictReason;
  // The file-level reason an intendedPatch / patchLoadsBeforeTarget replaced.
  baseReason?: ConflictReason;
  intended?: boolean;
  files?: { modId: string; file: string }[];
}

// Extra fields of the conflict scan result (pairs also carry infoCount).
export interface ConflictScanRuleFields extends ModOrderAnalysis {
  benignSkipped?: { nonGameplay: number; notLoaded: number; sameDefinitions: number; layeredAdditions?: number };
  severityCounts?: Record<ConflictRuleSeverity, number>;
}

export const modsApi = {
  getStatus: (options?: { retries?: number }) =>
    apiGet("/mods/status", undefined, options?.retries),
  getTrackedMods: (options?: { retries?: number }) =>
    apiGet("/mods/tracked", undefined, options?.retries),
  trackMod: (workshopId: string) => apiPost("/mods/track", { workshopId }),
  untrackMod: (workshopId: string) => apiDelete(`/mods/track/${workshopId}`),

  // Ignored mods (prevent auto-re-tracking)
  getIgnoredMods: (options?: { retries?: number }) =>
    apiGet("/mods/ignored", undefined, options?.retries),
  unignoreMod: (workshopId: string) => apiDelete(`/mods/ignored/${workshopId}`),
  unignoreMods: (workshopIds: string[]) =>
    apiPost<{ success: boolean; removed: number; message?: string }>("/mods/ignored/remove", { workshopIds }),
  clearAllIgnoredMods: () => apiDelete("/mods/ignored"),

  // Ignored mod-conflict pairs (false positives on the variant detector)
  getIgnoredModPairs: (options?: { retries?: number }) =>
    apiGet("/mods/ignored-pairs", undefined, options?.retries) as Promise<
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
  getCurrentConfig: (options?: { retries?: number }) =>
    apiGet("/mods/current-config", undefined, options?.retries),

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
    options?: { signal?: AbortSignal; download?: boolean },
  ) =>
    // `download`: have SteamCMD fetch an item that is not on the server yet, so its
    // mod IDs are read from its own files (up to 8 minutes on the server side).
    apiPost(
      "/mods/discover-mod-ids",
      { workshopId, workshopUrl, download: options?.download === true ? true : undefined },
      { signal: options?.signal, timeout: options?.download ? 9 * 60 * 1000 : undefined },
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
      downloadedFromSteam?: boolean;
      downloadSkippedReason?: string | null;
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
      /** What the add amounted to ("workshop-only": no mod ID known, only WorkshopItems= changed). Absent on older servers. */
      status?: ModAdditionStatus;
      message: string;
    }>,

  // Add many workshop items in ONE server .ini write (one backup): Import
  // Collection and re-enabling several deactivated mods. Each entry follows
  // addModAdvanced's fields; with neither selectedModIds nor includeAllModIds
  // only the item's default mod is enabled (like addToIni) and the others come
  // back as alternativeModIds. `track` also tracks every item (an import).
  addToIniBulk: (
    mods: Array<{
      workshopId: string;
      selectedModIds?: string[];
      includeAllModIds?: boolean;
    }>,
    track?: boolean,
  ) =>
    // An item that is not downloaded yet is looked up on Steam (the server
    // gives up on those after 30 s), so the default 15 s request timeout is too short.
    apiPost("/mods/add-to-ini-bulk", { mods, track }, { timeout: 120_000 }) as Promise<AddToIniBulkResult>,

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

  // Mod Groups: named, ordered lists of mod IDs whose list order is the load
  // order those mods must keep relative to each other. Stored panel-wide (every
  // admin sees the same groups); shared with another panel as a small JSON
  // document (ModGroupDocument).
  getGroups: () =>
    apiGet<{ groups: ModGroup[]; enforce: boolean }>("/mods/groups"),
  createGroup: (group: ModGroupInput) =>
    apiPost<{ group: ModGroup }>("/mods/groups", group),
  updateGroup: (id: string, patch: Partial<ModGroupInput>) =>
    apiPut<{ group: ModGroup }>(`/mods/groups/${encodeURIComponent(id)}`, patch),
  deleteGroup: (id: string) =>
    apiDelete<{ success: boolean }>(`/mods/groups/${encodeURIComponent(id)}`),
  importGroup: (document: ModGroupDocument) =>
    apiPost<{ group: ModGroup }>("/mods/groups/import", { document }),
  getGroupsStatus: () =>
    apiGet<ModGroupsStatus>("/mods/groups/status"),
  // preview: true computes what would move and writes nothing.
  applyGroups: (preview: boolean) =>
    apiPost<ModGroupsApplyResult>("/mods/groups/apply", { preview }),
  setGroupsEnforce: (enforce: boolean) =>
    apiPut<{ enforce: boolean }>("/mods/groups/enforce", { enforce }),
  // Enable / disable every member mod of a group on the active server, in one
  // ini write each (the server keeps the group's order when enabling).
  enableGroup: (id: string) =>
    apiPost<ModGroupEnableResult>(`/mods/groups/${encodeURIComponent(id)}/enable`, {}),
  disableGroup: (id: string, keepShared = true) =>
    apiPost<ModGroupDisableResult>(`/mods/groups/${encodeURIComponent(id)}/disable`, { keepShared }),
  getGroupSuggestions: () =>
    apiGet<{ suggestions: ModGroupSuggestion[] }>("/mods/groups/suggestions"),
  dismissGroupSuggestion: (key: string) =>
    apiPost<{ success: boolean }>("/mods/groups/suggestions/dismiss", { key }),
  // Mod notes, keyed by Workshop item id. An empty text deletes the note.
  getNotes: () =>
    apiGet<{ notes: Record<string, ModNote> }>("/mods/notes"),
  setNote: (workshopId: string, text: string) =>
    apiPut<{ note: ModNote | null }>(`/mods/notes/${encodeURIComponent(workshopId)}`, { text }),

  // Mod Load Order
  saveModOrder: (modIds: string[]) =>
    apiPost<SaveModOrderResult>("/mods/save-order", { modIds }),

  // Mod Conflict Scanner
  getConflicts: (options?: RequestInit) =>
    apiGet<import("@/types").ConflictScanResult & ConflictScanRuleFields>("/mods/conflicts", options),
  getCachedConflicts: () =>
    apiGet<
      | (import("@/types").ConflictScanResult & ConflictScanRuleFields & {
          stale?: boolean;
          _workshopIdsSnapshot?: string[];
          _modIdsSnapshot?: string[];
        })
      | null
    >("/mods/conflicts/cached"),
  // Smart load order (server/routes/modsSmart.js): order rules, the plan,
  // the health check with its one-click fixes, and what the panel makes of
  // each mod. The plan never writes; a fix writes one of the issue's own
  // fixes (through the ini lock and backup).
  getOrderRules: () =>
    apiGet<{ rules: ModOrderRule[]; max: number }>("/mods/order-rules"),
  addOrderRule: (rule: ModOrderRuleInput) =>
    apiPost<{ rule: ModOrderRule; existing: boolean; replaced: string[] }>("/mods/order-rules", rule),
  deleteOrderRule: (id: string) =>
    apiDelete<{ success: boolean }>(`/mods/order-rules/${encodeURIComponent(id)}`),
  planLoadOrder: (request: LoadOrderPlanRequest = {}, options?: { signal?: AbortSignal }) =>
    apiPost<LoadOrderPlan>("/mods/load-order/plan", request, options),
  getModHealth: () =>
    apiGet<ModHealth>("/mods/health"),
  applyModHealthFix: (issueId: string, action: ModHealthFixAction, params?: Record<string, unknown>) =>
    apiPost<ModHealthFixResult>("/mods/health/fix", { issueId, action, ...(params ? { params } : {}) }),
  // "Fix everything": keep Mods=, WorkshopItems= and Map= before a run, and
  // put them back for its Undo (one backup, one write).
  autofixSnapshot: () =>
    apiPost<{ snapshotId: string }>("/mods/autofix/snapshot", {}),
  autofixRestore: (snapshotId: string) =>
    apiPost<{ restored: boolean; backupWarning?: string }>("/mods/autofix/restore", { snapshotId }),
  // refresh: fetch Steam data now (at most once a minute; otherwise cached
  // data answers and the rest is fetched in the background).
  getModInsights: (refresh = false) =>
    apiGet<ModInsights>(refresh ? "/mods/insights?refresh=1" : "/mods/insights"),
};

// ── Smart load order (server/routes/modsSmart.js) ────────────────────────────

// Where the plan puts a mod group: "first" as early as its constraints allow
// (with what it needs), "last" as late (with what needs it). Groups answer it
// as `placement` (null when unset); POST/PUT /mods/groups and group files
// accept it.
export type ModGroupPlacement = "first" | "last" | null;

export type ModOrderRuleSource = "manual" | "conflictResolve" | "healthFix";

// "Load `before` before `after`", pinned by an admin. Panel-wide; a rule for
// a mod that is not enabled is kept and ignored.
export interface ModOrderRule {
  id: string;
  before: string;
  after: string;
  note: string;
  source: ModOrderRuleSource;
  createdBy: string | null;
  createdAt: string | null;
}

export interface ModOrderRuleInput {
  before: string;
  after: string;
  note?: string;
  source?: ModOrderRuleSource;
  // Replace a stored rule the other way round (flip a conflict's winner).
  replaceOpposite?: boolean;
}

// Strongest first: hard (require, rule, groupOrder), strong (loadAfter,
// loadBefore, steamRequired, patch, conflictWinner).
export type SmartConstraintReason =
  | "require"
  | "rule"
  | "groupOrder"
  | "loadAfter"
  | "loadBefore"
  | "steamRequired"
  | "patch"
  | "conflictWinner";

export interface SmartConstraint {
  before: string;
  after: string;
  reason: SmartConstraintReason;
  strength: "hard" | "strong";
  // Every reason when the pair has several (strongest first).
  reasons?: SmartConstraintReason[];
  declaredBy?: string;
  // require= through a required mod Mods= does not list.
  via?: string;
  ruleId?: string;
  group?: string;
  // steamRequired: the dependent item and the item it requires.
  workshopId?: string;
  requiresWorkshopId?: string;
  // patch: "classification" or "name".
  source?: "classification" | "name";
  confidence?: SmartConfidence;
}

export type SmartConfidence = "high" | "medium" | "low";

// Why a mod is where it is (explanations) or why it moved (moves).
// relation "after": the mod loads after `other`; "before": before it.
export type SmartReasonCode = SmartConstraintReason | "keepTogether" | "groupPlacement" | "tier" | "displaced";

export interface SmartReason {
  code: SmartReasonCode;
  params: {
    relation?: "after" | "before";
    other?: string;
    via?: string;
    ruleId?: string;
    group?: string;
    groupName?: string;
    placement?: "first" | "last";
    workshopId?: string;
    requiresWorkshopId?: string;
    source?: "classification" | "name";
    confidence?: SmartConfidence;
    tier?: number;
    kind?: ModKind;
  };
}

export interface LoadOrderPlanRequest {
  // The (unsaved) Mods= order to plan; default the saved one.
  order?: string[];
  // "tiered" also orders by kind: libraries first, translations last.
  mode?: "minimal" | "tiered";
  // false ignores mod groups. Default true.
  groups?: boolean;
  // Mods that ship the same files; today's winner (the later one) stays
  // later. Default: the last conflict scan's pairs.
  conflictPairs?: [string, string][];
  // [before, after] order rules to plan with as if stored (nothing is stored).
  rules?: [string, string][];
}

export interface LoadOrderPlanMove {
  modId: string;
  // 0-based positions in the given order and in the plan.
  from: number;
  to: number;
  reasons: SmartReason[];
  confidence: SmartConfidence;
}

export interface LoadOrderPlanUnsatisfied {
  before: string;
  after: string;
  reason: SmartConstraintReason;
  why: "cycle" | "conflictsWithHarder" | "missingMod";
  // conflictsWithHarder: what won ("groupPlacement" for a placement).
  by?: SmartConstraintReason | "groupPlacement";
  group?: string;
  ruleId?: string;
  // missingMod: the game loads the required mod anyway (installed).
  loadedImplicitly?: boolean;
}

export type LoadOrderPlanWarning =
  | { code: "inTwoKeepTogetherGroups"; params: { modId: string; group: string; otherGroup: string } }
  | { code: "keepTogetherBroken"; params: { group: string; groupName: string; mods: string[] } }
  | { code: "placementConflict"; params: { groups: string[]; mods: string[] } };

export interface SteamKnowledgeStatus {
  source: "api" | "page" | "none";
  fetchedAt: string | null;
  stale: boolean;
  failed: boolean;
  pending: boolean;
  rateLimited?: boolean;
  known: number;
  total: number;
}

export interface LoadOrderPlan {
  order: string[];
  changed: boolean;
  // The fewest mods that explain the change; a mod no rule names never moves.
  moves: LoadOrderPlanMove[];
  explanations: Record<string, SmartReason[]>;
  satisfied: number;
  unsatisfied: LoadOrderPlanUnsatisfied[];
  // Each constraint dropped to break a loop; gameCrash: a require= loop the
  // server's loader overflows its stack on.
  cycles: { mods: string[]; droppedEdge: { before: string; after: string; reason: SmartConstraintReason }; gameCrash?: true }[];
  winnersChanged: {
    previousWinner: string;
    newWinner: string;
    why: "cycle" | "conflictsWithHarder";
    by?: SmartConstraintReason | "groupPlacement";
  }[];
  // Required mods the game loads although Mods= does not list them.
  implicit: { modId: string; requiredBy: string[] }[];
  warnings: LoadOrderPlanWarning[];
  stats: { constraints: number; hard: number; strong: number; soft: number; ms: number };
  steamStatus: SteamKnowledgeStatus;
}

export type ModKind = "library" | "framework" | "map" | "translation" | "patch" | "content" | "tweak" | "ui" | "unknown";

export type ModHealthSeverity = "critical" | "warning" | "info";

export type ModHealthKind =
  | "requireLoop"
  | "modInfoBroken"
  | "requiredNotInstalled"
  | "requiredWorkshopItemMissing"
  | "notInstalled"
  | "b41Only"
  | "incompatibleEnabled"
  | "duplicateModId"
  | "mapNotInMapLine"
  | "mapFolderWithoutMod"
  | "orderProblems"
  | "requiredLoadedImplicitly"
  | "unusedWorkshopItem"
  | "updatesAvailable";

export type ModHealthFixAction =
  | "removeMods"
  | "addMods"
  | "addWorkshopItems"
  | "removeWorkshopItems"
  | "addMapFolders"
  | "removeMapFolders"
  | "applyPlan";

export interface ModHealthFix {
  action: ModHealthFixAction;
  // removeMods { modIds }, addMods { modIds, before? }, addWorkshopItems
  // { workshopIds, modIds?, before? }, removeWorkshopItems { workshopIds,
  // modIds?, dedupeModIds?, keep? } ("Keep <keep>" of a duplicate: the other
  // items leave, with the Mods= entries only they ship), addMapFolders /
  // removeMapFolders { folders }, applyPlan {}.
  params: { modIds?: string[]; workshopIds?: string[]; folders?: string[]; before?: string; keep?: string; dedupeModIds?: string[] };
  // English fallback; translate by action and params.
  label: string;
}

export interface ModHealthIssue {
  // Stable while the problem is the same: send it back with a fix.
  id: string;
  kind: ModHealthKind;
  severity: ModHealthSeverity;
  modIds: string[];
  workshopIds: string[];
  params: Record<string, unknown>;
  fixes: ModHealthFix[];
}

export interface ModHealth {
  checkedAt: string;
  counts: Record<ModHealthSeverity, number>;
  issues: ModHealthIssue[];
  steamStatus: SteamKnowledgeStatus;
}

export interface ModHealthFixResult {
  applied: boolean;
  backupWarning?: string;
  health: ModHealth;
}

export interface ModInsight {
  // null for a mod in the data folder (<Zomboid>/mods, or a staged item).
  workshopId: string | null;
  // Where the copy the server loads comes from.
  source: "workshop" | "local" | "staged";
  name: string;
  // In Mods= (false: loaded only because something requires it).
  enabled: boolean;
  kind: ModKind;
  kindConfidence: SmartConfidence;
  kindReasons: { code: string; params?: Record<string, unknown> }[];
  // 0 library/framework, 1 map/content, 2 ui/unknown, 3 patch/tweak, 4 translation.
  tier: number;
  patchOf: string[];
  dependents: number;
  requires: string[];
  requiredBy: string[];
  steamTags: string[];
}

export interface ModInsights {
  generatedAt: string;
  steamStatus: SteamKnowledgeStatus;
  mods: Record<string, ModInsight>;
  workshopRequirements: {
    workshopId: string;
    title: string | null;
    requires: { workshopId: string; title: string | null; installed: boolean; enabled: boolean }[];
  }[];
  constraints: SmartConstraint[];
}

// GET /mods/groups/status entries also carry `forcedApart` for a group kept
// together that require= links or order rules keep apart (another mod must
// load between its members): it is judged on its order alone, the rule the
// load-order plan follows too.
export interface ModGroupStatusEntryWithForcedApart extends ModGroupStatusEntry {
  forcedApart?: string[];
}

// Each conflict scan pair may carry a suggested winner (no signal, none).
export interface ConflictWinnerSuggestion {
  winner: string;
  confidence: SmartConfidence;
  reason:
    | "rule"
    | "requiresOther"
    | "declaresLoadAfter"
    | "patchOfOther"
    | "translation"
    | "smallOverride"
    | "sameWorkshopItem";
  // Already the winner in the order the server loads.
  alreadyWinning: boolean;
  params?: { ruleId?: string; files?: number; conflicting?: number; otherFiles?: number; workshopId?: string };
}

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
  // expectedServerId: the resolvedServerId GET /chunks/:saveName returned
  // when this scan was made (null if the scan used customPath). Lets the
  // server refuse the delete if the active server moved out from under the
  // scan in between -- see chunks.js's CHUNKS_STALE_SERVER_SCAN.
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
    expectedServerId: string | null = null,
  ) =>
    apiPost("/chunks/delete-chunks", {
      saveName,
      chunks,
      createBackup,
      customPath,
      deleteVehicles,
      force,
      expectedServerId,
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
    expectedServerId: string | null = null,
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
      expectedServerId,
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
    }) as Promise<{
      success: boolean;
      message?: string;
      // Only present when a changed token or guild needed the bot to
      // reconnect: false = it could not (botStartError says why), null = a
      // start/stop from elsewhere was already in progress.
      botStarted?: boolean | null;
      botStartError?: string;
    }>,
  // keptCommandPermissions: commands whose tier the wipe kept because
  // changing it needs a capability the caller doesn't hold.
  resetConfig: () =>
    apiPost("/discord/reset") as Promise<{
      success: boolean;
      message?: string;
      keptCommandPermissions?: string[];
    }>,
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
      // false when the tiers were saved but pushing the slash commands to
      // Discord failed; absent otherwise.
      commandsRegistered?: boolean;
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
  // Left out of every server read for a role holding none of servers.manage,
  // rcon.execute and server.configure (server/utils/rconTargetView.js):
  // absent means hidden, not unset -- rconPassword's mask still says whether
  // RCON is set up.
  rconHost?: string;
  rconPort?: number;
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
  // Set on the /servers list: why the panel won't use this server's folders
  // (ZOMBOID_DATA_FOLDER_REFUSED or SERVER_CONFIG_PATH_OUTSIDE_DATA),
  // or null when it will.
  folderProblem?: { error: string; code: string } | null;
  isActive: boolean;
  startCommand: string;
  lifecycleProvider?: "direct" | "systemd" | "openrc";
  adminPassword: string;
  createdAt: string;
}

// A candidate that exists but couldn't be read (permission denied), as
// opposed to one that simply isn't mounted at all -- server/services/
// mountDiscovery.js's discoverMountIssues() already keeps these separate
// (see its own comment: "misconfigured host permissions" is a different,
// actionable problem from "nothing mounted here"). GET /discover-mounts has
// returned both `mounts` and `inaccessible` since discovery.js:36; this type
// only declared the former until the client-side gap was found and fixed
// (2026-09-09, docker-unraid-add-server-experience) -- the server-computed
// distinction was silently dropped one hop before it could ever reach a
// user, exactly the "the system knew and told the user nothing" shape.
export interface InaccessibleMountCandidate {
  path: string;
  source: string;
  reason: string;
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

// Ranked scan result (server/routes/discovery.js's `candidates` field,
// added alongside `mounts`/`inaccessible` -- server/services/mountDiscovery.js's
// scanAllCandidates()). Six-way `status` instead of a boolean or a 3-level
// confidence enum on purpose (Angela's call, 2026-09-09): each value maps to
// DIFFERENT copy (install-only vs data-only aren't the same story to tell a
// user), and `reason` is always one plain-language sentence already written
// server-side rather than something the client re-derives from a checks
// object. Sorted ready-first, not-mounted-last -- render top to bottom, no
// client re-sort needed. Mechanical rule for "exactly one confident match":
// candidates.filter(c => c.status === 'ready').length === 1 means auto-use
// it, don't present a picker (god's rule 3, 2026-09-09 bar broadcast).
export interface MountDiscoveryCandidate {
  installPath: string | null;
  dataPath: string | null;
  source: string;
  // "no-config": install and save data found, but no Server/<name>.ini to
  // read the name and RCON settings from -- handled like install-only.
  status: "ready" | "no-config" | "install-only" | "data-only" | "permission-denied" | "empty" | "not-mounted";
  reason: string;
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
  // Host signal only: when the process/container started (ISO string),
  // already re-expressed in this browser's clock by getComposedStatus().
  // Present only when running and known -- absent means unknown.
  startedAt?: string;
}

export interface ComposedServerStatus {
  provider: string;
  selected: boolean;
  host: ServerStatusSignal;
  server: ServerStatusSignal;
  bridge: ServerStatusSignal;
  summary: string;
  // The host's clock (epoch ms) as it answered -- see hostTimeToLocal().
  serverTime?: number;
}

type ServerStatusRow = {
  id: string;
  name: string;
  running: boolean;
  pid: string | null;
  isActive: boolean;
  stateUnknown?: boolean;
  // When this row's process started (ISO string, in this browser's clock
  // -- see getStatus() below); null when stopped or unknown.
  startedAt?: string | null;
  // A running server's resident memory, in bytes, when it could be read.
  memoryBytes?: number;
  // Its data folder's disk, from the disk monitor's last check.
  disk?: { usedPercent: number; freeBytes: number; warning: boolean; critical: boolean };
};

// A server other than the active one, as GET /servers/updates last found it.
export type OtherServerUpdate = {
  serverId: string;
  mods?: {
    outdated: Array<{ workshopId: string; name: string; latestAt: string }>;
    error?: string;
    checkedAt?: string;
  };
  game?: {
    installedBuild?: string;
    latestBuild?: string;
    branch?: string;
    updateAvailable?: boolean;
    error?: string;
    checkedAt?: string;
  };
};

// Who holds the lifecycle lock (one start/stop/restart/update... at a time
// panel-wide), and which servers are only waiting for their RCON after a
// start -- those block just themselves. GET /servers/lifecycle and the
// lifecycle:state socket event; also `holder` on a SERVER_LIFECYCLE_IN_PROGRESS 409.
export interface LifecycleHolder {
  operation: string;
  serverId: string | null;
  serverName: string | null;
  phase: "waiting-for-rcon" | null;
  since: number | null;
}

export interface LifecycleState {
  lock: LifecycleHolder | null;
  servers: LifecycleHolder[];
}

// Servers API (multi-server management)
export const serversApi = {
  // No retries: the socket's lifecycle:state keeps it current anyway.
  getLifecycle: () => apiGet("/servers/lifecycle", undefined, 0) as Promise<LifecycleState>,
  getAll: (options?: { retries?: number }) =>
    apiGet("/servers", undefined, options?.retries) as Promise<{
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
  // host.startedAt arrives on the host's clock; see hostTimeToLocal().
  getComposedStatus: (options?: { retries?: number }) =>
    (apiGet("/servers/active/status", undefined, options?.retries) as Promise<ComposedServerStatus>).then(
      (status) =>
        status?.host?.startedAt
          ? { ...status, host: { ...status.host, startedAt: hostTimeToLocal(status.host.startedAt, status.serverTime) } }
          : status,
    ),
  getResolvedActive: async () => {
    const data = (await apiGet("/servers")) as { servers: ServerInstance[] };
    return {
      server:
        data.servers.find((server) => server.isActive) ??
        data.servers[0] ??
        null,
    };
  },
  // Each row's startedAt arrives on the host's clock; see hostTimeToLocal().
  getStatus: (options?: { retries?: number }) =>
    (apiGet("/servers/status", undefined, options?.retries) as Promise<{
      servers: ServerStatusRow[];
      detectedProcesses: number;
      detectionError: string | null;
      serverTime?: number;
      // What this host (or its container) can give the servers, in bytes.
      hostMemoryBytes?: number;
    }>).then((data) =>
      Array.isArray(data?.servers)
        ? {
            ...data,
            servers: data.servers.map((row) =>
              row.startedAt ? { ...row, startedAt: hostTimeToLocal(row.startedAt, data.serverTime) } : row,
            ),
          }
        : data,
    ),
  // Mods behind Steam and game builds of the servers other than the active
  // one, as of the server's last check.
  getUpdates: () =>
    apiGet("/servers/updates") as Promise<{ servers: OtherServerUpdate[] }>,
  // `players: true` also counts who is on each server that answers.
  getRconStatuses: (options?: { players?: boolean }) =>
    apiGet(options?.players ? "/servers/rcon-status?players=1" : "/servers/rcon-status") as Promise<{
      servers: Array<{
        id: string;
        status: "connected" | "unreachable" | "auth_failed" | "unconfigured" | "unavailable";
        players?: number | null;
      }>;
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
      // The same warnings, each with its code when it has one.
      warningDetails?: Array<{ error: string; code?: string }>;
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
  // A server other than the active one, from the Dashboard's list of servers
  // (the active one's are serverApi.start/stop/restart).
  start: (id: string | number) =>
    apiPost(`/servers/${id}/start`) as Promise<{
      success: boolean;
      alreadyRunning?: boolean;
      message?: string;
    }>,
  stop: (id: string | number) =>
    apiPost(`/servers/${id}/stop`) as Promise<{
      success: boolean;
      alreadyStopped?: boolean;
      confirmed?: boolean;
      message?: string;
    }>,
  restart: (id: string | number, warningMinutes?: number) =>
    apiPost(`/servers/${id}/restart`, { warningMinutes }) as Promise<{
      success: boolean;
      message?: string;
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
      inaccessible: InaccessibleMountCandidate[];
      candidates: MountDiscoveryCandidate[];
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
  // The route answers only once Docker has finished: a stop waits out the
  // container's own StopTimeout (a heavy B42 world sets 90 s or more) and a
  // restart pays that plus a start (dockerClient.lifecycleTimeoutMs), so the
  // generic 15 s timeout reported a failure while Docker was still working.
  runAction: (id: string, action: "start" | "stop" | "restart", serverId: string | number) =>
    apiPost(`/docker/containers/${encodeURIComponent(id)}/${action}`, { serverId }, { timeout: 3 * 60 * 1000 }) as Promise<{
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

// GET /server-files/sandbox's parse of SandboxVars.lua. Every other top-level
// table in the file (mod option blocks) also comes back as a section of its
// own name, holding that table's values; PUT /server-files/sandbox writes
// each section back at that same path (#197).
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

// The world save's map_sand.bin: its own copy of every sandbox option, which
// the game applies over SandboxVars.lua on every start (#197). `path` is on
// the host the server runs on (a POSIX path over SFTP for a remote server),
// or only the file name for a role that can't see host folders;
// `mtime` is an ISO timestamp.
export interface WorldSandboxSnapshot {
  path: string;
  mtime: string;
}

// After a live sandbox change through PanelBridge (#197): the world has a
// map_sand.bin, which the game loads over SandboxVars.lua on every start.
// `refreshed` says the bridge rewrote it with the change, so the change is
// kept in the world's saved settings; when false, the next start undoes it.
// Absent when the world has no such file.
export interface LiveWorldSandboxSnapshot {
  path: string;
  refreshed: boolean;
}

export interface UtilitiesChangeResult {
  message?: string;
  power?: boolean;
  water?: boolean;
  hydroPowerOn?: boolean;
  debug?: string[];
  // false when a server restart will undo the change: SandboxVars.lua
  // could not be updated, or the world's map_sand.bin (worldSandboxSnapshot)
  // was not.
  persisted?: boolean;
  persistReason?: string | null;
  worldSandboxSnapshot?: LiveWorldSandboxSnapshot;
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
  getPaths: (options?: { retries?: number }) =>
    apiGet("/server-files/paths", undefined, options?.retries) as Promise<{
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
  getIni: (options?: { retries?: number }) =>
    apiGet("/server-files/ini", undefined, options?.retries) as Promise<{
      /** Each value trimmed (parseIni). For readers that only want the text. */
      settings: Record<string, string>;
      /**
       * The same keys, each value exactly as the game reads it from its line
       * (" true" stays " true"). The Server Settings form edits and resends
       * these. Absent from the demo-mode mock.
       */
      rawSettings?: Record<string, string>;
      /** Keys whose line the game skips, mapped to the option name it reads there ("Public "). */
      misnamedKeys?: Record<string, string>;
      /**
       * Line numbers (from 1) that make the game ignore the whole file and
       * run on every default: a line starting with "=", or "Version=".
       */
      fatalLines?: number[];
      /** Masked secrets whose value has an "=" the game stops reading at. Never the values. */
      maskedCutAtEqualsKeys?: string[];
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
  getSandbox: (options?: { retries?: number }) =>
    apiGet("/server-files/sandbox", undefined, options?.retries) as Promise<{
      sandbox: SandboxData;
      path: string;
      serverName: string;
      // Set when SandboxVars.lua does not parse or has no SandboxVars table;
      // `sandbox` is then empty.
      parseError?: { message: string; line: number; column: number };
      // Set when the world save has a map_sand.bin, which the game applies
      // over SandboxVars.lua on every start (#197). Local servers only.
      worldSandboxSnapshot?: WorldSandboxSnapshot;
    }>,
  saveSandbox: (sandbox: SandboxData) =>
    apiPut("/server-files/sandbox", { sandbox }) as Promise<{
      success: boolean;
      created: boolean;
      message: string;
      path: string;
      unpersistedKeys?: string[];
      restartRequired?: boolean;
      worldSandboxSnapshot?: WorldSandboxSnapshot;
    }>,
  // Moves the world's map_sand.bin into the config backups folder (on the
  // host, for a remote server), so the next start uses SandboxVars.lua. 409
  // SERVER_RUNNING while it runs.
  retireWorldSandboxSnapshot: () =>
    apiPost("/server-files/sandbox/world-snapshot/retire") as Promise<{
      success: boolean;
      retired: boolean;
      movedTo?: string;
      message?: string;
    }>,
  validateSandbox: () =>
    apiGet("/server-files/sandbox/validate") as Promise<{
      valid: boolean;
      braceDepth: number;
      parseError?: string;
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
  getSpawnPoints: (options?: { retries?: number }) =>
    apiGet("/server-files/spawnpoints", undefined, options?.retries) as Promise<{
      spawnpoints: SpawnPointsByProfession;
      path: string;
    }>,
  saveSpawnPoints: (spawnpoints: SpawnPointsByProfession) =>
    apiPut("/server-files/spawnpoints", { spawnpoints }),

  // Spawn Regions
  getSpawnRegions: (options?: { retries?: number }) =>
    apiGet("/server-files/spawnregions", undefined, options?.retries) as Promise<{
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
      // type "sandbox" only, same as getSandbox's.
      worldSandboxSnapshot?: WorldSandboxSnapshot;
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
  ): Promise<{
    success: boolean;
    persisted: boolean;
    reason?: string;
    // Whether the world has a map_sand.bin after this edit: a PanelBridge
    // older than #197 writes one on every live edit.
    worldSandboxSnapshot?: WorldSandboxSnapshot;
  }> => apiPut("/server-files/sandbox-option", { name, value }),

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

  // File browser (for image path fields). For a role without the host-path
  // capabilities, currentPath and parent are root references
  // ("data:/servertest") rather than absolute folders; both routes take
  // them back as `path`, so pass them on as they came.
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
  // File names of the .bak copies made in the config folder's backups/
  // folder (not their full paths since 1.4.6).
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
  // Only for an action that changes sandbox options live (setSandboxOption,
  // restoreUtilities, shutOffUtilities, runEventSequence) on a world with a
  // map_sand.bin (#197).
  worldSandboxSnapshot?: LiveWorldSandboxSnapshot;
}

// Server-side sendCommand() (server/services/panelBridge.js) gives up on a
// pending bridge command and deletes its own bookkeeping at commandTimeoutMs
// -- 15000ms normally, but 60000ms once a server is configured over SFTP
// (panelBridge.js:134/188/216). Whichever deadline fires first decides what
// the user sees: our own abort produces a generic, false "check your
// connection" (toApiError's AbortError branch); the SERVER'S OWN timeout
// produces an honest 504 naming the real actor ("no response from mod") that
// reaches the user via buildResponseError's payload.error. So this client
// timeout must sit comfortably ABOVE the WORST-CASE server-side ceiling
// (60000ms, the SFTP case) for every action whose Lua handler can plausibly
// run long -- not just above the common 15000ms local case, which today
// loses this race almost every time purely from network/routing latency
// even though both numbers are nominally equal. Raising this alone does not
// make the underlying work faster or wait longer in practice: the server
// still gives up at its own ceiling and answers with the honest failure at
// that point, this constant only ensures that answer is the one the user
// actually sees instead of our own earlier, misleading guess.
//
// 2026-09-09 (support-bundle-2026-09-08 follow-up): also applied to
// getVehiclesDetailed at every call site (ChunkCleaner.tsx, Debug.tsx,
// Events.tsx, WorldMap.tsx). Its per-vehicle cost is comparable to
// getAllSandboxOptions' per-option cost (a dozen-plus pcall'd Java
// accessors, several two-hop via an intermediate VehicleParts/
// LightbarSirenMode object), and unlike getSafehouses/getFactions (bounded
// by player-created claims, deliberately left on the shared default -- see
// that decision's own writeup) its item count is IsoCell:getVehicles(),
// which grows with world uptime and vehicle-mod content rather than player
// count. Real support-bundle evidence showed getSafehouses/getFactions
// hitting this same 15000ms ceiling too, but only 2 occurrences each
// against 11+ for getAllSandboxOptions -- consistent with those two riding
// along in the same per-tick command batch as a slow sibling command
// (PanelBridge.lua processes up to MAX_COMMANDS_PER_TICK=200 queued
// commands synchronously within one server tick), not their own handler
// cost. Raising their timeout too would not fix that contention, only wait
// longer to observe it.
export const BRIDGE_SLOW_ENUMERATION_TIMEOUT_MS = 75000;

// Panel Bridge API (for direct Lua mod communication)
// An SFTP host whose SSH host key the panel is refusing (server/services/
// sftpHostKeys.js): the pinned key (null when the saved keys could not be
// read) and the one the server presents now, both as SHA256:<base64>, the
// form `ssh-keygen -lf` prints.
export interface SftpHostKeyRefusal {
  host: string;
  port: number;
  pinned: string | null;
  presented: string;
  reason: "mismatch" | "store-unreadable" | "store-unavailable";
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
}

export const panelBridgeApi = {
  // Get bridge status
  getStatus: () =>
    apiGet("/panel-bridge/status") as Promise<{
      hostKeyRefusals?: SftpHostKeyRefusal[];
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
        // {key, params, text} -- resolve via t(`bridge.diagnostics.${key}`,
        // {ns: 'settings', ...params, defaultValue: text}), the same
        // key+defaultValue convention as capabilities.<key>.label. See
        // Settings.tsx's resolveBridgeDiagText() and Events.tsx's
        // checkBridgeStatus().
        // params may carry an age as a number (ageSeconds) beside its
        // English text (age) -- see lib/bridgeDiagnostics.ts.
        summary: { key: string; params?: Record<string, string | number>; text: string };
        issues: Array<{ key: string; params?: Record<string, string | number>; text: string }>;
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
      // Effective PanelBridge delivery for the active server. When it is
      // "workshop" the server nulls localInstall/remoteBridgeVersionCheck
      // (no loose file to compare). Absent is treated as "local".
      deliveryMethod?: import("./bridgeDeliveryTypes").DeliveryMethod;
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

  // "Trust new host key": pin exactly `fingerprint` (the key the server was
  // refused for, as the refusal reported it) for this host. The server
  // refuses with SFTP_HOST_KEY_NOT_PRESENTED if the host presents another
  // key by now.
  trustSftpHostKey: (target: { host: string; port: number | string; fingerprint: string }) =>
    apiPost("/panel-bridge/sftp/trust-host-key", target) as Promise<{
      success: boolean;
      host: string;
      port: number;
      fingerprint: string;
      previous: string | null;
      storeReset?: boolean;
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
    options?: { timeout?: number },
  ) =>
    apiPost<BridgeCommandResult<T>>(
      "/panel-bridge/command",
      { action, args },
      options,
    ),

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
        // mod predating that Lua change simply won't send it yet. The raw
        // game speed RCON's setTimeSpeed sets, 1 at normal speed; bridges
        // up to v1.7.70 sent the ~0.8 per-frame getMultiplier() instead.
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
  getLeaderboard: () =>
    apiGet("/panel-bridge/leaderboard") as Promise<{
      success: boolean;
      data: {
        players: Array<{
          id: string;
          username: string;
          displayName: string;
          online: boolean;
          currentKills: number;
          allTimeKills: number;
          currentDays: number;
          bestDays: number;
          deaths: number;
          favoriteWeapon?: string | null;
          favoriteWeaponKills: number;
          lastSeenAt?: number;
          // Bridges after 1.7.73: when kills and days were last read, and by
          // what; whether they ever were (older bridges kept no read time);
          // other names seen on the row; waiting for the next life.
          lastSampledAt?: number;
          lastSampleSource?: string;
          everRead?: boolean;
          aliases?: string[];
          awaitingNewLife?: boolean;
        }>;
        generatedAt?: number;
        trackingStartedAt?: number;
        diagnostics?: LeaderboardDiagnostics;
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

  // Auto-install mod to server's Lua folder (optionally specify serverId).
  // The server waits up to 10 s on the install (MANUAL_INSTALL_WAIT_MS in
  // routes/panelBridge.js) and then answers 504 PANELBRIDGE_INSTALL_STILL_RUNNING;
  // 30 s leaves room for the lookups around that wait on a slow disk, so
  // the operator gets that coded answer rather than a client-side timeout.
  installModAuto: (serverId?: string | number) =>
    apiPost("/panel-bridge/install-mod-auto", { serverId }, { timeout: 30000 }) as Promise<{
      success: boolean;
      message: string;
      path: string;
      serverName: string;
      error?: string;
    }>,

  // How PanelBridge reaches the active server: copied into its game folder
  // by the panel ("local") or downloaded from the Steam Workshop
  // ("workshop"). The server computes every field, including `state`;
  // shapes are the contract in lib/bridgeDeliveryTypes.ts.
  getDelivery: (serverId?: string | number) =>
    apiGet(
      `/panel-bridge/delivery${serverId != null ? `?serverId=${encodeURIComponent(String(serverId))}` : ""}`,
    ) as Promise<import("./bridgeDeliveryTypes").DeliveryStatus>,

  // Preview only: dryRun is forced on, so nothing on disk or in the
  // database changes.
  planDelivery: (body: {
    serverId: string;
    method: import("./bridgeDeliveryTypes").DeliveryMethod;
  }) =>
    apiPost("/panel-bridge/delivery", { ...body, dryRun: true }) as Promise<
      import("./bridgeDeliveryTypes").DeliveryPlanResponse
    >,

  // expectedFrom is the method the operator saw in the preview; the server
  // answers 409 PANELBRIDGE_DELIVERY_STALE instead of applying when it no
  // longer matches. POSTs are never transport-retried (fetchWithRetry), so
  // a timed-out apply can't silently run twice. 60 s rather than the 15 s
  // default: an apply installs, archives (copy + fsync) and rewrites every
  // group ini under one lock, which a slow disk or network share can take
  // past 15 s -- the client would then report a failure for a switch the
  // server went on to complete.
  applyDelivery: (body: {
    serverId: string;
    method: import("./bridgeDeliveryTypes").DeliveryMethod;
    expectedFrom: import("./bridgeDeliveryTypes").DeliveryMethod;
  }) =>
    apiPost("/panel-bridge/delivery", { ...body, dryRun: false }, { timeout: 60000 }) as Promise<
      import("./bridgeDeliveryTypes").DeliveryPlanResponse
    >,

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
  // The servers the schedule backs up; null: the active server alone.
  serverIds?: string[] | null;
}

// A restore as backupService.restoreBackup() records it (GH#166). `id` is
// the requestId the page that started it sent (a server-made one otherwise),
// which is how that page tells its own restore from another tab's.
export interface RestoreRecord {
  id: string;
  backupName: string;
  startedAt: string;
  // Whether it backs the replaced world up first. Both panel pages always
  // ask for that; an API caller may not.
  preRestoreBackup: boolean;
}

export interface RestoreOutcome extends RestoreRecord {
  finishedAt: string;
  success: boolean;
  // Why it failed, path-redacted like the POST's own response; null on success.
  message: string | null;
  duration: number | null;
}

export interface BackupStatus extends BackupSettings {
  backupInProgress: boolean;
  restoreInProgress: boolean;
  // The restore running right now (null when none is), and how the last
  // one since the panel started ended -- the outcome a page reads when the
  // POST that started a restore never answered it (a timeout, a dropped
  // connection, a reload, another tab). Optional: older servers don't send
  // them.
  currentRestore?: RestoreRecord | null;
  lastRestore?: RestoreOutcome | null;
  // The paths are null for a role that can't see host folders
  // (server/routes/backup.js).
  lastBackup: {
    name: string;
    path: string | null;
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
  lastScheduledBackupAttempt: ScheduledBackupAttempt | null;
  // continuous-bug-hunt round 28 (ux-proposals-need-backend-data): composed
  // at the route layer from the scheduler instance's own getBackupNextRun()
  // (server/routes/backup.js's GET /status) -- null whenever backups are
  // disabled (no schedule to compute a next run from).
  backupNextRun?: string | null;
  // Same route-layer composition: the scheduled restarts the saved schedule
  // keeps firing inside (those backups wait for the restart and run late),
  // empty when backups are off; and when a scheduled backup is waiting on a
  // restart right now, the moment it came due. Optional -- older servers
  // don't send them.
  restartOverlaps?: BackupRestartOverlap[];
  backupDeferredSince?: string | null;
}

// A Schedule History message the panel wrote as prose of its own (see
// server/database/init.js logScheduleExecution): rendered from
// backups:scheduledAttempt.<key> with these params, the English `message`
// being the fallback.
export type ScheduleMessageKey = 'restartStuck' | 'restartStuckSinceDue';
export type ScheduleMessageParams = Record<string, string | number>;

export interface ScheduledBackupAttempt {
  success: boolean;
  message: string | null;
  // Set for a backup given up on because a restart looked stuck; null for a
  // raw error. Optional -- older servers don't send it.
  messageKey?: ScheduleMessageKey | null;
  messageParams?: ScheduleMessageParams | null;
  executedAt: string;
  // 'restart' for the old "Skipped: a restart was in progress" rows panels
  // up to v1.3.8 wrote -- a skip, not a backup that broke. Current servers
  // hold such a backup until the restart ends instead of skipping it.
  skipReason?: 'restart' | null;
  // Set when a backup (manual or scheduled) succeeded AFTER this failed
  // attempt -- the failure no longer leaves the world without a fresh backup.
  recoveredAt?: string | null;
}

// A scheduled restart the backup schedule collides with (server/utils/
// backupRestartOverlap.js). Times are "HH:MM" in the scheduler's timezone:
// the first restart fire time with a backup inside it, and that backup --
// an example, not the whole set: `allBackups` says whether every backup
// collides. `windowMinutes` is how long after a restart's start time a
// backup still lands inside it. `name` and `cron` are null for a caller
// without automation.manage (the Scheduler's own gate on task details).
// `timezone` names that scheduler timezone, so a page can label the times
// -- optional: older servers don't send it.
export interface BackupRestartOverlap {
  kind: 'task' | 'autoRestart';
  name: string | null;
  cron: string | null;
  restartTime: string;
  backupTime: string;
  timezone?: string;
  allBackups: boolean;
  windowMinutes: number;
}

export type BackupScheduleValidation =
  | {
      valid: true;
      nextRun: string | null;
      // Both the day-of-month and the weekday are restricted ("0 4 1 * 1"):
      // node-cron runs it only on days matching BOTH, not either as in
      // classic cron. Absent from a server older than 1.4.0.
      bothDayFieldsRestricted?: boolean;
      timezone: string;
      restartOverlaps: BackupRestartOverlap[];
    }
  | { valid: false; error?: string; code?: string };

// backup.js/backupService.js's own shape (full .zip server backups --
// listBackups()/createBackup() in backupService.js) -- distinct from
// server-files/backups' config-file .bak backups above (ConfigBackupFile).
// See that interface's comment for why these have separate names now.
export interface ServerBackupArchive {
  name: string;
  // null for a role that can't see host folders (server/routes/backup.js).
  path: string | null;
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
  // Each server's newest backup and count, and whom the schedule covers.
  getSummary: (): Promise<{
    servers: Array<{ serverId: string; lastBackupAt: string | null; count: number }>;
    schedule: { enabled: boolean; serverIds: string[] | null };
  }> => apiGet("/backup/summary"),

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

  // Update backup settings.
  // expectedServerId: the active server's own id captured when the caller
  // last loaded its backup settings (null if none was active then). Lets
  // the server refuse the write with 409 BACKUP_ACTIVE_SERVER_CHANGED if
  // the active server moved out from under it in the meantime -- optional
  // and omitted entirely (not sent as null) when a caller doesn't pass it,
  // so an older/unrelated caller keeps today's unchecked behavior. Mirrors
  // chunks.js's own expectedServerId convention; see server/routes/
  // backup.js's POST /settings for the exact match rule.
  updateSettings: (
    settings: Partial<BackupSettings>,
    expectedServerId?: string | number | null,
  ): Promise<{ success: boolean; settings: BackupSettings }> =>
    apiPost(
      "/backup/settings",
      expectedServerId !== undefined ? { ...settings, expectedServerId } : settings,
    ),

  // Live preview of a backup schedule (preset or custom cron): the same
  // verdict POST /backup/settings applies, plus next run and the scheduled
  // restarts it would land inside. Advisory -- saving re-validates.
  validateSchedule: (schedule: string): Promise<BackupScheduleValidation> =>
    apiPost("/backup/validate-schedule", { schedule }),

  // Create a manual backup. POST /backup/create awaits the full archive
  // (server/routes/backup.js -> backupService.createBackup()) before
  // responding -- socket `backup:progress` events give the UI live
  // feedback, but the HTTP request itself stays open for the whole walk +
  // zip of the save directory. Same held-open-request shape as
  // panelUpdateApi.download; a big/modded world can easily exceed the
  // generic 15s default. It takes no options: whether the panel database
  // goes in (as a redacted copy) is the stored backup setting's decision.
  createBackup: (): Promise<{
    success: boolean;
    backup?: ServerBackupArchive;
    duration?: number;
    message?: string;
  }> => apiPost("/backup/create", {}, { timeout: 10 * 60 * 1000 }),

  // Delete a backup
  deleteBackup: (
    name: string,
  ): Promise<{ success: boolean; message?: string }> =>
    fetchWithRetry(`${API_BASE}/backup/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }).then((response) =>
      handleResponse<{ success: boolean; message?: string }>(response),
    ),

  // Restore a backup. Same held-open shape as createBackup above --
  // POST /backup/restore/:name awaits backupService.restoreBackup()
  // (extract + swap the save directory, plus its own pre-restore safety
  // backup) before responding. Pages go through restoreBackupAndConfirm()
  // (lib/restoreOutcome.ts), which reads the outcome back from the status
  // when this response never arrives; `requestId` is what it matches on.
  restoreBackup: (
    name: string,
    options?: { createPreRestoreBackup?: boolean; requestId?: string },
  ): Promise<{
    success: boolean;
    message?: string;
    duration?: number;
  }> =>
    apiPost(
      `/backup/restore/${encodeURIComponent(name)}`,
      options || {},
      { timeout: 10 * 60 * 1000 },
    ),

  // Delete backups older than X days.
  // expectedServerId: same contract as updateSettings above -- omitted
  // entirely when not passed, otherwise lets the server refuse with 409
  // BACKUP_ACTIVE_SERVER_CHANGED if the active server moved since the
  // caller loaded the list it's pruning by age.
  deleteOlderThan: (
    days: number,
    expectedServerId?: string | number | null,
  ): Promise<{
    success: boolean;
    deleted?: number;
    failed?: number;
    deletedNames?: string[];
    message?: string;
  }> =>
    apiPost(
      "/backup/delete-older-than",
      expectedServerId !== undefined ? { days, expectedServerId } : { days },
    ),

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
    // bug-hunt-2026-09-06 (client silent-failure lane, lib/ pass): raw XHR
    // gets none of fetchWithRetry's protections for free, and this one was
    // missing one more than the 401-replay above -- no timeout at all. If
    // the connection is accepted but the server (or a proxy) never
    // responds, none of onload/onerror/onabort ever fires, this Promise
    // never settles, and the caller's await hangs forever: upload button
    // stuck disabled, percent frozen, zero error, indefinitely. Same
    // "nobody's listening for the outcome" shape as the Servers.tsx/
    // ServerSetup.tsx socket watchdogs, on a raw XHR instead of a socket.
    //
    // Unlike those cases, an aborted upload here is safe to report as a
    // genuine failure rather than an honest "may still be running": the
    // server streams straight to a .tmp file in lockstep with the request
    // body (server/routes/backup.js's streamUploadToFile) with no
    // decoupled background job, so an aborted connection means the
    // server-side write stops too and cleans up -- there is no SteamCMD-
    // style child process still working after the client walks away.
    const STALL_MS = 3 * 60 * 1000;
    const sendOnce = (
      token: string | null,
    ): Promise<{ status: number; payload: any }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE}/backup/upload`, true);
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.setRequestHeader("Content-Type", "application/zip");
        xhr.setRequestHeader("X-Backup-Filename", file.name);
        let lastActivity = Date.now();
        let timedOut = false;
        xhr.upload.onprogress = (e) => {
          lastActivity = Date.now();
          if (onProgress && e.lengthComputable)
            onProgress(Math.round((e.loaded / e.total) * 100));
        };
        const stallCheck = setInterval(() => {
          if (Date.now() - lastActivity >= STALL_MS) {
            timedOut = true;
            xhr.abort();
          }
        }, 15000);
        xhr.onload = () => {
          clearInterval(stallCheck);
          let payload: any = null;
          try {
            payload = JSON.parse(xhr.responseText);
          } catch {
            /* non-JSON */
          }
          resolve({ status: xhr.status, payload });
        };
        xhr.onerror = () => {
          clearInterval(stallCheck);
          reject(new Error("Network error during upload"));
        };
        xhr.onabort = () => {
          clearInterval(stallCheck);
          reject(
            timedOut
              ? new Error(
                  "The upload stalled with no response from the server and was cancelled. Check your connection and try again.",
                )
              : new Error("Upload aborted"),
          );
        };
        xhr.send(file);
      });

    const firstToken = getAuthToken();
    let { status, payload } = await sendOnce(firstToken);
    if (isRefreshableAuthFailure(status, payload?.code, firstToken !== null)) {
      const refreshed = await tryRefreshToken();
      if (refreshed) {
        ({ status, payload } = await sendOnce(getAuthToken()));
      } else {
        window.location.reload();
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
  // "Problems found": the latest game log and the panel's own errors as
  // findings with their fixes (server/utils/serverErrorFinder.js).
  getProblems: (): Promise<ServerProblemsResult> => apiGet("/debug/problems"),
};

export type ServerProblemSeverity = "critical" | "warning" | "info";
export type ServerProblemCategory = "mods" | "server" | "network" | "panel";
export type ServerProblemKind =
  | "luaError"
  | "luaFileError"
  | "modRequiredMissing"
  | "modInfoMissing"
  | "workshopDownload"
  | "workshopOutdated"
  | "steamUnreachable"
  | "steamOff"
  | "portInUse"
  | "rconPortInUse"
  | "rconAuth"
  | "outOfMemory"
  | "chunkLoad"
  | "startupCrash"
  | "javaException"
  | "other"
  | "panelBridge"
  | "panelError"
  | "processScanFailing";

export type ServerProblemFix =
  | {
      id: string;
      type: "action";
      action: "disableMod" | "modsHealthFix" | "raiseMemory" | "restartServer" | "startServer";
      params: Record<string, unknown>;
      capability: string;
      safe: boolean;
      confirm: boolean;
      undo: boolean;
      restartNeeded?: boolean;
    }
  | { id: string; type: "link"; to: string; safe: false; confirm: false; undo: false };

export interface ServerProblem {
  // Stable while the problem is the same (its kind and what it is about).
  id: string;
  kind: ServerProblemKind;
  category: ServerProblemCategory;
  severity: ServerProblemSeverity;
  source: "game" | "panel";
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  // False: lastSeen is the log's last write, not the line's own time.
  timesFromLog: boolean;
  message: string | null;
  cause: string;
  modId: string | null;
  workshopId: string | null;
  mod: { id: string; name: string; workshopId: string | null; enabled: boolean } | null;
  params: Record<string, unknown>;
  samples: string[];
  fixes: ServerProblemFix[];
}

export interface ServerProblemsResult {
  scannedAt: string;
  server: { id: number | string | null; name: string | null; running: boolean | null } | null;
  counts: { critical: number; warning: number; info: number; total: number };
  findings: ServerProblem[];
  checked: {
    gameLogLines: number;
    serverStarted: boolean;
    panelErrors: number;
    mods: number;
    hiddenFindings: number;
    modList: boolean;
    gameLog: { found: boolean; file: string | null; modified: string | null; partial: boolean; bytes: number; reason?: string };
  };
}

// Auth API
export const authApi = {
  // SECURITY (2026-10-05, A1): both of these retire this browser's
  // trusted-device token with every other one and hand back a fresh one --
  // see lib/trustedDevice.ts's rememberTrustedDeviceFrom().
  changePassword: async (
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean; message?: string }> => {
    const result = await apiPost("/auth/change-password", { currentPassword, newPassword });
    rememberTrustedDeviceFrom(result);
    return result;
  },

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

  regenerateJwtSecret: async (): Promise<{ success: boolean; message?: string }> => {
    const result = await apiPost("/auth/regenerate-jwt-secret", {});
    rememberTrustedDeviceFrom(result);
    return result;
  },

  // Ends every session of the caller's own account, this browser included.
  revokeAllSessions: (): Promise<{ success: boolean }> =>
    apiPost("/auth/sessions/revoke-all", {}),
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
  // confirmShared: the dialog listed the other profiles that use the same
  // game folder (the server refuses with DELETE_FILES_FOLDER_SHARED without
  // it when there are any).
  deleteFiles: (path: string, options?: { confirmShared?: boolean }): Promise<unknown> =>
    apiPost("/server/delete-files", {
      path,
      confirm: true,
      ...(options?.confirmShared ? { confirmShared: true } : {}),
    }),
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
  // Set on every checkForUpdates() failure path, cleared on any check that
  // reaches a real answer -- see updateChecker.js's own comment. Paired with
  // updateAvailable (which is written ONLY on success, so it retains the
  // last real result across a later failure) to derive three states without
  // a fourth field: updateAvailable === null -> never succeeded;
  // updateAvailable !== null && lastError !== null -> succeeded, then a
  // later attempt failed (keep showing the stale-but-real result);
  // updateAvailable !== null && lastError === null -> succeeded cleanly.
  lastError: string | null;
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
    | "powershell_unavailable"
    | "startup_handshake_failed"
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
    // true = confirmed renameable, false = confirmed denied (blocks the
    // update), null = could not verify (probe unavailable/blocked -- never
    // treated as a denial). Windows-only; always undefined/null elsewhere.
    exeDeleteAccess?: boolean | null;
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
  // POST /panel/update-download awaits the FULL binary + client-dist archive
  // download (server/index.js's handlePanelUpdateDownload -> checker.
  // downloadUpdate()) before responding at all -- there is no "kicked off,
  // poll for completion" split the way restart/apply has. The default 15s
  // fetchWithRetry timeout is sized for a normal API call, not a real
  // multi-file network transfer; on a slow connection it fires while the
  // server is still legitimately downloading, aborts the client's view of
  // the request, and surfaces a false "Download failed" even though the
  // server keeps going and stages the update successfully moments later
  // (the next click then hits the server's own "already downloading" guard
  // instead of a clean retry). Matches this codebase's STALL_MS convention
  // (Servers.tsx/ServerSetup.tsx/chunksApi) for genuinely long operations.
  download: (confirm: boolean = false): Promise<PanelUpdateActionResult> =>
    apiPost("/panel/update-download", { confirm }, { timeout: 5 * 60 * 1000 }),
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
  // false means the server couldn't verify this reading right now
  // (unreachable mount, permission error, no path configured) -- warning
  // and critical are both forced false on that path (see diskMonitor.js's
  // computeDiskStatus()), NOT a verified "everything is fine". Callers
  // must not treat that as a real all-clear.
  ok: boolean;
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
  // The host's temp folder; null for a role without diagnostics.manage or
  // panel.settings (server/routes/system.js).
  temporaryDirectory: string | null;
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
// One linked SSO identity, as GET /auth/users lists it. The server masks the
// subject (at most its last four characters show).
export interface ManagedUserIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  linkedAt: string | null;
}

export interface ManagedUserAccount {
  id: string;
  username: string;
  role: string;
  roleId: string | null;
  createdAt: string;
  lastLogin: string | null;
  externalIdentities?: ManagedUserIdentity[];
}

export const usersApi = {
  list: (): Promise<{ users: ManagedUserAccount[] }> => apiGet("/auth/users"),

  create: (data: {
    username: string;
    password: string;
    role: "admin" | "technician" | "moderator";
  }): Promise<{ success: boolean; user: ManagedUserAccount }> =>
    apiPost("/auth/users", data),

  startExternalIdentityLink: (userId: string): Promise<{ authorizationUrl: string }> =>
    apiPost("/auth/oidc/link", { userId }),

  // Removes every SSO identity linked to the account and signs it out
  // everywhere (admin only).
  unlinkExternalIdentities: (
    userId: string,
  ): Promise<{ success: boolean; user: { id: string; username: string }; removed: number }> =>
    apiDelete(`/auth/users/${encodeURIComponent(userId)}/identities`),

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

  // Signs another account out of every browser and device, without touching
  // its password or role (users.manage).
  revokeSessions: (
    userId: string,
  ): Promise<{ success: boolean; user: { id: string; username: string } }> =>
    apiPost(`/auth/users/${encodeURIComponent(userId)}/sessions/revoke`, {}),
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
  // false for a non-admin with panel.settings: the issuer, client, secret,
  // redirect URI and plain-HTTP switch are admin-only.
  providerFieldsEditable?: boolean;
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
