// SPDX-License-Identifier: MIT
// Locates and validates the connection file written by the add-on.
// Path rules must match addon/api/bridge/implementation.js#connectionDir().

import { promises as fs } from "node:fs";
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
  isFile(): boolean;
}

/** On POSIX the file must be a regular file owned by us with no group/other bits. */
export function checkPermissions(st: StatLike, file: string, platform: NodeJS.Platform = process.platform): void {
  if (!st.isFile()) {
    throw new ConnectionError(`${file} is not a regular file`);
  }
  if (platform === "win32") {
    return;
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new ConnectionError(`${file} is not owned by the current user; refusing to use it`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new ConnectionError(
      `${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); refusing to use it. Expected 600.`
    );
  }
}

export async function readConnection(paths: string[] = candidatePaths()): Promise<ConnectionInfo> {
  const found: { file: string; st: StatLike }[] = [];
  for (const file of paths) {
    try {
      const st = await fs.lstat(file);
      found.push({ file, st });
    } catch {
      // Not there.
    }
  }
  if (!found.length) {
    throw new ConnectionError(
      "Thunderbird bridge not found. Is Thunderbird running with the Draftsafe add-on enabled? Looked in: " +
        paths.join(", ")
    );
  }
  // Newest first: a stale file from another install type loses.
  found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const { file, st } = found[0];
  checkPermissions(st, file);
  return parseConnection(await fs.readFile(file, "utf8"), file);
}
