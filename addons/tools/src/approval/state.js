// SPDX-License-Identifier: MIT
import { validateStateRequest } from "../../../shared/lib/state-request.js";
import { createRoutes } from "../../../shared/lib/mail-routes.js";
import { createMailOps } from "../../../shared/lib/mail-ops.js";
import { decisionList, DecisionError, snapshotMessage, stillSame, groupBySender } from "./common.js";

export async function planState(api, payload) {
  const input = await validateStateRequest(payload);
  const ids = input.params.messageIds || [input.params.messageId || input.params.replyToMessageId].filter(Boolean);
  const snaps = [];
  for (const id of ids) snaps.push(await snapshotMessage(api, id));
  const readDecision = d => decisionList(d, "changes", 1).map(c => {
    const excluded = c.excluded || [];
    if (!Array.isArray(excluded) || new Set(excluded).size !== excluded.length || excluded.some(id => !ids.includes(id))) throw new DecisionError("invalid exclusion");
    return { approved: c.approved, excluded };
  });
  return {
    binding: { input, snaps },
    view: { kind: "state", changes: [{ action: input.route, label: input.route }], params: input.params, groups: groupBySender(snaps) },
    readDecision,
    async execute(decision) {
      const choice = readDecision(decision)[0];
      if (!choice.approved) return { changed: false };
      const selected = snaps.filter(s => !choice.excluded.includes(s.id));
      if (snaps.length && !selected.length) return { changed: false };
      for (const snap of selected) if (!(await stillSame(api, snap))) return { changed: false, refused: true };
      const params = structuredClone(input.params);
      if (["messages.setTags", "messages.markRead"].includes(input.route)) {
        delete params.messageId; params.messageIds = selected.map(s => s.id);
      }
      return createRoutes({ ops: createMailOps({ api }), version: "tools" })[input.route](params);
    },
  };
}
