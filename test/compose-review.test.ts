import { describe, expect, it } from "vitest";
import { createRoutes } from "../addons/shared/lib/mail-routes.js";
import { createMailOps } from "../addons/shared/lib/mail-ops.js";
import { createFakeMessenger } from "./helpers/fake-messenger.js";

function setup(now = () => Date.now(), opts: Parameters<typeof createFakeMessenger>[0] = {}) {
  const fake = createFakeMessenger(opts);
  const routes = createRoutes({ ops: createMailOps({ api: fake.api, now }), version: "test" });
  return { fake, routes };
}

const newMail = { to: ["bob@example.test"], subject: "Please review", body: "Hello Bob.\nThanks." };

describe("agent-prepared native compose", () => {
  it("keeps an HTML identity signature in a new composer and escapes agent text", async () => {
    const { fake, routes } = setup(() => Date.now(), { withHtmlSignature: true });
    const body = 'Hello <Bob> & "team".\nLine two\n\nVisit https://example.test';
    const result: any = await routes["compose.openForReview"]({ ...newMail, body });
    expect(result).toMatchObject({ status: "awaiting_user_send", sent: false });
    expect(fake.api.compose.beginNew).toHaveBeenCalledWith(undefined, {
      to: newMail.to, subject: newMail.subject,
    });
    const composed = [...fake.composeTabs.values()][0];
    expect(composed.isPlainText).toBe(false);
    expect(composed.body).toBe('<html><body><p>Hello &lt;Bob&gt; &amp; &quot;team&quot;.<br>Line two</p><p>Visit https://example.test</p><div class="moz-signature"><img src="cid:logo">Arthur</div></body></html>');
    expect(String(composed.body)).not.toContain("<a ");
    expect(fake.api.compose.setComposeDetails).toHaveBeenCalledWith(expect.any(Number), { body: composed.body });
    expect(fake.composeTabs.size).toBe(1);
    expect(fake.api.notifications.create).toHaveBeenCalled();
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
    expect(fake.api.compose.saveMessage).not.toHaveBeenCalled();
    const second: any = await routes["compose.openForReview"]({ ...newMail, subject: "Another message", newWindow: true });
    expect(second).toMatchObject({ sent: false, tabId: 101 });
    expect(fake.composeTabs.size).toBe(2);
  });

  it("keeps a plain-text identity without a signature in plain-text mode", async () => {
    const { fake, routes } = setup();
    await routes["compose.openForReview"](newMail);
    const composed = [...fake.composeTabs.values()][0];
    expect(composed).toMatchObject({ isPlainText: true, plainTextBody: newMail.body });
    expect(fake.api.compose.setComposeDetails).toHaveBeenCalledWith(expect.any(Number), { plainTextBody: newMail.body });
  });

  it("rejects hidden send fields, bad recipients, header injection, and mixed reply inputs", async () => {
    const { fake, routes } = setup();
    for (const p of [
      { ...newMail, send: true }, { ...newMail, bcc: ["secret@example.test"] },
      { ...newMail, attachments: [{ path: "/tmp/x" }] }, { ...newMail, html: "<b>x</b>" },
      { ...newMail, to: ["bob@example.test\r\nBcc: secret@example.test"] },
      { ...newMail, subject: "Hello\r\nBcc: secret@example.test" },
      { ...newMail, replyToMessageId: 1 },
      { body: "reply", replyToMessageId: 1, identityId: "id1" },
    ]) await expect(routes["compose.openForReview"](p)).rejects.toMatchObject({ code: "invalid_params" });
    expect(fake.api.compose.beginNew).not.toHaveBeenCalled();
    expect(fake.api.compose.beginReply).not.toHaveBeenCalled();
  });

  it("keeps Thunderbird's HTML reply quote, signature and account identity", async () => {
    const { fake, routes } = setup(() => Date.now(), { withHtmlSignature: true });
    const message = fake.addMessage({ folderId: "account1://INBOX", subject: "Question", text: "Can you?", headerMessageId: "q@x" });
    const result: any = await routes["compose.openForReview"]({ replyToMessageId: message.id, body: "Yes <b>I</b> can." });
    expect(result).toMatchObject({ status: "awaiting_user_send", sent: false });
    expect(fake.api.compose.beginReply).toHaveBeenCalledWith(message.id, "replyToSender", {
      identityId: "id1",
    });
    expect([...fake.composeTabs.values()][0]).toMatchObject({
      inReplyTo: "q@x", subject: "Re: Question", isPlainText: false,
      body: '<html><body><p>Yes &lt;b&gt;I&lt;/b&gt; can.</p><blockquote>Can you?</blockquote><div class="moz-signature"><img src="cid:logo">Arthur</div></body></html>',
    });
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps a plain-text reply quote without adding a signature", async () => {
    const { fake, routes } = setup(() => Date.now(), { plainTextCompose: true });
    const message = fake.addMessage({ folderId: "account1://INBOX", subject: "Question", text: "Can you?" });
    await routes["compose.openForReview"]({ replyToMessageId: message.id, body: "Yes, I can." });
    expect([...fake.composeTabs.values()][0]).toMatchObject({
      isPlainText: true, plainTextBody: "Yes, I can.\n\nOn Alice wrote:\n> Can you?",
    });
  });

  it("allows more than twelve sequential composers in one hour", async () => {
    const { fake, routes } = setup(() => 100_000);
    for (let i = 0; i < 20; i++) {
      await routes["compose.openForReview"](newMail);
      await fake.api.tabs.remove([...fake.composeTabs.keys()][0]);
    }
    expect((await routes["compose.openForReview"](newMail)) as any).toMatchObject({ sent: false });
  });

  it("allows at least ten simultaneous windows and tracks their IDs", async () => {
    const { fake, routes } = setup();
    const ids: number[] = [];
    for (let n = 0; n < 10; n++) ids.push((await routes["compose.openForReview"]({ ...newMail, subject: `Message ${n}`, newWindow: n > 0 }) as any).tabId);
    expect(new Set(ids).size).toBe(10);
    await fake.api.tabs.remove(ids[0]);
    expect((await routes["compose.openForReview"]({ ...newMail, newWindow: true }) as any).tabId).toBeGreaterThan(ids[9]);
  });

  it("closes a unique unchanged agent composer and confirms removal without sending", async () => {
    const { fake, routes } = setup();
    const opened: any = await routes["compose.openForReview"](newMail);
    expect(await routes["compose.closeForReview"]({})).toEqual({
      status: "closed", closed: true, tabId: opened.tabId, sent: false,
    });
    expect(fake.api.tabs.remove).toHaveBeenCalledWith(opened.tabId);
    expect((await routes["compose.listForReview"]({}) as any).composers).toEqual([]);
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("requires an ID with multiple composers and closes only the selected one", async () => {
    const { fake, routes } = setup();
    const first: any = await routes["compose.openForReview"](newMail);
    const second: any = await routes["compose.openForReview"]({ ...newMail, subject: "Other", newWindow: true });
    await expect(routes["compose.closeForReview"]({})).rejects.toMatchObject({ code: "compose_ambiguous" });
    expect(await routes["compose.closeForReview"]({ tabId: second.tabId })).toMatchObject({ closed: true });
    expect(fake.composeTabs.has(first.tabId)).toBe(true);
    expect((await routes["compose.listForReview"]({}) as any).composers).toMatchObject([{ tabId: first.tabId }]);
  });

  it("refuses user-created or user-edited windows and smuggled parameters", async () => {
    const { fake, routes } = setup();
    const userTab = await fake.api.compose.beginNew(undefined, { to: ["friend@example.test"], subject: "Own message" });
    await expect(routes["compose.closeForReview"]({ tabId: userTab.id })).rejects.toMatchObject({ code: "not_found" });
    const opened: any = await routes["compose.openForReview"](newMail);
    await fake.api.compose.setComposeDetails(opened.tabId, { subject: "Arthur's edit" });
    await expect(routes["compose.closeForReview"]({ tabId: opened.tabId })).rejects.toMatchObject({ code: "compose_conflict" });
    await expect(routes["compose.closeForReview"]({ tabId: opened.tabId, send: true })).rejects.toMatchObject({ code: "invalid_params" });
    expect(fake.composeTabs.has(userTab.id)).toBe(true);
    expect(fake.composeTabs.has(opened.tabId)).toBe(true);
    expect(fake.api.tabs.remove).not.toHaveBeenCalled();
  });

  it("does not claim a close when Thunderbird leaves the window open", async () => {
    const { fake, routes } = setup();
    const opened: any = await routes["compose.openForReview"](newMail);
    fake.api.tabs.remove.mockImplementationOnce(async () => {});
    expect(await routes["compose.closeForReview"]({ tabId: opened.tabId })).toMatchObject({
      status: "close_unconfirmed", closed: false,
    });
    expect((await routes["compose.listForReview"]({}) as any)).toMatchObject({
      composers: [{ tabId: opened.tabId }], uncertain: true,
    });
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("fails closed when Thunderbird rejects a close", async () => {
    const { fake, routes } = setup();
    const opened: any = await routes["compose.openForReview"](newMail);
    fake.api.tabs.remove.mockRejectedValueOnce(new Error("native prompt failed"));
    await expect(routes["compose.closeForReview"]({ tabId: opened.tabId })).rejects.toMatchObject({ code: "compose_unknown" });
    expect(fake.composeTabs.has(opened.tabId)).toBe(true);
    expect((await routes["compose.listForReview"]({}) as any).uncertain).toBe(true);
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("updates only its own unedited composer and preserves the HTML signature", async () => {
    const { fake, routes } = setup(() => Date.now(), { withHtmlSignature: true });
    const opened: any = await routes["compose.openForReview"](newMail);
    const changed: any = await routes["compose.updateForReview"]({
      tabId: opened.tabId, body: "Revised <text>", to: ["new@example.test"], subject: "New subject",
    });
    expect(changed).toMatchObject({ tabId: opened.tabId, sent: false });
    expect(fake.composeTabs.get(opened.tabId)).toMatchObject({
      to: ["new@example.test"], subject: "New subject",
      body: '<html><body><p>Revised &lt;text&gt;</p><div class="moz-signature"><img src="cid:logo">Arthur</div></body></html>',
    });
    await fake.api.compose.setComposeDetails(opened.tabId, { subject: "Arthur changed this" });
    await expect(routes["compose.updateForReview"]({ tabId: opened.tabId, body: "Overwrite?" }))
      .rejects.toMatchObject({ code: "compose_conflict" });
    expect(fake.composeTabs.get(opened.tabId)?.subject).toBe("Arthur changed this");
  });

  it("finds the existing composer, updates it without an ID when unique, and blocks a duplicate open", async () => {
    const { fake, routes } = setup();
    const opened: any = await routes["compose.openForReview"](newMail);
    await expect(routes["compose.openForReview"]({ ...newMail, body: "A revised body" }))
      .rejects.toMatchObject({ code: "compose_exists" });
    await expect(routes["compose.openForReview"]({ ...newMail, subject: "Revised subject", body: "A revised body" }))
      .rejects.toMatchObject({ code: "compose_exists" });
    await expect(routes["compose.openForReview"]({ ...newMail, newWindow: true, body: "A revised body" }))
      .rejects.toMatchObject({ code: "compose_exists" });
    const listed: any = await routes["compose.listForReview"]({});
    expect(listed.composers).toMatchObject([{ tabId: opened.tabId, subject: newMail.subject, userEdited: false }]);
    const updated: any = await routes["compose.updateForReview"]({ body: "A revised body" });
    expect(updated.tabId).toBe(opened.tabId);
    expect(fake.composeTabs.size).toBe(1);
    expect(fake.composeTabs.get(opened.tabId)?.plainTextBody).toBe("A revised body");
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("requires a tab ID for an edit when several composers are open", async () => {
    const { fake, routes } = setup();
    const first: any = await routes["compose.openForReview"](newMail);
    await routes["compose.openForReview"]({ ...newMail, subject: "Other subject", newWindow: true });
    await expect(routes["compose.updateForReview"]({ body: "Which one?" }))
      .rejects.toMatchObject({ code: "compose_ambiguous" });
    expect(fake.composeTabs.get(first.tabId)?.plainTextBody).toBe(newMail.body);
  });

  it("adds an existing email attachment and removes it during an update", async () => {
    const { fake, routes } = setup();
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const message = fake.addMessage({ folderId: "account1://INBOX", subject: "File",
      attachments: [{ name: "proof.pdf", contentType: "application/pdf", size: bytes.length, partName: "1.2", bytes }] });
    const opened: any = await routes["compose.openForReview"]({ ...newMail,
      attachments: [{ messageId: message.id, partName: "1.2" }] });
    expect(opened.attachments).toMatchObject([{ name: "proof.pdf", size: 4 }]);
    expect(new Uint8Array(await fake.composeAttachments.get(opened.tabId)![0].file.arrayBuffer())).toEqual(bytes);
    const updated: any = await routes["compose.updateForReview"]({
      tabId: opened.tabId, body: "No file", removeAttachmentIds: [opened.attachments[0].id],
    });
    expect(updated.attachments).toEqual([]);
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("preserves a native inline signature logo without counting it as an agent attachment", async () => {
    const { fake, routes } = setup(() => Date.now(), {
      withHtmlSignature: true, withInlineLogoAttachment: true,
    });
    const message = fake.addMessage({ folderId: "account1://INBOX", subject: "File",
      attachments: [{ name: "proof.pdf", contentType: "application/pdf", size: 1, partName: "1.2" }] });
    const opened: any = await routes["compose.openForReview"]({ ...newMail,
      attachments: [{ messageId: message.id, partName: "1.2" }] });
    expect(opened.attachments).toMatchObject([{ name: "proof.pdf" }]);
    expect(fake.composeAttachments.get(opened.tabId)?.map(a => a.name)).toEqual(["signature-logo.png", "proof.pdf"]);
    await expect(routes["compose.updateForReview"]({
      tabId: opened.tabId, body: "No", removeAttachmentIds: [fake.composeAttachments.get(opened.tabId)![0].id],
    })).rejects.toMatchObject({ code: "invalid_params" });
    const updated: any = await routes["compose.updateForReview"]({
      tabId: opened.tabId, body: "Changed", removeAttachmentIds: [opened.attachments[0].id],
    });
    expect(updated.attachments).toEqual([]);
    expect(fake.composeAttachments.get(opened.tabId)?.map(a => a.name)).toEqual(["signature-logo.png"]);
  });

  it("keeps the guard closed after an ambiguous compose API failure", async () => {
    const { fake, routes } = setup();
    fake.api.compose.beginNew.mockRejectedValueOnce(new Error("window result lost"));
    await expect(routes["compose.openForReview"](newMail)).rejects.toThrow(/window result lost/);
    await expect(routes["compose.openForReview"](newMail)).rejects.toMatchObject({ code: "compose_unknown" });
  });

  it("keeps the guard closed if a window opens but its body cannot be updated", async () => {
    const { fake, routes } = setup();
    fake.api.compose.setComposeDetails.mockRejectedValueOnce(new Error("compose closed"));
    await expect(routes["compose.openForReview"](newMail)).rejects.toThrow(/compose closed/);
    await expect(routes["compose.openForReview"](newMail)).rejects.toMatchObject({ code: "compose_unknown" });
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
  });
});
