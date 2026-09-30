// Test-only instrumentation is added to a separate XPI in the throwaway profile.
// It reports geometry and attempts an untrusted click, never bypasses approval.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { addonEntries, zip } from "../build-xpi.mjs";
export function buildSmokeAddon(out) {
  const dir = mkdtempSync(join(tmpdir(), "draftsafe-smoke-build-"));
  try {
    const files = addonEntries("app").map(([file, path]) => {
      if (path === "tools/src/ui/approve.js") {
        const patched = join(dir, "approve.js");
        writeFileSync(patched, readFileSync(file, "utf8") + '\nawait import("./smoke-hook.js");\n');
        return [patched, path];
      }
      if (path === "bridge/api/implementation.js") {
        const source = readFileSync(file, "utf8");
        const from = 'var APP_DIR_NAME = "draftsafe-mcp";';
        if (!source.includes(from)) throw new Error("smoke connection directory patch did not match");
        const patched = join(dir, "implementation.js");
        writeFileSync(patched, source.replace(from, 'var APP_DIR_NAME = "draftsafe-smoke-mcp";'));
        return [patched, path];
      }
      return [file, path];
    });
    files.push([join(dirname(fileURLToPath(import.meta.url)), "ui-hook.js"), "tools/src/ui/smoke-hook.js"]);
    writeFileSync(out, zip(files));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
