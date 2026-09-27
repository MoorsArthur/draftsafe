// SPDX-License-Identifier: MIT
import { call, setStatus } from "./common.js";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "followup" ? "followup" : "snooze";
const messageIds = (params.get("ids") || "")
  .split(",")
  .map(Number)
  .filter(n => Number.isInteger(n) && n > 0);
const status = document.getElementById("status");
const input = document.getElementById("when");

document.getElementById("title").textContent = mode === "snooze" ? "Snooze until" : "Follow up by";

const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
start.setHours(8, 0, 0, 0);
const pad = n => String(n).padStart(2, "0");
input.value = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T08:00`;

document.getElementById("form").addEventListener("submit", async ev => {
  ev.preventDefault();
  try {
    await call(mode === "snooze" ? "snooze.ids" : "followup.setIds", { messageIds, when: input.value });
    window.close();
  } catch (e) {
    setStatus(status, e.message, true);
  }
});
