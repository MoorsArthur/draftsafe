import { afterEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { download, newer, parseBundle, readActive, readUpdateStatus, rollback, safeUpdateError,
  stageRelease, verifyMetadata, writeUpdateStatus } from "../scripts/update-core.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(version = "0.8.0", files?: Record<string, string>) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const pkg = { name: "draftsafe-mcp", version };
  const lock = { name: "draftsafe-mcp", version, lockfileVersion: 3, packages: { "": { version } } };
  const bundle = Buffer.from(JSON.stringify({ schema: 1, version, files: files ?? {
    "package.json": Buffer.from(JSON.stringify(pkg)).toString("base64"),
    "package-lock.json": Buffer.from(JSON.stringify(lock)).toString("base64"),
    "dist/index.js": Buffer.from("process.exit(0)").toString("base64"),
  } }));
  const payload = { schema: 1, version, bundleUrl: "https://updates.example.test/bundle.json",
    sha256: createHash("sha256").update(bundle).digest("hex") };
  const metadata = { ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64") };
  const fetchImpl = async (url: string) => new Response(url === payload.bundleUrl ? bundle : JSON.stringify(metadata));
  return { key, bundle, metadata, fetchImpl };
}

describe("signed MCP updates", () => {
  it("follows bounded HTTPS asset redirects without credentials", async () => {
    const seen: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = async (url: string, options: RequestInit) => {
      seen.push({ url, options });
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://assets.example.test/release.json" } })
        : new Response("bundle");
    };
    expect((await download("https://github.example.test/release", 100, fetchImpl)).toString()).toBe("bundle");
    expect(seen.map(call => call.url)).toEqual([
      "https://github.example.test/release", "https://assets.example.test/release.json",
    ]);
    expect(seen.every(call => call.options.credentials === "omit" && call.options.redirect === "manual")).toBe(true);
    await expect(download("https://github.example.test/release", 100,
      async () => new Response(null, { status: 302, headers: { location: "http://unsafe.example.test/file" } })))
      .rejects.toThrow(/HTTPS/);
  });

  it("compares versions numerically and refuses path traversal in a bundle", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("0.7.0", "0.7.0")).toBe(false);
    const f = fixture();
    expect(parseBundle(f.bundle, "0.8.0").has("dist/index.js")).toBe(true);
    const bad = fixture("0.8.0", { "../outside": "YQ==" });
    expect(() => parseBundle(bad.bundle, "0.8.0")).toThrow(/files/);
  });

  it("requires the pinned signing key and exact metadata contents", () => {
    const f = fixture();
    expect(verifyMetadata(f.metadata, f.key).version).toBe("0.8.0");
    expect(() => verifyMetadata({ ...f.metadata, version: "0.9.0" }, f.key)).toThrow(/signature/);
    expect(() => verifyMetadata({ ...f.metadata, extra: "x" }, f.key)).toThrow(/metadata/);
    expect(() => verifyMetadata(f.metadata, fixture().key)).toThrow(/signature/);
  });

  it("stages a verified release, keeps the previous version, and supports rollback", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draftsafe-updater-")); dirs.push(dir);
    const f = fixture();
    const result = await stageRelease({ metadataUrl: "https://updates.example.test/manifest.json",
      publicKeyDer: f.key, bundledVersion: "0.7.0", dataDir: dir, fetchImpl: f.fetchImpl,
      installDependencies: async (stage: string) => { mkdirSync(path.join(stage, "node_modules")); } });
    expect(result).toEqual({ status: "staged", version: "0.8.0", previous: "0.7.0" });
    expect(readFileSync(path.join(dir, "versions/0.8.0/dist/index.js"), "utf8")).toBe("process.exit(0)");
    expect(await readActive(dir)).toBe("0.8.0");
    expect(await rollback(dir)).toBe("0.7.0");
    expect(await readActive(dir)).toBe("0.7.0");
    expect(await stageRelease({ metadataUrl: "https://updates.example.test/manifest.json",
      publicKeyDer: f.key, bundledVersion: "0.7.0", dataDir: dir, fetchImpl: f.fetchImpl,
      installDependencies: async () => { throw new Error("must not reinstall blocked release"); } }))
      .toEqual({ status: "held_back", version: "0.7.0", blockedVersion: "0.8.0" });
    await expect(rollback(dir)).rejects.toThrow(/No previous release/);
    const next = fixture("0.9.0");
    expect(await stageRelease({ metadataUrl: "https://updates.example.test/manifest.json",
      publicKeyDer: next.key, bundledVersion: "0.7.0", dataDir: dir, fetchImpl: next.fetchImpl,
      install: false })).toEqual({ status: "verified", version: "0.9.0" });
  });

  it("recovers a lock left by a dead update worker", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draftsafe-updater-")); dirs.push(dir);
    writeFileSync(path.join(dir, "update.lock"), JSON.stringify({ pid: 999999999, startedAt: Date.now() }));
    const f = fixture();
    const result = await stageRelease({ metadataUrl: "https://updates.example.test/manifest.json",
      publicKeyDer: f.key, bundledVersion: "0.7.0", dataDir: dir, fetchImpl: f.fetchImpl,
      install: false });
    expect(result).toEqual({ status: "verified", version: "0.8.0" });
  });

  it("does not steal a live updater lock", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draftsafe-updater-")); dirs.push(dir);
    writeFileSync(path.join(dir, "update.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const f = fixture();
    expect(await stageRelease({ metadataUrl: "https://updates.example.test/manifest.json",
      publicKeyDer: f.key, bundledVersion: "0.7.0", dataDir: dir, fetchImpl: f.fetchImpl,
      install: false })).toEqual({ status: "already_checking" });
  });

  it("records bounded private update status without raw errors or URLs", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draftsafe-updater-")); dirs.push(dir);
    expect(safeUpdateError(new Error("https://private.example/token=secret"))).toBe("download_failed");
    const checkedAt = new Date().toISOString();
    await writeUpdateStatus({ checkedAt, status: "failed", code: "download_failed",
      bundleUrl: "https://private.example/token=secret" }, dir);
    const file = path.join(dir, "update-status.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toMatch(/private|secret|bundleUrl/);
    expect(await readUpdateStatus(dir)).toEqual({ checkedAt, status: "failed", code: "download_failed" });
    writeFileSync(file, "x".repeat(513));
    await expect(readUpdateStatus(dir)).rejects.toThrow(/Unsafe update state file/);
  });

  it("prints only the safe last-check record from --update-status", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draftsafe-updater-")); dirs.push(dir);
    const checkedAt = new Date().toISOString();
    await writeUpdateStatus({ checkedAt, status: "staged", version: "0.8.0" },
      path.join(dir, "draftsafe-mcp"));
    const launcher = path.resolve("scripts/launch.mjs");
    const result = spawnSync(process.execPath, [launcher, "--update-status"], {
      env: { ...process.env, XDG_DATA_HOME: dir }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ checkedAt, status: "staged", version: "0.8.0" });
    expect(result.stderr).toBe("");
  });

  it("records missing opt-in configuration without attempting a download", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draftsafe-updater-")); dirs.push(dir);
    const worker = path.resolve("scripts/update-worker.mjs");
    const result = spawnSync(process.execPath, [worker], {
      env: { ...process.env, XDG_DATA_HOME: dir, DRAFTSAFE_AUTO_UPDATE: "1",
        DRAFTSAFE_UPDATE_URL: "", DRAFTSAFE_UPDATE_PUBLIC_KEY: "", DRAFTSAFE_BUNDLED_VERSION: "0.7.0" },
      encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(await readUpdateStatus(path.join(dir, "draftsafe-mcp"))).toMatchObject({
      status: "failed", code: "configuration_missing" });
  });

  it("rejects symlinks and writable update storage before reading or staging", async () => {
    if (typeof process.getuid !== "function") return;
    const dir = mkdtempSync(path.join(os.tmpdir(), "draftsafe-updater-")); dirs.push(dir);
    const link = `${dir}-link`; dirs.push(link);
    symlinkSync(dir, link);
    await expect(readActive(link)).rejects.toThrow(/Unsafe update directory/);
    const f = fixture();
    chmodSync(dir, 0o777);
    await expect(stageRelease({ metadataUrl: "https://updates.example.test/manifest.json",
      publicKeyDer: f.key, bundledVersion: "0.7.0", dataDir: dir, fetchImpl: f.fetchImpl,
      install: false })).rejects.toThrow(/Unsafe update directory/);
    chmodSync(dir, 0o700);
    mkdirSync(path.join(dir, "versions"), { mode: 0o777 });
    chmodSync(path.join(dir, "versions"), 0o777);
    await expect(stageRelease({ metadataUrl: "https://updates.example.test/manifest.json",
      publicKeyDer: f.key, bundledVersion: "0.7.0", dataDir: dir, fetchImpl: f.fetchImpl,
      installDependencies: async () => {} })).rejects.toThrow(/Unsafe update directory/);
    writeFileSync(path.join(dir, "active.json"), JSON.stringify({ version: "0.8.0" }), { mode: 0o666 });
    chmodSync(path.join(dir, "active.json"), 0o666);
    await expect(readActive(dir)).rejects.toThrow(/Unsafe update state file/);
  });

  it("leaves the current release untouched after a checksum mismatch", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "draftsafe-updater-")); dirs.push(dir);
    const f = fixture();
    await expect(stageRelease({ metadataUrl: "https://updates.example.test/manifest.json",
      publicKeyDer: f.key, bundledVersion: "0.7.0", dataDir: dir,
      fetchImpl: async (url: string) => new Response(url.endsWith("bundle.json") ? "tampered" : JSON.stringify(f.metadata)) }))
      .rejects.toThrow(/checksum/);
    expect(await readActive(dir)).toBeNull();
  });
});
