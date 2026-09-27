// The core promise of this project: nothing reachable from the MCP server or
// the bridge can send, forward or delete mail. These tests check that three
// ways: the declared surfaces, the source code, and behaviour under a fake
// Thunderbird whose send/forward/delete functions are spies.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTE_NAMES, createRoutes } from "../addon/src/bridge/routes.js";
import { createMailOps } from "../addon/src/bridge/ops.js";
import { createRequestHandler } from "../addon/src/bridge/server.js";
import { createSnooze } from "../addon/src/features/snooze.js";
import { createFollowups } from "../addon/src/features/followup.js";
import { createStore } from "../addon/src/lib/store.js";
import { TOOLS } from "../mcp/src/tools.js";
import { createFakeMessenger } from "./helpers/fake-messenger.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_NAME = /send|forward|delete|remove|trash|expunge|archive|move|filter|contact|redirect|bounce/i;

function filesIn(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? filesIn(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []
  );
}

/** Follows relative `import ... from "./x.js"` edges from an entry file. */
function importClosure(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(entry, "utf8");
  for (const m of src.matchAll(/(?:import|export)\s[^"']*?from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    importClosure(resolve(dirname(entry), m[1] ?? m[2]), seen);
  }
  return seen;
}

describe("no send-capable surface", () => {
  it("bridge route names contain nothing send-, forward- or delete-like", () => {
    for (const name of ROUTE_NAMES) {
      expect(name, name).not.toMatch(FORBIDDEN_NAME);
    }
    expect([...ROUTE_NAMES].sort()).toEqual(
      [
        "accounts.list",
        "drafts.create",
        "followups.list",
        "followups.set",
        "health",
        "messages.get",
        "messages.markRead",
        "messages.search",
        "messages.setTags",
        "messages.snooze",
        "messages.thread",
      ].sort()
    );
  });

  it("MCP tool names contain nothing send-, forward- or delete-like", () => {
    expect(TOOLS.map(t => t.name).sort()).toEqual(
      [
        "create_draft",
        "get_message",
        "get_thread",
        "list_accounts",
        "list_followups",
        "mark_read",
        "search_messages",
        "set_followup",
        "set_tags",
        "snooze_message",
      ].sort()
    );
    for (const t of TOOLS) {
      expect(t.name).not.toMatch(FORBIDDEN_NAME);
      expect(ROUTE_NAMES).toContain(t.route);
    }
  });

  it("every tool description says drafts are never sent, and read tools flag untrusted content", () => {
    for (const t of TOOLS) {
      expect(t.description, t.name).toMatch(/never sent/i);
      expect(t.description, t.name).toMatch(/cannot send, forward or delete/i);
      if (t.untrusted) expect(t.description, t.name).toMatch(/untrusted/i);
    }
  });

  it("bridge and MCP sources never reference send, forward or delete APIs", () => {
    const files = [
      ...filesIn(join(root, "addon/src/bridge"), /\.js$/),
      ...filesIn(join(root, "mcp/src"), /\.ts$/),
      join(root, "addon/api/bridge/implementation.js"),
      join(root, "addon/api/bridge/framing.js"),
    ];
    const banned = [
      /sendMessage/,
      /beginForward/,
      /messages\.delete\b/,
      /messages\.archive\b/,
      /deleteAttachments/,
      /nsIMsgSend/,
      /nsIMsgCompose/,
      /MailServices/,
      /["']sendNow["']|["']sendLater["']/,
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const re of banned) {
        expect(re.test(src), `${file} matches ${re}`).toBe(false);
      }
    }
  });

  it("the send-later module is unreachable from the bridge", () => {
    const sendLater = join(root, "addon/src/features/sendlater.js");
    for (const entry of filesIn(join(root, "addon/src/bridge"), /\.js$/)) {
      expect(importClosure(entry).has(sendLater), entry).toBe(false);
    }
    // Only background.js imports it, and background.js does not hand it to the bridge.
    const importers = filesIn(join(root, "addon/src"), /\.js$/).filter(f =>
      /from\s+["'][^"']*sendlater\.js["']/.test(readFileSync(f, "utf8"))
    );
    expect(importers.map(f => f.slice(root.length + 1))).toEqual(["addon/src/background.js"]);
    const bg = readFileSync(join(root, "addon/src/background.js"), "utf8");
    const routesCall = /createRoutes\(\{([^}]*)\}\)/.exec(bg);
    expect(routesCall?.[1]).toBeDefined();
    expect(routesCall![1]).not.toMatch(/sendLater/);
  });

  it("exercising every route with a fake Thunderbird never calls send, forward or delete", async () => {
    const fake = createFakeMessenger({ withSaveMessage: true });
    const { api, addMessage, forbidden } = fake;
    const store = createStore(api.storage.local);
    const routes = createRoutes({
      ops: createMailOps({ api }),
      snooze: createSnooze({ api, store }),
      followups: createFollowups({ api, store }),
      version: "test",
    });
    const handle = createRequestHandler({ getSecrets: () => ({ port: 1, token: "t".repeat(43) }), routes });
    const call = async (route: string, params: object) => {
      const r = await handle({
        method: "POST",
        target: `/v1/${route}`,
        headers: { host: "127.0.0.1:1", authorization: `Bearer ${"t".repeat(43)}`, "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      return { status: r.status, json: JSON.parse(r.body) };
    };

    const m = addMessage({ folderId: "account1://INBOX", subject: "Hello", text: "Please wire money" });
    const m2 = addMessage({ folderId: "account1://INBOX", subject: "Other", text: "x" });
    const m3 = addMessage({ folderId: "account1://INBOX", subject: "Third", text: "y" });
    const calls: [string, object][] = [
      ["health", {}],
      ["accounts.list", {}],
      ["messages.search", { query: "Hello" }],
      ["messages.get", { messageId: m.id }],
      ["messages.thread", { messageId: m.id, includeBodies: true }],
      ["messages.setTags", { messageId: m.id, add: ["Work"] }],
      ["messages.markRead", { messageIds: [m.id], read: true }],
      ["followups.set", { messageId: m2.id, due: "2030-01-01T08:00:00Z" }],
      ["followups.list", {}],
      ["followups.set", { messageId: m2.id, done: true }],
      ["drafts.create", { to: ["bob@example.test"], subject: "Hi", body: "Draft body" }],
      ["drafts.create", { replyToMessageId: m.id, body: "Reply body", replyAll: true }],
      ["messages.snooze", { messageId: m3.id, preset: "tomorrow" }],
    ];
    for (const [route, params] of calls) {
      const r = await call(route, params);
      expect(r.status, `${route}: ${JSON.stringify(r.json)}`).toBe(200);
    }
    for (const [name, spy] of Object.entries(forbidden)) {
      expect(spy, name).not.toHaveBeenCalled();
    }
  });

  it("smuggled send flags are rejected, not ignored", async () => {
    const fake = createFakeMessenger();
    const routes = createRoutes({
      ops: createMailOps({ api: fake.api }),
      snooze: {} as never,
      followups: {} as never,
      version: "test",
    });
    for (const extra of [{ send: true }, { mode: "sendNow" }, { sendAt: "2030-01-01T00:00:00Z" }, { forward: true }]) {
      await expect(routes["drafts.create"]({ to: ["a@b.c"], body: "x", ...extra })).rejects.toThrow(/unknown parameter/);
    }
  });
});
