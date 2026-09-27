import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidatePaths, checkDirectory, checkPermissions, parseConnection, readConnection } from "../mcp/src/connection.js";

const TOKEN = "A".repeat(43);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

function tmp() {
  const d = mkdtempSync(path.join(os.tmpdir(), "draftsafe-test-"));
  dirs.push(d);
  return d;
}

function writeConn(file: string, data: object, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true });
  chmodSync(path.dirname(file), 0o700); // as the add-on does; the default umask may be 002
  writeFileSync(file, JSON.stringify(data));
  chmodSync(file, mode);
}

describe("connection file discovery", () => {
  it("checks the snap path first, then XDG state, then flatpak", () => {
    const p = candidatePaths({}, "linux", "/home/u");
    expect(p).toEqual([
      "/home/u/snap/thunderbird/common/draftsafe-mcp/connection.json",
      "/home/u/.local/state/draftsafe-mcp/connection.json",
      "/home/u/.var/app/org.mozilla.Thunderbird/.local/state/draftsafe-mcp/connection.json",
    ]);
    expect(candidatePaths({ XDG_STATE_HOME: "/xdg" }, "linux", "/home/u")[1]).toBe("/xdg/draftsafe-mcp/connection.json");
    expect(candidatePaths({ XDG_STATE_HOME: "relative" }, "linux", "/home/u")[1]).toBe(
      "/home/u/.local/state/draftsafe-mcp/connection.json"
    );
    expect(candidatePaths({ DRAFTSAFE_CONNECTION_FILE: "/x.json" }, "linux", "/home/u")).toEqual(["/x.json"]);
    expect(candidatePaths({}, "darwin", "/Users/u")).toEqual(["/Users/u/Library/Application Support/draftsafe-mcp/connection.json"]);
  });

  it("validates the file contents", () => {
    expect(parseConnection(JSON.stringify({ version: 1, port: 5000, token: TOKEN }), "f")).toEqual({ port: 5000, token: TOKEN, path: "f" });
    expect(() => parseConnection("{", "f")).toThrow(/JSON/);
    expect(() => parseConnection(JSON.stringify({ version: 2, port: 5000, token: TOKEN }), "f")).toThrow(/version/);
    expect(() => parseConnection(JSON.stringify({ version: 1, port: 70000, token: TOKEN }), "f")).toThrow(/port/);
    expect(() => parseConnection(JSON.stringify({ version: 1, port: 5000, token: "short" }), "f")).toThrow(/token/);
  });

  it("refuses files readable by group or others, or owned by someone else", () => {
    const uid = process.getuid!();
    const st = (mode: number, owner = uid) => ({ mode: 0o100000 | mode, uid: owner, mtimeMs: 0, isFile: () => true });
    expect(() => checkPermissions(st(0o600), "f", "linux")).not.toThrow();
    expect(() => checkPermissions(st(0o644), "f", "linux")).toThrow(/readable by other users/);
    expect(() => checkPermissions(st(0o640), "f", "linux")).toThrow(/readable by other users/);
    expect(() => checkPermissions(st(0o600, uid + 1), "f", "linux")).toThrow(/not owned/);
    expect(() => checkPermissions({ ...st(0o600), isFile: () => false }, "f", "linux")).toThrow(/regular file/);
  });

  it("reads the newest valid file from disk and enforces mode 600", async () => {
    const d = tmp();
    const a = path.join(d, "a", "connection.json");
    const b = path.join(d, "b", "connection.json");
    writeConn(a, { version: 1, port: 1111, token: TOKEN });
    writeConn(b, { version: 1, port: 2222, token: TOKEN });
    utimesSync(a, new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect((await readConnection([a, b, path.join(d, "missing.json")])).port).toBe(2222);

    chmodSync(b, 0o644);
    await expect(readConnection([b])).rejects.toThrow(/refusing/);
    await expect(readConnection([path.join(d, "nope.json")])).rejects.toThrow(/Is Thunderbird running/);
  });

  it("refuses a symlinked connection file (checked and read through one descriptor)", async () => {
    const d = tmp();
    const real = path.join(d, "real", "connection.json");
    writeConn(real, { version: 1, port: 3333, token: TOKEN });
    const link = path.join(d, "link", "connection.json");
    mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    symlinkSync(real, link);
    await expect(readConnection([link])).rejects.toThrow(/symlink/);
  });

  it("refuses a connection directory that others can write to, or that is a symlink", async () => {
    const d = tmp();
    const file = path.join(d, "shared", "connection.json");
    writeConn(file, { version: 1, port: 4444, token: TOKEN });
    chmodSync(path.dirname(file), 0o777);
    await expect(readConnection([file])).rejects.toThrow(/writable by other users/);
    chmodSync(path.dirname(file), 0o700);
    expect((await readConnection([file])).port).toBe(4444);

    const linkedDir = path.join(d, "linkdir");
    symlinkSync(path.dirname(file), linkedDir);
    await expect(readConnection([path.join(linkedDir, "connection.json")])).rejects.toThrow(/not a directory/);
  });

  it("checkDirectory rejects foreign owners and group/world-writable modes", () => {
    const uid = process.getuid!();
    const st = (mode: number, owner = uid) => ({ mode: 0o040000 | mode, uid: owner, mtimeMs: 0, isFile: () => false, isDirectory: () => true });
    expect(() => checkDirectory(st(0o700), "d", "linux")).not.toThrow();
    expect(() => checkDirectory(st(0o755), "d", "linux")).not.toThrow();
    expect(() => checkDirectory(st(0o775), "d", "linux")).toThrow(/writable/);
    expect(() => checkDirectory(st(0o700, uid + 1), "d", "linux")).toThrow(/not owned/);
  });
});
