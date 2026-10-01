import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = new URL('../scripts/check-commit-privacy.mjs', import.meta.url).pathname;
let repo: string;

function git(args: string[], name = 'Arthur Moors', email = 'MoorsArthur@users.noreply.github.com') {
  return execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    },
    stdio: 'pipe',
  });
}

function check() {
  return spawnSync(process.execPath, [checker], { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'draftsafe-privacy-'));
  git(['init', '-q']);
  git(['commit', '-q', '--allow-empty', '-m', 'safe commit']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

test('accepts maintainer noreply commits and tags', () => {
  git(['tag', '-a', 'v1', '-m', 'release']);
  expect(check().status).toBe(0);
});

test('rejects a maintainer personal author or committer address', () => {
  git(['commit', '-q', '--allow-empty', '-m', 'personal email'], 'Arthur Moors', 'arthur@example.org');
  expect(check().status).toBe(1);
});

test('rejects a maintainer personal tagger address', () => {
  git(['tag', '-a', 'v1', '-m', 'release'], 'Arthur Moors', 'arthur@example.org');
  expect(check().status).toBe(1);
});

test('allows outside contributors to use their chosen address', () => {
  git(['commit', '-q', '--allow-empty', '-m', 'contribution'], 'Contributor', 'contributor@example.org');
  expect(check().status).toBe(0);
});
