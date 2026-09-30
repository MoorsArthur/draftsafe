// SPDX-License-Identifier: MIT
// No bridge token or mailbox access belongs in the update process.
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, stat, writeFile, rm, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "draftsafe-mcp");
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FILE = /^(?:package(?:-lock)?\.json|dist\/[a-z][a-z0-9-]*\.js)$/;
const METADATA_LIMIT = 8192;
const BUNDLE_LIMIT = 5_000_000;
const UPDATE_STATUSES = new Set(["already_checking", "current", "held_back", "verified", "staged", "failed"]);
const UPDATE_ERROR_CODES = new Set(["configuration_missing", "invalid_release", "checksum_mismatch", "download_failed", "dependency_install_failed", "update_failed"]);

export function newer(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error("Invalid release version");
  const aa = a.split(".").map(Number), bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
}

export function verifyMetadata(raw, publicKeyDer) {
  if (!raw || typeof raw !== "object" || Object.keys(raw).sort().join(",") !==
      "bundleUrl,schema,sha256,signature,version") throw new Error("Invalid update metadata");
  const { schema, version, bundleUrl, sha256, signature } = raw;
  if (schema !== 1 || typeof version !== "string" || !VERSION.test(version) ||
      typeof bundleUrl !== "string" || new URL(bundleUrl).protocol !== "https:" ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
      typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature))
    throw new Error("Invalid update metadata");
  const key = createPublicKey({ key: Buffer.from(publicKeyDer, "base64"), format: "der", type: "spki" });
  const signed = Buffer.from(JSON.stringify({ schema, version, bundleUrl, sha256 }));
  if (!verify(null, signed, key, Buffer.from(signature, "base64"))) throw new Error("Invalid release signature");
  return { version, bundleUrl, sha256 };
}

export async function download(url, limit, fetchImpl = fetch) {
  let current = new URL(url);
  for (let hop = 0; hop <= 3; hop++) {
    if (current.protocol !== "https:" || current.username || current.password)
      throw new Error("Update URL must use HTTPS without credentials");
    const response = await fetchImpl(current.href, {
      redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(10_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || hop === 3) throw new Error("Update download exceeded redirect limit");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Update download failed (${response.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("Update download exceeds size limit");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Update download exceeded redirect limit");
}

export function parseBundle(bytes, expectedVersion) {
  if (bytes.length > BUNDLE_LIMIT) throw new Error("Update bundle exceeds size limit");
  const bundle = JSON.parse(bytes.toString("utf8"));
  if (bundle?.schema !== 1 || bundle.version !== expectedVersion ||
      !bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files))
    throw new Error("Invalid update bundle");
  const names = Object.keys(bundle.files);
  if (!names.includes("package.json") || !names.includes("package-lock.json") ||
      !names.includes("dist/index.js") || names.length > 40 || names.some(name => !FILE.test(name)))
    throw new Error("Invalid update bundle files");
  const files = new Map();
  for (const name of names) {
    const encoded = bundle.files[name];
    if (typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw new Error("Invalid update bundle encoding");
    const data = Buffer.from(encoded, "base64");
    if (data.length > 1_000_000 || data.toString("base64") !== encoded) throw new Error("Invalid update bundle file");
    files.set(name, data);
  }
  const pkg = JSON.parse(files.get("package.json").toString("utf8"));
  const lock = JSON.parse(files.get("package-lock.json").toString("utf8"));
  if (pkg.name !== "draftsafe-mcp" || pkg.version !== expectedVersion ||
      lock.name !== pkg.name || lock.version !== pkg.version ||
      lock.packages?.[""]?.version !== pkg.version)
    throw new Error("Update package and lockfile do not match release");
  return files;
}

async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

async function privateDirectory(dir, create = false) {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(dir); }
  catch (error) { if (!create && error?.code === "ENOENT") return false; throw error; }
  if (!info.isDirectory() ||
      (typeof process.getuid === "function" && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)))
    throw new Error("Unsafe update directory");
  return true;
}

async function privateJson(file, limit) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.size > limit ||
      (typeof process.getuid === "function" && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)))
    throw new Error("Unsafe update state file");
  return JSON.parse(await readFile(file, "utf8"));
}

export function safeUpdateError(error) {
  const message = String(error?.message || "");
  if (/checksum mismatch/i.test(message)) return "checksum_mismatch";
  if (/dependency install failed/i.test(message)) return "dependency_install_failed";
  if (/signature|metadata|release version|update bundle|bundle file|update package|lockfile/i.test(message))
    return "invalid_release";
  if (/download|https|fetch|network|timeout|abort/i.test(message)) return "download_failed";
  return "update_failed";
}

function validateUpdateStatus(value) {
  if (!value || typeof value !== "object" || !UPDATE_STATUSES.has(value.status) ||
      typeof value.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.checkedAt) ||
      (value.version !== undefined && (typeof value.version !== "string" || !VERSION.test(value.version))) ||
      (value.code !== undefined && !UPDATE_ERROR_CODES.has(value.code)) ||
      (value.status === "failed") !== (value.code !== undefined))
    throw new Error("Invalid update status");
  return { checkedAt: value.checkedAt, status: value.status,
    ...(value.version ? { version: value.version } : {}),
    ...(value.code ? { code: value.code } : {}) };
}

export async function writeUpdateStatus(value, dataDir = DATA_DIR) {
  const safe = validateUpdateStatus(value);
  await privateDirectory(dataDir, true);
  await atomicJson(path.join(dataDir, "update-status.json"), safe);
}

