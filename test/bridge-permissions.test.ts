// The privilege boundary, checked on the BUILT artifacts in dist/:
//   - draftsafe-bridge's manifest grants no permission that can send, move or
//     delete mail, and no compose-window access;
//   - its bundle contains only bridge code and the shared modules it imports,
//     and no file in it references a send/move/delete API;
//   - draftsafe-tools (which can send) has no Experiment, no listener and no
//     cross-extension messaging.
// API_PERMISSIONS maps every MailExtension function the bridge may call to the
// permissions Thunderbird requires for it; when Thunderbird is installed, that
// table is cross-checked against Thunderbird's own API schemas.

import { buildXpis } from "../scripts/build-xpi.mjs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildSmokeTools } from "../scripts/smoke/build-tools.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readZip } from "./helpers/zip.js";
import { API_PERMISSIONS, BRIDGE_PERMISSIONS, FORBIDDEN_PERMISSIONS } from "./helpers/permissions.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let bridge: Map<string, Buffer>;
let tools: Map<string, Buffer>;
const manifestOf = (files: Map<string, Buffer>) => JSON.parse(files.get("manifest.json")!.toString("utf8"));
const textFiles = (files: Map<string, Buffer>) =>
  [...files.entries()].filter(([n]) => /\.(js|mjs|json|html|css)$/.test(n)).map(([n, b]) => [n, b.toString("utf8")] as const);

beforeAll(() => {
  buildXpis();
  bridge = readZip(join(root, "dist/draftsafe-bridge.xpi"));
  tools = readZip(join(root, "dist/draftsafe-tools.xpi"));
});

