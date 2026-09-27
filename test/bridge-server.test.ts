import { describe, expect, it, vi } from "vitest";
import { createRequestHandler } from "../addon/src/bridge/server.js";
import { generateToken, timingSafeEqual } from "../addon/src/bridge/security.js";
import { BridgeError } from "../addon/src/bridge/validate.js";

const PORT = 45123;
const TOKEN = generateToken();

function setup(routes: Record<string, (p: any) => Promise<unknown>> = {}) {
  const all = {
    health: vi.fn(async () => ({ status: "ok" })),
    "messages.get": vi.fn(async (p: any) => ({ echo: p })),
    ...routes,
  };
  const handle = createRequestHandler({ getSecrets: () => ({ port: PORT, token: TOKEN }), routes: all });
  return { handle, routes: all };
}

function request(over: { method?: string; target?: string; headers?: Record<string, string | undefined>; body?: string } = {}) {
  const headers: Record<string, string> = {};
  const base: Record<string, string | undefined> = {
    host: `127.0.0.1:${PORT}`,
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    ...over.headers,
  };
  for (const [k, v] of Object.entries(base)) if (v !== undefined) headers[k] = v;
  return { method: over.method ?? "POST", target: over.target ?? "/v1/health", headers, body: over.body ?? "{}", port: PORT };
}

const parse = (r: { status: number; body: string }) => ({ status: r.status, json: JSON.parse(r.body) });

describe("security primitives", () => {
  it("generates 43-char base64url tokens from 32 random bytes", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(t);
  });

  it("timingSafeEqual compares correctly", () => {
    expect(timingSafeEqual(TOKEN, TOKEN)).toBe(true);
    expect(timingSafeEqual(TOKEN.slice(0, -1) + (TOKEN.endsWith("A") ? "B" : "A"), TOKEN)).toBe(false);
    expect(timingSafeEqual(TOKEN.slice(0, 10), TOKEN)).toBe(false);
    expect(timingSafeEqual(TOKEN + "x", TOKEN)).toBe(false);
    expect(timingSafeEqual("", TOKEN)).toBe(false);
    expect(timingSafeEqual(TOKEN, "")).toBe(false);
    expect(timingSafeEqual(undefined as unknown as string, TOKEN)).toBe(false);
  });
});

describe("bridge request validation (addon/src/bridge/server.js)", () => {
  it("serves an authenticated, well-formed request", async () => {
    const { handle } = setup();
    const r = parse(await handle(request()));
    expect(r).toEqual({ status: 200, json: { ok: true, result: { status: "ok" } } });
  });

  it("accepts localhost:<port> as Host", async () => {
    const { handle } = setup();
    expect((await handle(request({ headers: { host: `localhost:${PORT}` } }))).status).toBe(200);
  });

  it.each([
    ["missing", undefined],
    ["foreign domain (DNS rebinding)", `evil.example:${PORT}`],
    ["rebinding domain resolving to loopback", `127.0.0.1.nip.io:${PORT}`],
    ["wrong port", `127.0.0.1:${PORT + 1}`],
    ["no port", "127.0.0.1"],
    ["IPv6 loopback", `[::1]:${PORT}`],
  ])("rejects Host %s with 403 before auth", async (_, host) => {
    const { handle, routes } = setup();
    const r = parse(await handle(request({ headers: { host } })));
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("bad_host");
    expect(routes.health).not.toHaveBeenCalled();
  });

  it.each([
    ["Origin", { origin: "https://evil.example" }],
    ["Origin null", { origin: "null" }],
    ["Origin from loopback", { origin: `http://127.0.0.1:${PORT}` }],
    ["Referer", { referer: "https://evil.example/page" }],
  ])("rejects any request carrying %s, even with a valid token", async (_, headers) => {
    const { handle, routes } = setup();
    const r = parse(await handle(request({ headers })));
    expect(r.status).toBe(403);
    expect(routes.health).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["wrong token", `Bearer ${generateToken()}`],
    ["truncated token", `Bearer ${TOKEN.slice(0, 20)}`],
    ["wrong scheme", `Basic ${TOKEN}`],
    ["lowercase scheme", `bearer ${TOKEN}`],
    ["trailing garbage", `Bearer ${TOKEN} x`],
  ])("rejects %s authorization with 401", async (_, authorization) => {
    const { handle, routes } = setup();
    const r = parse(await handle(request({ headers: { authorization } })));
    expect(r.status).toBe(401);
    expect(routes.health).not.toHaveBeenCalled();
  });

  it("does not reveal which routes exist to unauthenticated callers", async () => {
    const { handle } = setup();
    const r = await handle(request({ target: "/v1/nope", headers: { authorization: undefined } }));
    expect(r.status).toBe(401);
  });

  it("refuses non-POST methods, including CORS preflight", async () => {
    const { handle } = setup();
    for (const method of ["GET", "OPTIONS", "PUT", "DELETE"]) {
      expect((await handle(request({ method }))).status).toBe(405);
    }
  });

  it.each([
    "/v1/messages.send",
    "/v1/compose.sendMessage",
    "/v1/messages.forward",
    "/v1/messages.delete",
    "/v1/__proto__",
    "/v1/constructor",
    "/v1/toString",
    "/v1/hasOwnProperty",
    "/v2/health",
    "/v1/health/",
    "/v1/health?x=1",
    "/v1/../health",
    "/health",
  ])("returns 404 for %s", async target => {
    const { handle } = setup();
    expect((await handle(request({ target }))).status).toBe(404);
  });

  it("requires application/json", async () => {
    const { handle } = setup();
    expect((await handle(request({ headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await handle(request({ headers: { "content-type": undefined } }))).status).toBe(415);
    expect((await handle(request({ headers: { "content-type": "application/json; charset=utf-8" } }))).status).toBe(200);
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["JSON array", "[1,2]"],
    ["JSON string", '"x"'],
    ["JSON null", "null"],
    ["invalid UTF-8", "\xff\xfe{}"],
  ])("rejects %s bodies with 400", async (_, body) => {
    const { handle } = setup();
    expect((await handle(request({ body }))).status).toBe(400);
  });

  it("decodes UTF-8 bodies from binary strings", async () => {
    const { handle } = setup();
    const binary = Buffer.from(JSON.stringify({ subject: "Grüße ✓" }), "utf8").toString("latin1");
    const r = parse(await handle(request({ target: "/v1/messages.get", body: binary })));
    expect(r.json.result.echo.subject).toBe("Grüße ✓");
  });

  it("maps BridgeError to its status and hides nothing else", async () => {
    const { handle } = setup({
      "messages.get": async () => {
        throw new BridgeError("not_found", "gone", 404);
      },
    });
    const r = parse(await handle(request({ target: "/v1/messages.get" })));
    expect(r).toEqual({ status: 404, json: { ok: false, error: { code: "not_found", message: "gone" } } });
  });

  it("returns 503 until the bridge secrets exist", async () => {
    const handle = createRequestHandler({ getSecrets: () => null, routes: {} });
    expect((await handle(request())).status).toBe(503);
  });
});
