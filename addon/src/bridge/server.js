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

import { allowedHosts, timingSafeEqual } from "./security.js";
import { BridgeError } from "./validate.js";

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
export function createRequestHandler({ getSecrets, routes }) {
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

    try {
      const result = await routes[name](params);
      return json(200, { ok: true, result });
    } catch (e) {
      if (e instanceof BridgeError) {
        return fail(e.status, e.code, e.message);
      }
      console.error(`draftsafe: route ${name} failed`, e);
      return fail(500, "internal", String((e && e.message) || e).slice(0, 500));
    }
  };
}
