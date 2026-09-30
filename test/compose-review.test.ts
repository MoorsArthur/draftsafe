import { describe, expect, it } from "vitest";
import { createRoutes } from "../addons/shared/lib/mail-routes.js";
import { createMailOps } from "../addons/shared/lib/mail-ops.js";
import { createFakeMessenger } from "./helpers/fake-messenger.js";

function setup(now = () => Date.now()) {
  const fake = createFakeMessenger();
  const routes = createRoutes({ ops: createMailOps({ api: fake.api, now }), version: "test" });
  return { fake, routes };
}

const newMail = { to: ["bob@example.test"], subject: "Please review", body: "Hello Bob.\nThanks." };

describe("agent-prepared native compose", () => {
  it("opens a plain-text composer, reports unsent, and requires closing it before another", async () => {
    const { fake, routes } = setup();
    const result: any = await routes["compose.openForReview"](newMail);
    expect(result).toMatchObject({ status: "awaiting_user_send", sent: false });
    expect(fake.api.compose.beginNew).toHaveBeenCalledWith(undefined, {
      isPlainText: true, plainTextBody: newMail.body, to: newMail.to, subject: newMail.subject,
    });
    expect(fake.composeTabs.size).toBe(1);
    expect(fake.api.notifications.create).toHaveBeenCalled();
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
    expect(fake.api.compose.saveMessage).not.toHaveBeenCalled();
    await expect(routes["compose.openForReview"](newMail)).rejects.toMatchObject({ code: "compose_busy" });
    const tab = [...fake.composeTabs.keys()][0];
    await fake.api.tabs.remove(tab);
    expect((await routes["compose.openForReview"](newMail)) as any).toMatchObject({ sent: false });
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

  it("uses Thunderbird's reply composer and account identity without overriding recipients or subject", async () => {
    const { fake, routes } = setup();
    const message = fake.addMessage({ folderId: "account1://INBOX", subject: "Question", text: "Can you?", headerMessageId: "q@x" });
    const result: any = await routes["compose.openForReview"]({ replyToMessageId: message.id, body: "Yes, I can." });
    expect(result).toMatchObject({ status: "awaiting_user_send", sent: false });
    expect(fake.api.compose.beginReply).toHaveBeenCalledWith(message.id, "replyToSender", {
      isPlainText: true, plainTextBody: "Yes, I can.", identityId: "id1",
    });
    expect([...fake.composeTabs.values()][0]).toMatchObject({ inReplyTo: "q@x", subject: "Re: Question" });
    expect(fake.api.compose.sendMessage).not.toHaveBeenCalled();
  });

  it("caps successful opens at twelve per rolling hour", async () => {
    let time = 100_000;
    const { fake, routes } = setup(() => time);
    for (let i = 0; i < 12; i++) {
      await routes["compose.openForReview"](newMail);
      await fake.api.tabs.remove([...fake.composeTabs.keys()][0]);
    }
    await expect(routes["compose.openForReview"](newMail)).rejects.toMatchObject({ code: "compose_rate_limit" });
    time += 60 * 60 * 1000 + 1;
    expect((await routes["compose.openForReview"](newMail)) as any).toMatchObject({ sent: false });
  });

  it("keeps the guard closed after an ambiguous compose API failure", async () => {
    const { fake, routes } = setup();
    fake.api.compose.beginNew.mockRejectedValueOnce(new Error("window result lost"));
    await expect(routes["compose.openForReview"](newMail)).rejects.toThrow(/window result lost/);
    await expect(routes["compose.openForReview"](newMail)).rejects.toMatchObject({ code: "compose_unknown" });
  });
});