describe("draftsafe-bridge.xpi (built)", () => {
  it("requests exactly the draft-only permission set and nothing optional", () => {
    const m = manifestOf(bridge);
    expect(m.browser_specific_settings.gecko.id).toBe("draftsafe-bridge@draftsafe.dev");
    expect([...m.permissions].sort()).toEqual(BRIDGE_PERMISSIONS);
    for (const p of FORBIDDEN_PERMISSIONS) expect(m.permissions, p).not.toContain(p);
    expect(m.optional_permissions).toBeUndefined();
    expect(m.host_permissions).toBeUndefined();
    for (const key of ["compose_action", "browser_action", "message_display_action", "externally_connectable", "content_scripts", "commands"]) {
      expect(m[key], key).toBeUndefined();
    }
    expect(Object.keys(m.experiment_apis)).toEqual(["draftsafeBridge"]);
  });

  it("every API the bridge may call is covered by its manifest permissions", () => {
    const granted = new Set([...manifestOf(bridge).permissions, "experiment"]);
    for (const [fn, needs] of Object.entries(API_PERMISSIONS)) {
      for (const p of needs) expect(granted.has(p), `${fn} needs ${p}`).toBe(true);
    }
  });

  it("contains only bridge files and the shared modules it imports", () => {
    const names = [...bridge.keys()].sort();
    expect(names.filter(n => !n.startsWith("bridge/") && !n.startsWith("shared/") && n !== "manifest.json")).toEqual([]);
    expect(names.some(n => /sendlater|snooze|tools\//i.test(n))).toBe(false);
    expect(names).toContain("bridge/api/implementation.js");
  });

  it("no file in the bundle references a send, move or delete capability", () => {
    const banned: [string, RegExp][] = [
      ["send APIs", /sendMessage|\bsendNow\b|\bsendLater\b|cmd_send|SendMessageLater|nsIMsgSend/],
      ["forward", /beginForward|forwardMessage/],
      ["message delete/move/copy/archive/import", /messages\s*\.\s*(delete|move|copy|archive|import|deleteAttachments)\b/],
      ["folder mutations", /folders\s*\.\s*(create|rename|delete|move|copy|update|markAsRead)\b/],
      ["compose window access", /compose\s*\.\s*(sendMessage|setComposeDetails|getComposeDetails|addAttachment|updateAttachment|onBeforeSend)\b/],
      ["XPCOM mail services", /MailServices|nsIMsgCompose|nsIMsgCopyService|nsIMsgFolder|nsIMsgDBHdr|messenger\.jsm/],
      ["cross-extension messaging", /onMessageExternal|onConnectExternal|runtime\s*\.\s*(sendMessage|connect)\b|connectNative/],
      ["dynamic code", /\beval\s*\(|new\s+Function\s*\(/],
      ["computed API access", /\b(api|messenger|browser)\b(\s*\.\s*[A-Za-z_$][\w$]*)*\s*\[/],
      ["permission requests", /permissions\s*\.\s*request/],
    ];
    for (const [name, source] of textFiles(bridge)) {
      // Exactly one approved cross-extension call site, to the constant Tools ID.
      const text = name === "bridge/src/bridge/relay.js" ? source.replace("api.runtime.sendMessage(TOOLS_ID,", "relayToTools(") : source;
      for (const [what, re] of banned) {
        expect(re.test(text), `${name}: ${what} (${re})`).toBe(false);
      }
    }
  });
});

describe("draftsafe-tools.xpi (built)", () => {
  it("instrumentation exists only in the separate smoke build, never in release", () => {
    const dir = mkdtempSync(join(tmpdir(), "draftsafe-bundle-test-"));
    try {
      const out = join(dir, "tools-test.xpi");
      buildSmokeTools(out);
      const testBuild = readZip(out);
      expect(testBuild.get("tools/src/ui/smoke-hook.js")!.toString()).toContain("DRAFTSAFE_SMOKE_READY");
      expect(testBuild.get("tools/src/ui/approve.js")!.toString()).toContain('import("./smoke-hook.js")');
      for (const files of [bridge, tools]) {
        for (const [name, body] of files) {
          expect(name).not.toMatch(/smoke|test-hook/);
          expect(body.toString()).not.toMatch(/DRAFTSAFE_SMOKE|smoke-hook|testApprove/);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("has no Experiment or listener; external requests and HTTPS POSTs have single call sites", () => {
    const m = manifestOf(tools);
    expect(m.browser_specific_settings.gecko.id).toBe("draftsafe-tools@draftsafe.dev");
    expect(m.experiment_apis).toBeUndefined();
    expect(m.externally_connectable).toBeUndefined();
    expect(m.optional_permissions).toEqual(["https://*/*"]);
    expect(m.permissions).not.toContain("messagesDelete");
    for (const [name, text] of textFiles(tools)) {
      expect(/draftsafeBridge|nsIServerSocket|ChromeUtils|Components\.|XMLHttpRequest|WebSocket|onConnectExternal|connectNative/.test(text), name).toBe(false);
      if (/onMessageExternal/.test(text)) expect(name).toBe("tools/src/external-receiver.js");
      if (/\bfetch\s*\(/.test(text)) expect(name).toBe("tools/src/approval/unsubscribe.js");
      expect(text).not.toMatch(/DRAFTSAFE_SMOKE|smoke-hook|testApprove|approval\.decide/);
    }
    expect([...tools.keys()].some(n => n.startsWith("bridge/"))).toBe(false);
  });
});

// ------------------------------------------------ Thunderbird cross-check --

const OMNI = ["/snap/thunderbird/current/usr/lib/thunderbird/omni.ja", "/usr/lib/thunderbird/omni.ja"].find(p => existsSync(p));

describe.skipIf(!OMNI)(`permission table matches Thunderbird's own schemas (${OMNI ?? "not installed"})`, () => {
  it("API_PERMISSIONS agrees with the installed Thunderbird's API schemas", () => {
    const files = readZip(OMNI!, n => /messenger\/schemas\/(messages|compose|folders|accounts)\.json$/.test(n));
    const perms = new Map<string, string[]>();
    for (const buf of files.values()) {
      const json = JSON.parse(buf.toString("utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
      for (const ns of json) {
        if (!ns.namespace || ns.namespace === "manifest") continue;
        for (const fn of ns.functions ?? []) {
          if ((fn.min_manifest_version ?? 2) > 2 || (fn.max_manifest_version ?? 3) < 2) continue; // MV2 variants
          perms.set(`${ns.namespace}.${fn.name}`, [...(ns.permissions ?? []), ...(fn.permissions ?? [])].sort());
        }
      }
    }
    let checked = 0;
    for (const [fn, needs] of Object.entries(API_PERMISSIONS)) {
      if (!perms.has(fn)) continue; // runtime, tabs, messengerUtilities, the experiment
      expect([...needs].sort(), fn).toEqual(perms.get(fn));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(15);
    // And the send/move/delete functions really do need permissions the bridge lacks.
    for (const fn of ["compose.sendMessage", "messages.sendMessage", "messages.delete", "messages.move", "messages.archive", "folders.delete", "compose.setComposeDetails"]) {
      const needs = perms.get(fn)!;
      expect(needs.length, fn).toBeGreaterThan(0);
      expect(needs.some(p => !BRIDGE_PERMISSIONS.includes(p)), `${fn} must need a permission the bridge lacks`).toBe(true);
    }
  });
});
