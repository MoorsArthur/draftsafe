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
}

const UNAVAILABLE = "Draftsafe Bridge is not reachable at the published connection address.";
const READ_TIMEOUT_MS = 90_000;
const APPROVAL_ROUTES = new Set(["requests.cleanup", "requests.unsubscribe", "requests.folders", "messages.setTags", "messages.markRead", "followups.set", "drafts.create"]);
const COMPOSE_ROUTE = "compose.openForReview";

export class BridgeClient implements BridgeCaller {
  private readonly loadConnection: () => Promise<ConnectionInfo>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: BridgeClientOptions = {}) {
    this.loadConnection = opts.loadConnection ?? (() => readConnection());
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 730_000;
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
      signal: AbortSignal.timeout(route === COMPOSE_ROUTE ? Math.min(this.timeoutMs, 30_000)
        : route.startsWith("requests.") || APPROVAL_ROUTES.has(route)
          ? Math.min(this.timeoutMs, 15_000)
          : Math.min(this.timeoutMs, READ_TIMEOUT_MS)),
      redirect: "error",
    });
  }

  private async callOnce<T = unknown>(route: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response | null = null;
    // Two attempts: the second re-reads the connection file, which changes
    // whenever Thunderbird restarts (new port and token). Retrying is safe
    // because a refused connection or a 401 never reached a route handler.
    for (let attempt = 0; attempt < 2; attempt++) {
      // The record is small and Thunderbird replaces it on every start. Read
      // it for every call, including approval polls, so an old live port or
      // keep-alive socket cannot pin a long-lived MCP process to a past run.
      const conn = await this.loadConnection();
      try {
        res = await this.post(conn, route, params);
      } catch (e) {
        const name = (e as Error)?.name;
        const code = ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) || "";
        if (attempt === 0 && code === "ECONNREFUSED") continue;
        if (route === "requests.status" && attempt === 0) continue;
        if (route === "requests.status") throw new BridgeError("Approval status could not be confirmed; check Thunderbird history.", "approval_interrupted");
        if (route === COMPOSE_ROUTE) throw new BridgeError("Thunderbird may have opened the message; check its compose windows before retrying.", "compose_unknown");
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
