// Inspect the release XPI, not just source files. One add-on contains the
// privileged loopback Experiment and Send later, so the manifest cannot be
// claimed as a no-send boundary. The HTTP/MCP route surface is checked here.
import { buildXpis } from "../scripts/build-xpi.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildSmokeAddon } from "../scripts/smoke/build-tools.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readZip } from "./helpers/zip.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let addon: Map<string, Buffer>;
const manifest = () => JSON.parse(addon.get("manifest.json")!.toString("utf8"));

beforeAll(() => {
  buildXpis();
  addon = readZip(join(root, "dist/draftsafe.xpi"));
});

describe("single Draftsafe release add-on", () => {
  it("uses the existing Tools ID so its local state survives upgrade", () => {
    expect(manifest().browser_specific_settings.gecko.id).toBe("draftsafe-tools@draftsafe.dev");
    expect(manifest().experiment_apis).toHaveProperty("draftsafeBridge");
    expect(manifest().permissions).toContain("compose.send");
    expect(manifest().permissions).not.toContain("messagesDelete");
    expect(manifest().optional_permissions).toEqual(["https://*/*"]);
    expect(addon.has("app/background.html")).toBe(true);
    expect(addon.has("bridge/api/implementation.js")).toBe(true);
    expect(addon.has("tools/src/features/sendlater.js")).toBe(true);
    expect(addon.has("tools/src/ui/approve.html")).toBe(true);
  });

  it("contains no cross-extension receiver or obsolete relay", () => {
    expect(addon.has("tools/src/external-receiver.js")).toBe(false);
    expect(addon.has("bridge/src/bridge/relay.js")).toBe(false);
    for (const [name, body] of addon) {
      const text = body.toString("utf8");
      expect(text, name).not.toMatch(/onMessageExternal|onConnectExternal|connectNative/);
    }
  });

  it("limits send calls to the user-only Send later module", () => {
    const callers = [...addon.entries()]
      .filter(([name, body]) => name.endsWith(".js") && /(?:compose|messages)\s*\.\s*sendMessage\s*\(/.test(body.toString("utf8")))
      .map(([name]) => name);
    expect(callers).toEqual(["tools/src/features/sendlater.js"]);
    expect(addon.get("bridge/src/bridge/routes.js")!.toString()).not.toMatch(/sendMessage|messages\.send/);
  });

  it("keeps synthetic-click instrumentation out of the release XPI", () => {
    const dir = mkdtempSync(join(tmpdir(), "draftsafe-bundle-test-"));
    try {
      const out = join(dir, "draftsafe-smoke.xpi");
      buildSmokeAddon(out);
      const smoke = readZip(out);
      expect(smoke.get("tools/src/ui/smoke-hook.js")!.toString()).toContain("DRAFTSAFE_SMOKE_READY");
      expect(smoke.get("tools/src/ui/approve.js")!.toString()).toContain('import("./smoke-hook.js")');
      expect(smoke.get("bridge/api/implementation.js")!.toString()).toContain('APP_DIR_NAME = "draftsafe-smoke-mcp"');
      expect(addon.get("bridge/api/implementation.js")!.toString()).toContain('APP_DIR_NAME = "draftsafe-mcp"');
      for (const [name, body] of addon) {
        expect(name).not.toMatch(/smoke|test-hook/);
        expect(body.toString()).not.toMatch(/DRAFTSAFE_SMOKE|smoke-hook|testApprove/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
