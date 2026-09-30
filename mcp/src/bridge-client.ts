// SPDX-License-Identifier: MIT
// HTTP client for the add-on's loopback bridge.

import { readConnection, type ConnectionInfo } from "./connection.js";

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export interface BridgeCaller {
  call<T = unknown>(route: string, params?: Record<string, unknown>): Promise<T>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BridgeClientOptions {
  loadConnection?: () => Promise<ConnectionInfo>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  verifyProtocol?: boolean;
}

const UNAVAILABLE = "Draftsafe Bridge is not reachable at the published connection address.";
const READ_TIMEOUT_MS = 90_000;
const APPROVAL_ROUTES = new Set(["requests.cleanup", "requests.unsubscribe", "requests.folders", "messages.setTags", "messages.markRead", "followups.set", "drafts.create"]);
const COMPOSE_ROUTES = new Set(["compose.openForReview", "compose.updateForReview", "compose.closeForReview"]);

function atLeast(version: string | null, major: number, minor: number): boolean {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [foundMajor, foundMinor] = version.split(".").map(Number);
  return foundMajor > major || (foundMajor === major && foundMinor >= minor);
}

export class BridgeClient implements BridgeCaller {
  private readonly loadConnection: () => Promise<ConnectionInfo>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly verifyProtocol: boolean;
  private compatibleToken: string | null = null;
  private compatibleVersion: string | null = null;

  constructor(opts: BridgeClientOptions = {}) {
    this.loadConnection = opts.loadConnection ?? (() => readConnection());
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 730_000;
    this.verifyProtocol = opts.verifyProtocol ?? true;
  }

  private async post(conn: ConnectionInfo, route: string, params: Record<string, unknown>): Promise<Response> {
    // Host is derived from the URL (127.0.0.1:<port>); fetch sends no Origin.
    return this.fetchImpl(`http://127.0.0.1:${conn.port}/v1/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${conn.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(COMPOSE_ROUTES.has(route) ? Math.min(this.timeoutMs, 30_000)
        : route.startsWith("requests.") || APPROVAL_ROUTES.has(route)
          ? Math.min(this.timeoutMs, 15_000)
          : Math.min(this.timeoutMs, READ_TIMEOUT_MS)),
      redirect: "error",
    });
  }

  private async callOnce<T = unknown>(route: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response | null = null;
    let responseToken: string | null = null;
    // Two attempts: the second re-reads the connection file, which changes
    // whenever Thunderbird restarts (new port and token). Retrying is safe
    // because a refused connection or a 401 never reached a route handler.
    for (let attempt = 0; attempt < 2; attempt++) {
      // The record is small and Thunderbird replaces it on every start. Read
      // it for every call, including approval polls, so an old live port or
      // keep-alive socket cannot pin a long-lived MCP process to a past run.
      const conn = await this.loadConnection();
      try {
        if (this.verifyProtocol && route !== "health" && this.compatibleToken !== conn.token) {
          // Check once per Thunderbird start. The token changes on every
          // restart, so a long-lived MCP process checks the new add-on too.
          await this.callOnce("health");
        }
        if (this.verifyProtocol && this.compatibleToken === conn.token &&
            this.compatibleVersion?.startsWith("0.6.") &&
            (route === "compose.listForReview" ||
              route === "compose.closeForReview" ||
              (route === "compose.updateForReview" && params.tabId === undefined) ||
              (route === "compose.openForReview" && params.newWindow !== undefined)))
          throw new BridgeError("This compose feature needs Draftsafe add-on 0.7.0 or newer. Update the add-on and restart Thunderbird.", "update_required");
        if (this.verifyProtocol && this.compatibleToken === conn.token &&
            !atLeast(this.compatibleVersion, 0, 8) &&
            (route === "recipients.find" || (route === "messages.search" && params.fast === true)))
          throw new BridgeError("This search feature needs Draftsafe add-on 0.8.0 or newer. Update the add-on and restart Thunderbird.", "update_required");
        res = await this.post(conn, route, params);
        responseToken = conn.token;
      } catch (e) {
        if (e instanceof BridgeError) throw e;
        const name = (e as Error)?.name;
        const code = ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) || "";
        if (attempt === 0 && code === "ECONNREFUSED") continue;
        if (route === "requests.status" && attempt === 0) continue;
        if (route === "requests.status") throw new BridgeError("Approval status could not be confirmed; check Thunderbird history.", "approval_interrupted");
        if (COMPOSE_ROUTES.has(route)) throw new BridgeError("Thunderbird may have changed the composer; inspect its windows before retrying.", "compose_unknown");
        if (APPROVAL_ROUTES.has(route)) throw new BridgeError("Could not confirm whether Tools received the request; check approval history.", "delivery_unknown");
        if (name === "TimeoutError" || name === "AbortError" ||
            ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"].includes(code)) {
          throw new BridgeError("Thunderbird did not finish the read in time.", "read_timeout");
        }
        res = null;
        // Only a refused connection is safe to retry: the request provably
        // never reached Thunderbird. A reset mid-request might have run a
        // mutation (e.g. created a draft), so it is reported, not retried.
        throw new BridgeError(code === "ECONNREFUSED" ? UNAVAILABLE : `${UNAVAILABLE} (${code || name})`, "unavailable");
      }
      if (res.status === 401 && attempt === 0) {
        continue;
      }
      break;
    }
    if (!res) {
      throw new BridgeError(UNAVAILABLE, "unavailable");
    }
    if (res.status === 401) {
      throw new BridgeError("The published Bridge connection was rejected after re-reading it.", "stale_connection", 401);
    }
    let payload: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      throw new BridgeError(`Bridge returned HTTP ${res.status} without a JSON body.`, "bad_response", res.status);
    }
    if (!res.ok || !payload.ok) {
      const code = payload.error?.code ?? "error";
      const message = payload.error?.message ?? `HTTP ${res.status}`;
      throw new BridgeError(message, code === "timeout" && !APPROVAL_ROUTES.has(route) ? "read_timeout" : code, res.status);
    }
    if (this.verifyProtocol && route === "health") {
      const health = payload.result as { version?: unknown; protocol?: unknown } | null;
      // 0.6.0 predates the protocol field but implements protocol 1. Older
      // builds lack the current compose and attachment routes.
      const legacy = typeof health?.version === "string" && /^0\.6\.[0-9]+$/.test(health.version);
      if (health?.protocol !== 1 && !(health?.protocol === undefined && legacy)) {
        throw new BridgeError("Draftsafe add-on and MCP server use incompatible bridge protocols. Update both components.", "update_required");
      }
      this.compatibleToken = responseToken;
      this.compatibleVersion = typeof health?.version === "string" ? health.version : null;
    }
    return payload.result as T;
  }

  async call<T = unknown>(route: string, params: Record<string, unknown> = {}): Promise<T> {
    const deadline = Date.now() + 11 * 60 * 1000;
    const initial = await this.callOnce<T | { requestId: string }>(route, params);
    if (!APPROVAL_ROUTES.has(route)) return initial as T;
    if (!initial || typeof initial !== "object" || !("requestId" in initial) ||
        typeof initial.requestId !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(initial.requestId)) return initial as T;
    let lastStatus = "pending";
    for (;;) {
      if (Date.now() >= deadline) throw new BridgeError(
        lastStatus === "planning" ? "Tools is still preparing the approval request." : "Approval timed out. Check Thunderbird history before retrying.",
        lastStatus === "planning" ? "planning" : "timeout"
      );
      const state = await this.callOnce<{ status: string; outcome?: T }>("requests.status", { requestId: initial.requestId });
      if (state.status === "done") return state.outcome as T;
      if (state.status !== "planning" && state.status !== "pending") throw new BridgeError("Approval status was invalid.", "approval_interrupted");
      lastStatus = state.status;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
