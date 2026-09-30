import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).messenger;
});

describe("bridge startup publication", () => {
  it("rewrites the connection file after a transient publication failure", async () => {
    vi.useFakeTimers();
    const publishConnection = vi.fn()
      .mockRejectedValueOnce(new Error("profile path temporarily unavailable"))
      .mockResolvedValue({ path: "/snapcommon/draftsafe-mcp/connection.json" });
    const start = vi.fn(async () => ({ port: 5555 }));
    (globalThis as any).messenger = {
      runtime: { getManifest: () => ({ version: "0.3.1" }) },
      tabs: { onRemoved: { addListener: vi.fn() } },
      draftsafeBridge: { onRequest: { addListener: vi.fn() }, start, publishConnection },
    };
    vi.resetModules();
    const mod = await import("../addons/bridge/src/background.js");
    await mod.configureBridge(async () => ({ status: "denied" }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publishConnection).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
