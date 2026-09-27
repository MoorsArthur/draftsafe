// SPDX-License-Identifier: MIT
import { call, el, fmt, setStatus } from "./common.js";

const status = document.getElementById("status");

function action(text, fn) {
  return el("button", {
    type: "button",
    text,
    onclick: async () => {
      try {
        await fn();
        await render();
      } catch (e) {
        setStatus(status, e.message, true);
      }
    },
  });
}

async function render() {
  const fu = document.getElementById("followups");
  const sn = document.getElementById("snoozed");
  const [{ followups, truncated }, snoozed] = await Promise.all([call("followup.list"), call("snooze.list")]);

  fu.replaceChildren();
  if (!followups.length) fu.append(el("li", { className: "empty", text: "No open follow-ups." }));
  for (const f of followups) {
    const due = f.due ? `${f.overdue ? "Overdue" : "Due"} ${fmt(f.due)}` : "No due date";
    fu.append(
      el("li", {}, [
        el("div", { className: "subject", text: f.subject || "(no subject)" }),
        el("div", { className: `meta${f.overdue ? " overdue" : ""}`, text: `${due} · ${f.author || ""}` }),
        el("div", { className: "actions" }, [
          action("Open", () => call("followup.open", { messageId: f.id })),
          action("Done", () => call("followup.done", { messageId: f.id })),
        ]),
      ])
    );
  }
  if (truncated) fu.append(el("li", { className: "empty", text: "Showing the first 500." }));

  sn.replaceChildren();
  if (!snoozed.length) sn.append(el("li", { className: "empty", text: "Nothing snoozed." }));
  for (const s of snoozed) {
    sn.append(
      el("li", {}, [
        el("div", { className: "subject", text: s.subject || "(no subject)" }),
        el("div", { className: "meta", text: `Back ${fmt(s.until)} · ${s.author || ""}` }),
        el("div", { className: "actions" }, [action("Unsnooze now", () => call("snooze.cancel", { key: s.key }))]),
      ])
    );
  }
}

render().catch(e => setStatus(status, e.message, true));
