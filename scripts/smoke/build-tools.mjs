// Test-only instrumentation is added to a separate XPI in the throwaway profile.
// It reports geometry and attempts an untrusted click, never bypasses approval.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { addonEntries, zip } from "../build-xpi.mjs";
export function buildSmokeTools(out) {
  const dir = mkdtempSync(join(tmpdir(), "draftsafe-smoke-build-"));
  try {
    const files = addonEntries("tools").map(([file, path]) => {
      if (path !== "tools/src/ui/approve.js") return [file, path];
      const patched = join(dir, "approve.js");
      writeFileSync(patched, readFileSync(file, "utf8") + '\nawait import("./smoke-hook.js");\n');
      return [patched, path];
    });
    files.push([join(dirname(fileURLToPath(import.meta.url)), "ui-hook.js"), "tools/src/ui/smoke-hook.js"]);
    writeFileSync(out, zip(files));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
