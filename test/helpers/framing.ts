// Loads the experiment's plain-script framing module the same way
// Services.scriptloader.loadSubScript() does: top-level declarations become
// properties of the target object.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export interface Framing {
  LIMITS: {
    maxHeaderBytes: number;
    maxBodyBytes: number;
    maxHeaderCount: number;
    maxTargetLength: number;
    maxConnections: number;
    readTimeoutMs: number;
    handlerTimeoutMs: number;
  };
  frameRequest(buf: string, limits?: unknown): any;
  parseHead(head: string, limits?: unknown): any;
  buildResponse(status: number, body: string): string;
  utf8Encode(s: string): string;
}

export function loadFraming(): Framing {
  const file = fileURLToPath(new URL("../../addons/bridge/api/framing.js", import.meta.url));
  const sandbox: Record<string, unknown> = { unescape, encodeURIComponent };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, "utf8"), sandbox, { filename: file });
  return sandbox as unknown as Framing;
}
