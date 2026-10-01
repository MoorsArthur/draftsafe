#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const maintainer = 'Arthur Moors';
const safeEmail = 'moorsarthur@users.noreply.github.com';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function checkIdentity(ref, role, name, email) {
  if (name.trim().toLowerCase() !== maintainer.toLowerCase()) return false;
  if (email.trim().toLowerCase() === safeEmail) return false;
  console.error(`${ref}: ${role} for ${maintainer} must use the GitHub noreply address`);
  return true;
}

let failures = 0;
const commits = git('log', '--all', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce');
for (const line of commits.split('\n')) {
  if (!line) continue;
  const fields = line.split('\0');
  if (fields.length !== 5 || !/^[0-9a-f]{40,64}$/.test(fields[0])) {
    console.error('Cannot parse commit identity; refusing to pass privacy check');
    process.exit(1);
  }
  const [commit, author, authorEmail, committer, committerEmail] = fields;
  failures += Number(checkIdentity(commit, 'author', author, authorEmail));
  failures += Number(checkIdentity(commit, 'committer', committer, committerEmail));
}

const tags = git('for-each-ref', '--format=%(refname)%00%(taggername)%00%(taggeremail)', 'refs/tags');
for (const line of tags.split('\n')) {
  if (!line) continue;
  const fields = line.split('\0');
  if (fields.length !== 3) {
    console.error('Cannot parse tag identity; refusing to pass privacy check');
    process.exit(1);
  }
  const [ref, name, email] = fields;
  if (name) failures += Number(checkIdentity(ref, 'tagger', name, email.replace(/^<|>$/g, '')));
}

if (failures) {
  console.error(`Privacy check failed for ${failures} maintainer identity field(s).`);
  process.exit(1);
}
console.log('Commit and tag privacy check passed.');
