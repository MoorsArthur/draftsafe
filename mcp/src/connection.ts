// SPDX-License-Identifier: MIT
// Locates and validates the connection file written by the add-on.
// Path rules must match addon/api/bridge/implementation.js#connectionDir().

import { constants as fsConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APP_DIR = "draftsafe-mcp";
export const FILE_NAME = "connection.json";

export interface ConnectionInfo {
  port: number;
  token: string;
  path: string;
}

export class ConnectionError extends Error {}

export function candidatePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): string[] {
  if (env.DRAFTSAFE_CONNECTION_FILE) {
    return [env.DRAFTSAFE_CONNECTION_FILE];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [path.join(local, APP_DIR, FILE_NAME)];
  }
  if (platform === "darwin") {
    return [path.join(home, "Library", "Application Support", APP_DIR, FILE_NAME)];
  }
  const state =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : path.join(home, ".local", "state");
  return [
    // Snap Thunderbird: $SNAP_USER_COMMON, stable across snap revisions.
    path.join(home, "snap", "thunderbird", "common", APP_DIR, FILE_NAME),
    // deb / tarball / distro package.
    path.join(state, APP_DIR, FILE_NAME),
    // Flatpak: XDG_STATE_HOME inside the sandbox.
    path.join(home, ".var", "app", "org.mozilla.Thunderbird", ".local", "state", APP_DIR, FILE_NAME),
  ];
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;

export function parseConnection(text: string, file: string): ConnectionInfo {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConnectionError(`${file} is not valid JSON`);
  }
  const d = data as { version?: unknown; port?: unknown; token?: unknown };
  if (d.version !== 1) {
    throw new ConnectionError(`${file} has an unsupported version`);
  }
  if (!Number.isInteger(d.port) || (d.port as number) < 1 || (d.port as number) > 65535) {
    throw new ConnectionError(`${file} has an invalid port`);
  }
  if (typeof d.token !== "string" || !TOKEN_RE.test(d.token)) {
    throw new ConnectionError(`${file} has an invalid token`);
  }
  return { port: d.port as number, token: d.token, path: file };
}

interface StatLike {
  mode: number;
  uid: number;
  mtimeMs: number;
  size?: number;
  isFile(): boolean;
  isDirectory?(): boolean;
}

const MAX_FILE_BYTES = 4096;

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** On POSIX the file must be a regular file owned by us with no group/other bits. */
export function checkPermissions(st: StatLike, file: string, platform: NodeJS.Platform = process.platform): void {
  if (!st.isFile()) {
    throw new ConnectionError(`${file} is not a regular file`);
  }
  if (platform === "win32") {
    return;
  }
  const uid = currentUid();
  if (uid !== null && st.uid !== uid) {
    throw new ConnectionError(`${file} is not owned by the current user; refusing to use it`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new ConnectionError(
      `${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); refusing to use it. Expected 600.`
    );
  }
}

/** The directory holding the file must be a real directory, ours, and not writable by others. */
export function checkDirectory(st: StatLike, dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    return;
  }
  if (!st.isDirectory || !st.isDirectory()) {
    throw new ConnectionError(`${dir} is not a directory (symlinks are refused)`);
  }
  const uid = currentUid();
  if (uid !== null && st.uid !== uid) {
    throw new ConnectionError(`${dir} is not owned by the current user; refusing to use it`);
  }
  if ((st.mode & 0o022) !== 0) {
    throw new ConnectionError(`${dir} is writable by other users; refusing to use it`);
  }
}

/**
 * Opens the file without following symlinks, then checks and reads that same
 * descriptor, so the checked object is the one that is read.
 */
export async function readVerified(file: string, platform: NodeJS.Platform = process.platform): Promise<ConnectionInfo> {
  if (platform !== "win32") {
    const dir = path.dirname(file);
    let dst: StatLike;
    try {
      dst = await fs.lstat(dir);
    } catch {
      throw new ConnectionError(`cannot inspect ${dir}`);
    }
    checkDirectory(dst, dir, platform);
  }
  const flags = fsConstants.O_RDONLY | (platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  let handle: FileHandle;
  try {
    handle = await fs.open(file, flags);
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new ConnectionError(code === "ELOOP" ? `${file} is a symlink; refusing to use it` : `cannot open ${file} (${code ?? "error"})`);
  }
  try {
    const st = await handle.stat();
    checkPermissions(st, file, platform);
    if (st.size > MAX_FILE_BYTES) {
      throw new ConnectionError(`${file} is unexpectedly large; refusing to use it`);
    }
    return parseConnection(await handle.readFile("utf8"), file);
  } finally {
    await handle.close();
  }
}

export async function readConnection(paths: string[] = candidatePaths()): Promise<ConnectionInfo> {
  const found: { file: string; mtimeMs: number }[] = [];
  for (const file of paths) {
    try {
      const st = await fs.lstat(file);
      found.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      // Not there.
    }
  }
  if (!found.length) {
    throw new ConnectionError(
      "No Draftsafe connection file. If Thunderbird is closed, start it; if open, enable the Draftsafe add-on. Looked in: " +
        paths.join(", ")
    );
  }
  // Newest first: a stale file from another install type loses.
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return readVerified(found[0].file);
}
