// SPDX-License-Identifier: MIT
// Handles one framed HTTP request from the experiment and returns
// {status, body}. Runs in the unprivileged background page.
//
// Order of checks (cheapest and most security-relevant first):
//   1. Host header must be 127.0.0.1:<port> or localhost:<port>  (DNS rebinding)
//   2. No Origin / Referer header at all                          (browser requests)
//   3. Bearer token, constant-time comparison                     (auth)
//   4. POST only, /v1/<route> from the fixed route table           (surface)
//   5. application/json, UTF-8, JSON object body                  (input)
// Body size is already capped by the experiment before we see it.
//
// Resource bounds (independent of sockets, which the experiment bounds):
//   - at most MAX_IN_FLIGHT route handlers run at once; a permit is held until
//     the handler's promise settles, not until the socket times out, so
//     timed-out requests cannot pile up work;
//   - each handler gets a deadline and stops between steps once it passes;
//   - responses larger than MAX_RESPONSE_BYTES are replaced by an error.
// Internal errors are reported with a fixed text: exception messages can
// contain mailbox-derived strings and are only logged locally.

import { allowedHosts, timingSafeEqual } from "./security.js";
import { BridgeError, createDeadline } from "./validate.js";

export const MAX_IN_FLIGHT = 4;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // keep equal to framing.js LIMITS.maxResponseBytes
export const HANDLER_BUDGET_MS = 80 * 1000; // below framing.js LIMITS.handlerTimeoutMs (90 s)

const ROUTE_RE = /^\/v1\/([a-z][A-Za-z]{0,30}(?:\.[a-z][A-Za-z]{0,30})?)$/;

function json(status, payload) {
  return { status, body: JSON.stringify(payload) };
}

function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } });
}

function decodeBody(binary) {
  if (!binary) {
    return {};
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.trim()) {
    return {};
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeError("bad_request", "body must be a JSON object");
  }
  return value;
}

/**
 * @param {object} deps
 * @param {() => ({port: number, token: string} | null)} deps.getSecrets
 * @param {Record<string, (params: object) => Promise<unknown>>} deps.routes
 */
export function createRequestHandler({ getSecrets, routes, now = () => Date.now() }) {
  let inFlight = 0;

  function respond(payload) {
    const body = JSON.stringify(payload);
    // UTF-8 length without allocating: at most 3 bytes per UTF-16 unit.
    if (body.length * 3 > MAX_RESPONSE_BYTES && new TextEncoder().encode(body).length > MAX_RESPONSE_BYTES) {
      return fail(500, "result_too_large", "the result is too large; ask for fewer messages or a smaller body limit");
    }
    return { status: 200, body };
  }

  return async function handle(req) {
    const secrets = getSecrets();
    if (!secrets) {
      return fail(503, "not_ready", "bridge is starting");
    }
    const headers = (req && req.headers) || {};

    const host = headers.host;
    if (typeof host !== "string" || !allowedHosts(secrets.port).includes(host.toLowerCase())) {
      return fail(403, "bad_host", "Host header must be 127.0.0.1:<port> or localhost:<port>");
    }
    if ("origin" in headers || "referer" in headers) {
      return fail(403, "browser_request", "requests carrying Origin or Referer are refused");
    }
    const auth = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(headers.authorization || "");
    if (!auth || !timingSafeEqual(auth[1], secrets.token)) {
      return fail(401, "unauthorized", "missing or invalid bearer token");
    }
    if (req.method !== "POST") {
      return fail(405, "method_not_allowed", "use POST");
    }
    const m = ROUTE_RE.exec(req.target || "");
    const name = m && m[1];
    if (!name || !Object.prototype.hasOwnProperty.call(routes, name)) {
      return fail(404, "unknown_route", "no such endpoint");
    }
    const type = (headers["content-type"] || "").toLowerCase();
    if (!/^application\/json(\s*;\s*charset=utf-8)?$/.test(type)) {
      return fail(415, "unsupported_media_type", "Content-Type must be application/json");
    }

    let params;
    try {
      params = decodeBody(req.body);
    } catch (e) {
      return fail(400, "bad_request", e instanceof BridgeError ? e.message : "body is not valid UTF-8 JSON");
    }

    if (inFlight >= MAX_IN_FLIGHT) {
      return fail(503, "busy", "too many requests in progress; try again shortly");
    }
    inFlight++;
    try {
      const result = await routes[name](params, createDeadline(HANDLER_BUDGET_MS, now));
      return respond({ ok: true, result });
    } catch (e) {
      if (e instanceof BridgeError) {
        return fail(e.status, e.code, e.message);
      }
      console.error(`draftsafe: route ${name} failed`, e);
      return fail(500, "internal", "Thunderbird reported an error; see the Thunderbird error console for details");
    } finally {
      inFlight--;
    }
  };
}
