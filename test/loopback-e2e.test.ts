// End to end over real TCP: BridgeClient -> 127.0.0.1 -> framing.js ->
// background request handler -> routes -> mail ops -> fake Thunderbird.
// Only the XPCOM socket plumbing of the experiment is replaced (by node:net).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRoutes } from "../addons/bridge/src/bridge/routes.js";
import { createMailOps } from "../addons/bridge/src/bridge/ops.js";
import { createRequestHandler } from "../addons/bridge/src/bridge/server.js";
import { generateToken } from "../addons/bridge/src/bridge/security.js";
import { BridgeClient } from "../mcp/src/bridge-client.js";
import { createFakeMessenger } from "./helpers/fake-messenger.js";
import { rawRequest, startNodeBridge } from "./helpers/node-bridge.js";
import { loadFraming } from "./helpers/framing.js";

const token = generateToken();
const fake = createFakeMessenger({ withSaveMessage: true });
let bridge: Awaited<ReturnType<typeof startNodeBridge>>;
let client: BridgeClient;

beforeAll(async () => {
  const routes = createRoutes({ ops: createMailOps({ api: fake.api }), version: "e2e" });
  bridge = await startNodeBridge(port => createRequestHandler({ getSecrets: () => ({ port, token }), routes }));
  client = new BridgeClient({ loadConnection: async () => ({ port: bridge.port, token, path: "mem" }) });
  fake.addMessage({ folderId: "account1://INBOX", subject: "Quarterly report", text: "Numbers attached" });
});

afterAll(() => bridge.close());

const status = (raw: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]);

describe("loopback bridge end to end", () => {
  it("serves real requests from the MCP-side client", async () => {
    const found: any = await client.call("messages.search", { query: "Quarterly" });
    expect(found.messages).toHaveLength(1);
    const msg: any = await client.call("messages.get", { messageId: found.messages[0].id });
    expect(msg.body.text).toBe("Numbers attached");
    const draft: any = await client.call("drafts.create", { to: ["x@example.test"], subject: "Re", body: "ok" });
    expect(draft).toMatchObject({ saved: true, sent: false });
  });

  it("rejects wrong tokens, foreign Host headers and Origin over the wire", async () => {
    const base = (headers: string) =>
      `POST /v1/health HTTP/1.1\r\n${headers}Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`;
    const host = `Host: 127.0.0.1:${bridge.port}\r\n`;
    const auth = `Authorization: Bearer ${token}\r\n`;
    expect(status(await rawRequest(bridge.port, base(host + auth)))).toBe(200);
    expect(status(await rawRequest(bridge.port, base(host + `Authorization: Bearer ${generateToken()}\r\n`)))).toBe(401);
    expect(status(await rawRequest(bridge.port, base(`Host: attacker.example:${bridge.port}\r\n` + auth)))).toBe(403);
    expect(status(await rawRequest(bridge.port, base(host + auth + "Origin: https://attacker.example\r\n")))).toBe(403);
    const res = await rawRequest(bridge.port, base(host + auth));
    expect(res.toLowerCase()).not.toContain("access-control-allow");
  });

  it("caps request bodies before they reach any handler", async () => {
    const { LIMITS } = loadFraming();
    const head =
      `POST /v1/drafts.create HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nAuthorization: Bearer ${token}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${LIMITS.maxBodyBytes + 1}\r\n\r\n`;
    expect(status(await rawRequest(bridge.port, head))).toBe(413);
    // Even when a client lies about the length and streams more.
    const flood = `POST /v1/health HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nContent-Length: 5\r\n\r\n` + "x".repeat(LIMITS.maxBodyBytes * 2);
    expect(status(await rawRequest(bridge.port, flood))).toBeGreaterThanOrEqual(400);
  });

  it("has no send endpoint", async () => {
    await expect(client.call("messages.send", { messageId: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(client.call("compose.sendMessage", {})).rejects.toMatchObject({ status: 404 });
    await expect(client.call("messages.snooze", { messageId: 1, preset: "tomorrow" })).rejects.toMatchObject({ status: 404 });
    await expect(client.call("messages.delete", { messageId: 1 })).rejects.toMatchObject({ status: 404 });
    for (const spy of Object.values(fake.forbidden)) expect(spy).not.toHaveBeenCalled();
  });
});
