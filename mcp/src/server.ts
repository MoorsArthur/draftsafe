// SPDX-License-Identifier: MIT

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeCaller } from "./bridge-client.js";
import { BridgeError } from "./bridge-client.js";
import { ConnectionError } from "./connection.js";
import { wrapUntrusted } from "./format.js";
import { SAFETY, TOOLS, UNTRUSTED } from "./tools.js";
import { PACKAGE_VERSION } from "./version.js";
import { prepareAttachments, type AttachmentInput } from "./attachments.js";

export const SERVER_NAME = "draftsafe-mcp";
export const SERVER_VERSION = PACKAGE_VERSION;

export const INSTRUCTIONS =
  "Draftsafe gives read access to local Thunderbird mail. " + SAFETY + " " +
  "For outgoing mail, open_compose_for_review only prepares a Thunderbird window; the user reviews and clicks Send. Never claim delivery from its result. " +
  "When the user requests several distinct emails, use open_composes_for_review to prepare up to 20 windows in one call; inspect any partial result before retrying. " +
  "When the user asks to edit an existing composer, list_open_composes_for_review and update_compose_for_review must be used; never open a second window for that edit. " +
  "Use fast:true and narrow filters for initial mail searches, follow nextCursor until complete:true before claiming no matches, and use get_message for full headers. For an uncertain recipient address, call find_recipients and confirm ambiguous matches before composing. " +
  "To close an agent-prepared composer, use close_compose_for_review. It refuses windows changed by the user and never sends. " +
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
  "compose_unknown",
  "compose_exists",
  "compose_ambiguous",
  "compose_conflict",
  "attachment_limit",
  "attachment_denied",
  "attachment_expired",
  "unknown_route",
  "update_required",
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
  compose_busy: "Another compose operation is running; try again shortly.",
  compose_unknown: "Thunderbird may already have opened the message; inspect its compose windows before retrying.",
  compose_exists: "An agent-prepared composer is already open. List and update it; use new_window:true only for a separately requested email.",
  compose_ambiguous: "Several agent-prepared composers are open. List them and choose a tab ID before editing.",
  compose_conflict: "You edited this Thunderbird window. The agent will not overwrite your changes.",
  attachment_limit: "Attachment count or size exceeds Draftsafe's limits.",
  attachment_denied: "File attachment path is not allowed. Use Downloads, Documents or Desktop, or configure DRAFTSAFE_ATTACHMENT_ROOTS.",
  attachment_expired: "The staged attachment expired. Try preparing the composer again.",
  update_required: "Draftsafe add-on and MCP server are incompatible. Update both, then restart Thunderbird and the MCP client.",
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

type BatchMessage = {
  to?: string[]; subject?: string; body: string; reply_to_message_id?: number;
  identity_id?: string; attachments?: AttachmentInput[];
};

async function openComposeBatch(bridge: BridgeCaller, messages: BatchMessage[]) {
  // Discovery both counts existing windows and gates old add-ons before any
  // composer is opened. The batch itself is intentionally non-atomic.
  const current = await bridge.call<{ composers: unknown[]; uncertain?: boolean }>("compose.listForReview");
  if (!Array.isArray(current?.composers) || current.uncertain)
    throw new BridgeError("Inspect Thunderbird's compose windows before a batch.", "compose_unknown");
  const opened: Array<{ message: number; tabId: number; attachments: unknown }> = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    let tokens: string[] = [];
    try {
      const prepared = await prepareAttachments(bridge, message.attachments ?? []);
      tokens = prepared.tokens;
      const params: Record<string, unknown> = { body: message.body, attachments: prepared.attachments };
      if (message.reply_to_message_id !== undefined) params.replyToMessageId = message.reply_to_message_id;
      else {
        params.to = message.to;
        params.subject = message.subject;
        if (message.identity_id !== undefined) params.identityId = message.identity_id;
      }
      if (current.composers.length || opened.length) params.newWindow = true;
      const result = await bridge.call<{ tabId?: number; sent?: boolean; attachments?: unknown }>("compose.openForReview", params);
      if (!Number.isSafeInteger(result?.tabId) || (result.tabId ?? 0) < 1 || result.sent !== false)
        throw new BridgeError("Thunderbird did not confirm a compose window.", "compose_unknown");
      opened.push({ message: index + 1, tabId: result.tabId!, attachments: result.attachments ?? [] });
    } catch (error) {
      return { status: opened.length ? "partial" : "failed", sent: false, opened,
        failedMessage: index + 1, error: publicErrorText(error),
        review: "Inspect Thunderbird's compose windows before retrying; the failed message may have opened." };
    } finally {
      if (tokens.length) await Promise.all(tokens.map(token =>
        bridge.call("attachments.discard", { token }).catch(() => {})));
    }
  }
  return { status: "awaiting_user_send", sent: false, opened,
    review: "Review every Thunderbird window and click Send yourself for each message." };
}

export function createServer(bridge: BridgeCaller): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const destructiveTools = new Set(["request_cleanup", "request_trash", "request_folder_changes", "request_unsubscribe", "close_compose_for_review"]);

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
          if (spec.name === "open_composes_for_review") {
            const result = await openComposeBatch(bridge, args.messages as BatchMessage[]);
            return { content: [{ type: "text" as const, text: wrapUntrusted(`Result of ${spec.name}:`, result) }] };
          }
          const params = spec.toParams(args ?? {});
          let tokens: string[] = [];
          if (spec.name === "open_compose_for_review" || spec.name === "update_compose_for_review") {
            const prepared = await prepareAttachments(bridge, (args.attachments ?? []) as AttachmentInput[]);
            params.attachments = prepared.attachments;
            tokens = prepared.tokens;
          }
          let result;
          try { result = await bridge.call(spec.route, params); }
          finally {
            if (tokens.length) await Promise.all(tokens.map(token =>
              bridge.call("attachments.discard", { token }).catch(() => {})));
          }
          return { content: [{ type: "text" as const, text: wrapUntrusted(`Result of ${spec.name}:`, result) }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: publicErrorText(e) }] };
        }
      }
    );
  }
  return server;
}
