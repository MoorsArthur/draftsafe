// SPDX-License-Identifier: MIT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeCaller } from "./bridge-client.js";
import { BridgeError } from "./bridge-client.js";
import { ConnectionError } from "./connection.js";
import { wrapUntrusted } from "./format.js";
import { SAFETY, TOOLS, UNTRUSTED } from "./tools.js";
import { PACKAGE_VERSION } from "./version.js";

export const SERVER_NAME = "draftsafe-mcp";
export const SERVER_VERSION = PACKAGE_VERSION;

export const INSTRUCTIONS =
  "Draftsafe gives read access to local Thunderbird mail. " + SAFETY + " " +
  "For outgoing mail, open_compose_for_review only prepares a Thunderbird window; the user reviews and clicks Send. Never claim delivery from its result. " +
  "Approval requests can wait up to 11 minutes. " + UNTRUSTED + " " +
  "Every result is returned inside UNTRUSTED_MAIL_DATA blocks.";

/**
 * Error codes whose messages are written by Draftsafe itself (they may echo
 * the caller's own arguments, never mailbox content). Any other error is
 * reported with a fixed text, because its message could contain text from
 * the mailbox or from Thunderbird internals.
 */
export const PUBLIC_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_params",
  "bad_request",
  "not_found",
  "unknown_tag",
  "use_followup",
  "not_taggable",
  "cursor_expired",
  "busy",
  "timeout",
  "read_timeout",
  "result_too_large",
  "unavailable",
  "stale_connection",
  "unauthorized",
  "not_ready",
  "tools_unavailable",
  "delivery_unknown",
  "approval_interrupted",
  "planning",
  "pending_elsewhere",
  "compose_busy",
  "compose_rate_limit",
  "compose_unknown",
  "unknown_route",
]);

const ERROR_TEXT: Record<string, string> = {
  invalid_params: "Invalid parameters.", bad_request: "Invalid request.", not_found: "Message or folder not found; search again.",
  unknown_tag: "Unknown tag; list available tags first.", use_followup: "Use set_followup for the Follow up tag.",
  not_taggable: "This message cannot be tagged.", cursor_expired: "Search cursor expired; search again.",
  busy: "Draftsafe is busy with other requests; try again shortly.", timeout: "Approval timed out; check Thunderbird history before retrying.",
  read_timeout: "Thunderbird took too long to complete this read. Narrow the search by account, folder or date and try again.",
  result_too_large: "Result too large; request fewer messages.", unavailable: "Draftsafe is unreachable. Thunderbird may be closed or the Draftsafe add-on may be stopped.",
  stale_connection: "Draftsafe rejected the current connection file after it was re-read. Restart or re-enable the Draftsafe add-on.",
  unauthorized: "Bridge authentication failed.", not_ready: "Thunderbird is starting.", unknown_route: "Unknown endpoint.",
  tools_unavailable: "Draftsafe approval handling is not answering. Inspect Thunderbird's error console.",
  delivery_unknown: "Could not confirm whether Tools received the approval request; check approval history before retrying.",
  approval_interrupted: "Approval was interrupted; check Thunderbird history before retrying.",
  planning: "Draftsafe is still preparing the request; check the approval window and history.",
  pending_elsewhere: "Another approval is pending in Thunderbird; check its window before retrying.",
  compose_busy: "Close the previous agent-prepared compose window before opening another.",
  compose_rate_limit: "Too many agent-prepared compose windows this hour; try later.",
  compose_unknown: "Thunderbird may already have opened the message; inspect its compose windows before retrying.",
};

const GENERIC_ERROR = "Thunderbird reported an error. Details are in Thunderbird's error console (Tools, Developer Tools).";

export function publicErrorText(e: unknown): string {
  if (e instanceof ConnectionError) {
    return e.message;
  }
  if (e instanceof BridgeError) {
    const code = /^[a-z_]{1,40}$/.test(e.code) ? e.code : "error";
    return PUBLIC_ERROR_CODES.has(code) ? `${ERROR_TEXT[code]} (${code})` : `${GENERIC_ERROR} (${code})`;
  }
  return GENERIC_ERROR;
}

export function createServer(bridge: BridgeCaller): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const destructiveTools = new Set(["request_cleanup", "request_trash", "request_folder_changes", "request_unsubscribe"]);

  for (const spec of TOOLS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: {
          title: spec.title,
          readOnlyHint: spec.readOnly,
          destructiveHint: destructiveTools.has(spec.name),
          idempotentHint: spec.readOnly,
          openWorldHint: spec.name === "request_unsubscribe",
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await bridge.call(spec.route, spec.toParams(args ?? {}));
          return { content: [{ type: "text" as const, text: wrapUntrusted(`Result of ${spec.name}:`, result) }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: publicErrorText(e) }] };
        }
      }
    );
  }
  return server;
}