export async function readUpdateStatus(dataDir = DATA_DIR) {
  if (!(await privateDirectory(dataDir))) return null;
  const file = path.join(dataDir, "update-status.json");
  const status = await privateJson(file, 512);
  return status === null ? null : validateUpdateStatus(status);
}

export async function readActive(dataDir = DATA_DIR) {
  if (!(await privateDirectory(dataDir))) return null;
  const state = await privateJson(path.join(dataDir, "active.json"), 512);
  if (state === null) return null;
  if (typeof state.version !== "string" || !VERSION.test(state.version))
    throw new Error("Invalid active release state");
  return state.version;
}

async function acquireUpdateLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        return handle;
      } catch (error) {
        await handle.close();
        await unlink(lockPath);
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const details = await stat(lockPath).catch(e => e?.code === "ENOENT" ? null : Promise.reject(e));
      if (!details) continue;
      let holder;
      try { holder = JSON.parse(await readFile(lockPath, "utf8")); } catch { holder = null; }
      // A second worker may see the file before its owner writes the PID.
      if (!Number.isSafeInteger(holder?.pid) || holder.pid <= 0) {
        if (Date.now() - details.mtimeMs < 60_000) return null;
      } else {
        try { process.kill(holder.pid, 0); return null; }
        catch (e) { if (e?.code !== "ESRCH") return null; }
      }
      const current = await stat(lockPath).catch(e => e?.code === "ENOENT" ? null : Promise.reject(e));
      if (!current || current.ino !== details.ino || current.dev !== details.dev || current.mtimeMs !== details.mtimeMs)
        continue;
      await unlink(lockPath).catch(e => { if (e?.code !== "ENOENT") throw e; });
    }
  }
  return null;
}

export async function stageRelease({ metadataUrl, publicKeyDer, bundledVersion, dataDir = DATA_DIR,
  fetchImpl = fetch, install = true, installDependencies = defaultInstallDependencies }) {
  await privateDirectory(dataDir, true);
  const lockPath = path.join(dataDir, "update.lock");
  const lock = await acquireUpdateLock(lockPath);
  if (!lock) return { status: "already_checking" };
  try {
    const raw = await download(metadataUrl, METADATA_LIMIT, fetchImpl);
    const meta = verifyMetadata(JSON.parse(raw.toString("utf8")), publicKeyDer);
    const active = await readActive(dataDir);
    const current = active && newer(active, bundledVersion) ? active : bundledVersion;
    const state = active && await privateJson(path.join(dataDir, "active.json"), 512);
    if (state?.blockedVersion && !newer(meta.version, state.blockedVersion))
      return { status: "held_back", version: current, blockedVersion: state.blockedVersion };
    if (!newer(meta.version, current)) return { status: "current", version: current };
    const bytes = await download(meta.bundleUrl, BUNDLE_LIMIT, fetchImpl);
    if (createHash("sha256").update(bytes).digest("hex") !== meta.sha256) throw new Error("Update bundle checksum mismatch");
    const files = parseBundle(bytes, meta.version);
    if (!install) return { status: "verified", version: meta.version };
    const versions = path.join(dataDir, "versions");
    await privateDirectory(versions, true);
    const target = path.join(versions, meta.version);
    let exists = false;
    try { exists = (await stat(target)).isDirectory(); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (exists) {
      for (const [name, contents] of files) {
        const saved = await readFile(path.join(target, name));
        if (!saved.equals(contents)) throw new Error("Existing release differs from signed bundle");
      }
      if (!(await stat(path.join(target, "node_modules"))).isDirectory())
        throw new Error("Existing release has no dependencies");
    } else {
      const stage = path.join(versions, `.stage-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 });
      try {
        for (const [name, contents] of files) {
          const file = path.join(stage, name);
          await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await writeFile(file, contents, { mode: 0o600, flag: "wx" });
        }
        await installDependencies(stage);
        await rename(stage, target);
      } catch (error) {
        await rm(stage, { recursive: true, force: true });
        throw error;
      }
    }
    await atomicJson(path.join(dataDir, "active.json"), { version: meta.version, previous: current });
    return { status: "staged", version: meta.version, previous: current };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function defaultInstallDependencies(stage) {
  // Lockfile integrity pins dependencies; lifecycle scripts are disabled.
  await new Promise((resolve, reject) => {
    const child = spawn("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: stage, stdio: "ignore", timeout: 300_000, env: {
        HOME: os.homedir(), PATH: process.env.PATH || "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR || "/tmp", npm_config_update_notifier: "false",
      } });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Dependency install failed (${code})`)));
  });
}

export async function rollback(dataDir = DATA_DIR) {
  if (!(await privateDirectory(dataDir))) throw new Error("No previous release to restore");
  const lockPath = path.join(dataDir, "update.lock");
  const lock = await acquireUpdateLock(lockPath);
  if (!lock) throw new Error("Update check in progress; retry rollback");
  try {
    const file = path.join(dataDir, "active.json");
    const state = await privateJson(file, 512);
    if (typeof state?.version !== "string" || typeof state?.previous !== "string" ||
        !VERSION.test(state.version) || !VERSION.test(state.previous) || !newer(state.version, state.previous))
      throw new Error("No previous release to restore");
    await atomicJson(file, { version: state.previous, previous: state.version, blockedVersion: state.version });
    return state.previous;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
