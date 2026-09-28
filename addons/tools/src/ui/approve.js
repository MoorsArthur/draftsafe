// SPDX-License-Identifier: MIT
// Mail and agent content is only ever inserted as text, never HTML or links.
const root = document.getElementById("content");
function element(tag, text, parent = root) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}
function reason(text, parent) {
  if (!text) return;
  element("strong", "Reden van de agent · onvertrouwde tekst", parent);
  element("p", text, parent).className = "reason";
}
function choice(parent, checked = true, disabled = false) {
  const label = element("label", undefined, parent);
  const select = document.createElement("select");
  for (const [value, title] of [["allow", "Toestaan"], ["deny", "Weigeren"]]) {
    const option = element("option", title, select); option.value = value;
  }
  select.value = checked ? "allow" : "deny";
  select.disabled = disabled;
  label.append(select, document.createTextNode(" Dit onderdeel"));
  return () => select.value === "allow";
}
function messages(groups, parent) {
  const inputs = [];
  for (const group of groups || []) {
    const details = element("details", undefined, parent);
    element("summary", `${group.sender} · ${group.items.length} berichten`, details);
    for (const item of group.items) {
      const label = element("label", undefined, details);
      const input = document.createElement("input"); input.type = "checkbox";
      input.checked = !item.skip; input.disabled = !!item.skip;
      label.append(input, document.createTextNode(`${item.subject || "(zonder onderwerp)"}${item.skip ? " · overgeslagen" : ""}`));
      if (!item.skip) inputs.push([item.id, input]);
    }
  }
  return () => inputs.filter(([, input]) => !input.checked).map(([id]) => id);
}
export function renderApproval(data) {
  const v = data.view;
  document.getElementById("status").textContent = `Vervalt om ${new Date(data.deadline).toLocaleTimeString("nl-BE")}. Sluiten betekent weigeren.`;
  const choices = [];
  let key;
  if (v.kind === "cleanup") {
    key = "batches";
    for (const b of v.batches) {
      const section = element("section");
      element("h2", `${({ trash: "Naar prullenbak", archive: "Archiveren", move: "Verplaatsen" })[b.action]} · ${b.total} berichten`, section);
      for (const d of b.destinations) element("p", `${d.label}${d.creates.length ? " · map wordt aangemaakt" : ""}`, section);
      reason(b.reason, section);
      const allowed = choice(section); const excluded = messages(b.groups, section);
      choices.push(() => ({ approved: allowed(), excluded: excluded() }));
    }
  } else if (v.kind === "unsubscribe") {
    key = "senders";
    for (const r of v.reasons) reason(r, root);
    element("p", "Uitschrijven bevestigt mogelijk dat je adres actief is. De afzender en bestemming zijn niet door Draftsafe geauthenticeerd.");
    for (const s of v.senders) {
      const section = element("section");
      element("h2", `${s.sender} · ${s.count} berichten`, section);
      element("p", s.method === "one_click" ? `Eenmalige HTTPS POST naar ${s.host}` : `Handmatig: ${s.why}`, section);
      if (s.inJunk) element("p", "Let op: deze afzender heeft mail in Ongewenst. Standaard geweigerd.", section).className = "warning";
      if (s.method !== "one_click") for (const target of s.targets) element("p", target, section);
      element("p", "Als je het bericht met de gekozen uitschrijflink uitsluit, wordt de hele afzender overgeslagen.", section);
      element("p", `Bericht met de gekozen link: ${s.items.find(i => i.id === s.sourceMessageId)?.subject || "(zonder onderwerp)"}`, section);
      const allowed = choice(section, s.defaultChecked, s.method !== "one_click");
      const excluded = messages([{ sender: s.sender, items: s.items }], section);
      choices.push(() => ({ approved: allowed(), excluded: excluded() }));
    }
  } else {
    key = "changes";
    for (const c of v.changes) {
      const section = element("section"); element("h2", c.label, section);
      const allowed = choice(section); const excluded = messages(c.groups || v.groups, section);
      choices.push(() => ({ approved: allowed(), excluded: excluded() }));
    }
    if (v.params) { element("p", "Voorstel van de agent · onvertrouwde tekst"); element("pre", JSON.stringify(v.params, null, 2)); }
    for (const preview of v.previews || []) {
      element("h2", preview.account);
      element("p", "Voorbeeld als je alle wijzigingen en berichten toestaat. Uitgesloten berichten blijven staan.");
      const trees = element("div"); trees.className = "trees";
      for (const [key, label] of [["before", "Voor"], ["after", "Na"]]) {
        const box = element("div", undefined, trees); element("h3", label, box);
        element("pre", preview[key].map(n => `${"  ".repeat(Math.min(n.depth - 1, 12))}${n.name} (${n.count ?? "?"})${n.special ? ` [${n.special}]` : ""}${n.mark ? ` · ${n.mark}` : ""}`).join("\n"), box);
      }
      if (preview.truncated) element("p", "Boomweergave ingekort tot 400 mappen.");
    }
  }
  return () => ({ [key]: choices.map(read => read()) });
}
try {
  const background = await messenger.runtime.getBackgroundPage();
  await background.attachApprovalPage(window, renderApproval);
} catch {
  document.getElementById("status").textContent = "Dit verzoek is niet meer beschikbaar.";
  document.getElementById("apply").disabled = true;
}
