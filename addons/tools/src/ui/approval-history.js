// SPDX-License-Identifier: MIT
const root = document.getElementById("history");
try {
  const response = await messenger.runtime.sendMessage({ type: "approval.history" });
  if (!response?.ok) throw new Error("unavailable");
  for (const entry of response.result) {
    const section = document.createElement("section");
    const title = document.createElement("h2");
    title.textContent = `${new Date(entry.at).toLocaleString("nl-BE")} · ${entry.kind} · ${entry.status}`;
    const detail = document.createElement("pre");
    detail.textContent = JSON.stringify({ voorstel: entry.summary, redenen: entry.reasons, beslissing: entry.result, code: entry.code }, null, 2);
    section.append(title, detail); root.append(section);
  }
  if (!response.result.length) root.textContent = "Nog geen verzoeken.";
} catch { root.textContent = "Geschiedenis kon niet geladen worden."; }
