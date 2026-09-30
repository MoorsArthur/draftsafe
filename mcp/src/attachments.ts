// SPDX-License-Identifier: MIT
// Local files are read by the MCP process only for a user-reviewed composer.
// Bytes cross authenticated loopback in bounded chunks, never tool results.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BridgeCaller } from "./bridge-client.js";
import { BridgeError } from "./bridge-client.js";

const CHUNK = 128 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
const BLOCKED = /(?:^|[._ -])(secret|secrets|credential|credentials|password|passwd|token|private|recovery|id_rsa|id_ed25519)(?:$|[._ -])/i;
const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".txt": "text/plain", ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export type AttachmentInput =
  | { source: "local"; path: string }
  | { source: "message"; message_id: number; part_name: string };

async function allowedRoots(): Promise<string[]> {
  const configured = process.env.DRAFTSAFE_ATTACHMENT_ROOTS;
  const values = configured
    ? configured.split(path.delimiter).filter(Boolean)
    : ["Downloads", "Documents", "Desktop"].map(name => path.join(os.homedir(), name));
  const roots: string[] = [];
  for (const value of values) {
    if (!path.isAbsolute(value)) continue;
    try { roots.push(await realpath(value)); } catch { /* Absent default folder. */ }
  }
  return roots;
}

async function stageLocal(bridge: BridgeCaller, input: string): Promise<string> {
  if (!path.isAbsolute(input) || input.includes("\0")) throw new BridgeError("Use an absolute file path.", "invalid_params");
  const components = input.split(path.sep).filter(Boolean);
  if (components.some(part => part.startsWith(".") || BLOCKED.test(part) || /\.(?:env|pem|key|p12|pfx|kdbx)$/i.test(part)))
    throw new BridgeError("Hidden or secret-looking files cannot be attached.", "attachment_denied");
  const before = await lstat(input);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE)
    throw new BridgeError("Attachment must be a regular file of at most 10 MiB.", "attachment_limit");
  const canonical = await realpath(input);
  const roots = await allowedRoots();
  if (!roots.some(root => canonical.startsWith(root + path.sep)))
    throw new BridgeError("File is outside the configured attachment folders.", "attachment_denied");
  const handle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let token = "";
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size)
      throw new BridgeError("File changed while preparing the attachment.", "attachment_denied");
    const name = path.basename(input);
    const staged = await bridge.call<{ token: string }>("attachments.begin", {
      name, size: stat.size, type: MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream",
    });
    token = staged.token;
    const buffer = Buffer.alloc(CHUNK);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, stat.size - offset), offset);
      if (!bytesRead) throw new BridgeError("File changed during upload.", "attachment_denied");
      await bridge.call("attachments.chunk", { token, offset, data: buffer.subarray(0, bytesRead).toString("base64") });
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new BridgeError("File changed during upload.", "attachment_denied");
    return token;
  } catch (error) {
    if (token) await bridge.call("attachments.discard", { token }).catch(() => {});
    throw error;
  } finally { await handle.close(); }
}

export async function prepareAttachments(bridge: BridgeCaller, inputs: AttachmentInput[] = []) {
  if (inputs.length > 100) throw new BridgeError("At most 100 attachments are allowed.", "attachment_limit");
  const result: Array<{ stagedToken: string } | { messageId: number; partName: string }> = [];
  const tokens: string[] = [];
  let total = 0;
  try {
    for (const input of inputs) {
      if (input.source === "message") {
        result.push({ messageId: input.message_id, partName: input.part_name });
      } else {
        const stat = await lstat(input.path);
        total += stat.size;
        if (total > MAX_TOTAL) throw new BridgeError("Local attachments exceed 25 MiB total.", "attachment_limit");
        const token = await stageLocal(bridge, input.path);
        tokens.push(token);
        result.push({ stagedToken: token });
      }
    }
    return { attachments: result, tokens };
  } catch (error) {
    await Promise.all(tokens.map(token => bridge.call("attachments.discard", { token }).catch(() => {})));
    throw error;
  }
}
