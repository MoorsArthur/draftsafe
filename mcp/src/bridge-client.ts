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

const UNAVAILABLE =
  "Cannot reach Thunderbird. Make sure Thunderbird is running and the Draftsafe add-on is installed and enabled.";

export class BridgeClient implements BridgeCaller {
  private conn: ConnectionInfo | null = null;
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
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });
  }

  async call<T = unknown>(route: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response | null = null;
    // Two attempts: the second re-reads the connection file, which changes
    // whenever Thunderbird restarts (new port and token). Retrying is safe
    // because a refused connection or a 401 never reached a route handler.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.conn || attempt > 0) {
        this.conn = await this.loadConnection();
      }
      try {
        res = await this.post(this.conn, route, params);
      } catch (e) {
        const name = (e as Error)?.name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new BridgeError("Thunderbird did not answer in time.", "timeout");
        }
        res = null;
        // Only a refused connection is safe to retry: the request provably
        // never reached Thunderbird. A reset mid-request might have run a
        // mutation (e.g. created a draft), so it is reported, not retried.
        const code = ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) || "";
        if (attempt === 0 && code === "ECONNREFUSED") continue;
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
    let payload: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      throw new BridgeError(`Bridge returned HTTP ${res.status} without a JSON body.`, "bad_response", res.status);
    }
    if (!res.ok || !payload.ok) {
      const code = payload.error?.code ?? "error";
      const message = payload.error?.message ?? `HTTP ${res.status}`;
      throw new BridgeError(message, code, res.status);
    }
    return payload.result as T;
  }
}
