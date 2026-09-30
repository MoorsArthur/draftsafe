import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAttachmentStage } from "../addons/shared/lib/attachment-stage.js";
import { prepareAttachments } from "../mcp/src/attachments.js";

const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

describe("bounded attachment staging", () => {
  it("preserves bytes, rejects replay and out-of-order chunks, and expires incomplete uploads", () => {
    let time = 0;
    const stage = createAttachmentStage({ now: () => time });
    const { token } = stage.begin({ name: "proof.pdf", size: 4, type: "application/pdf" });
    expect(() => stage.chunk({ token, offset: 1, data: "AAEC/w==" })).toThrow();
    expect(stage.chunk({ token, offset: 0, data: "AAEC/w==" })).toMatchObject({ complete: true });
    const file = stage.consume(token);
    expect(file.name).toBe("proof.pdf");
    expect(file.size).toBe(4);
    expect(() => stage.consume(token)).toThrow();
    const pending = stage.begin({ name: "later.txt", size: 1 });
    time += 5 * 60 * 1000 + 1;
    expect(() => stage.chunk({ token: pending.token, offset: 0, data: "YQ==" })).toThrow();
  });

  it("stages local bytes in authenticated bridge chunks and rejects a symlink and hidden file", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "draftsafe-attachment-"));
    folders.push(folder);
    vi.stubEnv("DRAFTSAFE_ATTACHMENT_ROOTS", folder);
    const bytes = Buffer.alloc(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const file = path.join(folder, "report.pdf");
    await writeFile(file, bytes);
    const stage = createAttachmentStage();
    const bridge = { call: vi.fn(async (route: string, params: any) => {
      if (route === "attachments.begin") return stage.begin(params);
      if (route === "attachments.chunk") return stage.chunk(params);
      if (route === "attachments.discard") return stage.discard(params);
      throw new Error(route);
    }) };
    const prepared = await prepareAttachments(bridge, [{ source: "local", path: file }]);
    const attached = stage.consume((prepared.attachments[0] as any).stagedToken);
    expect(Buffer.from(await attached.arrayBuffer())).toEqual(bytes);
    expect(bridge.call.mock.calls.filter(([route]) => route === "attachments.chunk").length).toBe(3);
    const link = path.join(folder, "linked.pdf");
    await symlink(file, link);
    await expect(prepareAttachments(bridge, [{ source: "local", path: link }])).rejects.toMatchObject({ code: "attachment_limit" });
    const hidden = path.join(folder, ".env");
    await writeFile(hidden, "not-read");
    await expect(prepareAttachments(bridge, [{ source: "local", path: hidden }])).rejects.toMatchObject({ code: "attachment_denied" });
  });
});
