#!/usr/bin/env node
/** Refresh Draftsafe's Understand Anything graph from the current worktree. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uaDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(uaDir, '..');
const plugin = process.env.UNDERSTAND_ANYTHING_PLUGIN_ROOT
  ?? join(homedir(), '.understand-anything-plugin');
const skill = join(plugin, 'skills', 'understand');
const core = join(plugin, 'packages', 'core', 'dist', 'index.js');
if (!existsSync(core)) {
  throw new Error('Understand Anything is not built. Install the plugin and build @understand-anything/core first.');
}

const scratch = join(uaDir, 'intermediate');
const temp = join(uaDir, 'tmp');
mkdirSync(scratch, { recursive: true });
mkdirSync(temp, { recursive: true });
const scanPath = join(scratch, 'scan-result.json');
const importInput = join(temp, 'import-input.json');
const importOutput = join(temp, 'import-output.json');
const extractInput = join(temp, 'extract-input.json');
const extractOutput = join(temp, 'extract-output.json');
const fingerprintInput = join(temp, 'fingerprint-input.json');

function run(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

run(process.execPath, [join(skill, 'scan-project.mjs'), root, scanPath, '--exclude-analysis-data']);
const rawScan = readJson(scanPath);
writeJson(importInput, { projectRoot: root, files: rawScan.files });
run(process.execPath, [join(skill, 'extract-import-map.mjs'), importInput, importOutput]);
const imports = readJson(importOutput).importMap;
const pkg = readJson(join(root, 'package.json'));
const scan = {
  name: pkg.name,
  description: pkg.description,
  languages: Object.keys(rawScan.stats.byLanguage).sort(),
  frameworks: ['Thunderbird MailExtension', 'Model Context Protocol', 'Vitest', 'GitHub Actions'],
  files: rawScan.files,
  totalFiles: rawScan.totalFiles,
  filteredByIgnore: rawScan.filteredByIgnore,
  estimatedComplexity: rawScan.estimatedComplexity,
  importMap: imports,
};
writeJson(scanPath, scan);
writeJson(extractInput, { projectRoot: root, batchFiles: scan.files, batchImportData: imports });
run(process.execPath, [join(skill, 'extract-structure.mjs'), extractInput, extractOutput]);
const extraction = readJson(extractOutput);
if (extraction.filesUnreadable.length) {
  throw new Error(`Unreadable project files: ${extraction.filesUnreadable.map(x => x.path).join(', ')}`);
}

const summaries = {
  'mcp/src/index.ts': 'Starts the stdio MCP server used by the agent client.',
  'mcp/src/server.ts': 'Registers mail, draft, composer and connection tools with MCP. It routes requests through the local bridge client.',
  'mcp/src/bridge-client.ts': 'Calls the authenticated Thunderbird loopback bridge and handles connection or protocol failures.',
  'mcp/src/connection.ts': 'Loads and validates the local bridge connection information.',
  'mcp/src/attachments.ts': 'Stages local attachments under allowed paths before asking Thunderbird to add them to a composer.',
  'mcp/src/tools.ts': 'Defines MCP tool names, descriptions and input schemas.',
  'addons/app/src/background.js': 'Starts the single Thunderbird add-on and coordinates its bridge and mailbox features.',
  'addons/app/src/relay.js': 'Relays requests between the add-on parts and the privileged bridge.',
  'addons/bridge/src/bridge/server.js': 'Runs the loopback HTTP bridge inside Thunderbird and publishes its local connection state.',
  'addons/bridge/src/bridge/routes.js': 'Maps authenticated bridge requests to read, draft, composer and approved mailbox operations.',
  'addons/bridge/src/bridge/security.js': 'Enforces loopback origin, bearer token and request limits for bridge calls.',
  'addons/bridge/src/bridge/validate.js': 'Validates bridge request payloads before executing Thunderbird operations.',
  'addons/bridge/src/bridge/ops.js': 'Implements privileged Thunderbird bridge operations.',
  'addons/bridge/api/implementation.js': 'Implements the Thunderbird Experiment API used by the bridge.',
  'addons/shared/lib/compose-review.js': 'Coordinates native compose windows for review, edits, signatures and attachments.',
  'addons/shared/lib/compose-body.js': 'Builds or updates the message body while preserving the user-facing compose flow.',
  'addons/shared/lib/mail-routes.js': 'Dispatches mail read and mailbox change requests across Thunderbird APIs.',
  'addons/shared/lib/mail-ops.js': 'Implements mailbox reads and changes that require the approved path.',
  'addons/shared/lib/attachment-stage.js': 'Stages and validates attachment data before composer use.',
  'addons/tools/src/approval/manager.js': 'Manages pending mailbox change approvals and trusted-click sessions.',
  'addons/tools/src/approval/state.js': 'Tracks approval state and remembered decisions.',
  'addons/tools/src/ui/approve.js': 'Runs the Thunderbird approval window where the user reviews requested mailbox changes.',
  'addons/tools/src/features/sendlater.js': 'Implements user-only Send later in Thunderbird.',
  'addons/tools/src/features/snooze.js': 'Implements Snooze for selected messages.',
  'addons/tools/src/features/followup.js': 'Tracks follow-up reminders for messages.',
  'scripts/build-xpi.mjs': 'Packages the combined Thunderbird add-on as an XPI.',
  'scripts/launch.mjs': 'Launches the local MCP server and its update checks.',
  'scripts/update-core.mjs': 'Checks and installs verified MCP update bundles.',
  'scripts/update-worker.mjs': 'Runs update work separately from the active MCP process.',
  'scripts/prepare-release.mjs': 'Checks release artifacts before publication.',
  'README.md': 'Explains Draftsafe setup, architecture, tool use and the review-before-send boundary.',
  'SECURITY.md': 'Documents capabilities, permissions, approval paths and trust boundaries.',
};
function fileType(file) {
  if (file.fileCategory === 'docs') return 'document';
  if (file.fileCategory === 'config') return 'config';
  if (file.fileCategory === 'infra') return 'pipeline';
  return 'file';
}
function idFor(file) { return `${fileType(file)}:${file.path}`; }
function shortName(path) { return basename(path).replace(/\.(test|spec)\.(ts|js)$/, ''); }
function summaryFor(file, result) {
  const path = file.path;
  if (summaries[path]) return summaries[path];
  if (path.startsWith('test/')) return `Tests ${shortName(path)} behavior and its expected security or integration boundary.`;
  if (path.startsWith('addons/tools/src/ui/')) return `Provides the Thunderbird ${shortName(path)} interface for reviewing or managing mail actions.`;
  if (path.startsWith('addons/tools/src/approval/')) return `Supports the Thunderbird approval flow through ${shortName(path)} behavior.`;
  if (path.startsWith('addons/shared/lib/')) return `Shared Thunderbird mail logic for ${shortName(path)} behavior.`;
  if (path.startsWith('scripts/')) return `Build or maintenance command for ${shortName(path)}.`;
  if (file.fileCategory === 'config') return `Configuration for ${shortName(path)} in the Draftsafe build or add-on.`;
  if (file.fileCategory === 'docs') return `Documentation for ${shortName(path)} and the Draftsafe project.`;
  if (file.fileCategory === 'infra') return `CI workflow for the Draftsafe build and tests.`;
  const exports = (result?.exports ?? []).map(x => x.name).filter(Boolean).slice(0, 3);
  return exports.length
    ? `Implements ${shortName(path)} and exports ${exports.join(', ')}.`
    : `Implements ${shortName(path)} behavior in Draftsafe.`;
}
function tagsFor(file) {
  const path = file.path;
  if (path.startsWith('test/')) return ['test', 'verification', 'draftsafe'];
  if (path.startsWith('mcp/')) return ['mcp', 'agent-interface', 'local-bridge'];
  if (path.startsWith('addons/bridge/')) return ['thunderbird', 'bridge', 'security'];
  if (path.startsWith('addons/tools/src/approval/')) return ['thunderbird', 'approval', 'safety'];
  if (path.startsWith('addons/tools/src/ui/')) return ['thunderbird', 'user-interface', 'review'];
  if (path.startsWith('addons/')) return ['thunderbird', 'mail', 'add-on'];
  if (path.startsWith('scripts/')) return ['build-system', 'release', 'maintenance'];
  return ['documentation', 'project', 'draftsafe'];
}
function complexityFor(lines) { return lines > 200 ? 'complex' : lines > 50 ? 'moderate' : 'simple'; }

const byResult = new Map(extraction.results.map(x => [x.path, x]));
const fileIds = new Map(scan.files.map(x => [x.path, idFor(x)]));
const nodes = [];
const edges = [];
const seenEdges = new Set();
function edge(source, target, type, weight) {
  if (!source || !target || source === target) return;
  const key = `${source}\u0000${target}\u0000${type}`;
  if (seenEdges.has(key)) return;
  seenEdges.add(key);
  edges.push({ source, target, type, direction: 'forward', weight });
}
for (const file of scan.files) {
  const result = byResult.get(file.path);
  const type = fileType(file);
  const id = idFor(file);
  nodes.push({
    id, type, name: basename(file.path), filePath: file.path,
    summary: summaryFor(file, result), tags: tagsFor(file),
    complexity: complexityFor(result?.nonEmptyLines ?? file.sizeLines),
  });
  for (const imported of imports[file.path] ?? []) {
    edge(id, fileIds.get(imported), 'imports', 0.7);
    if (file.path.startsWith('test/') && !imported.startsWith('test/')) {
      edge(fileIds.get(imported), id, 'tested_by', 0.5);
    }
  }
  if (!result || file.fileCategory !== 'code') continue;
  const exported = new Set((result.exports ?? []).map(x => x.name));
  for (const fn of result.functions ?? []) {
    const lines = fn.endLine - fn.startLine + 1;
    if (lines < 10 && !exported.has(fn.name)) continue;
    const symbolId = `function:${file.path}:${fn.name}`;
    if (nodes.some(x => x.id === symbolId)) continue;
    nodes.push({
      id: symbolId, type: 'function', name: fn.name, filePath: file.path,
      lineRange: [fn.startLine, fn.endLine],
      summary: `${fn.name} implements part of ${shortName(file.path)} behavior.`,
      tags: [...tagsFor(file).slice(0, 2), 'function'], complexity: complexityFor(lines),
    });
    edge(id, symbolId, 'contains', 1);
    if (exported.has(fn.name)) edge(id, symbolId, 'exports', 0.8);
  }
  for (const cls of result.classes ?? []) {
    const lines = cls.endLine - cls.startLine + 1;
    if (lines < 20 && (cls.methods?.length ?? 0) < 2 && !exported.has(cls.name)) continue;
    const symbolId = `class:${file.path}:${cls.name}`;
    if (nodes.some(x => x.id === symbolId)) continue;
    nodes.push({
      id: symbolId, type: 'class', name: cls.name, filePath: file.path,
      lineRange: [cls.startLine, cls.endLine],
      summary: `${cls.name} groups ${shortName(file.path)} behavior.`,
      tags: [...tagsFor(file).slice(0, 2), 'class'], complexity: complexityFor(lines),
    });
    edge(id, symbolId, 'contains', 1);
    if (exported.has(cls.name)) edge(id, symbolId, 'exports', 0.8);
  }
}

const relationships = [
  ['mcp/src/server.ts', 'mcp/src/bridge-client.ts', 'depends_on'],
  ['mcp/src/bridge-client.ts', 'addons/bridge/src/bridge/server.js', 'depends_on'],
  ['addons/app/src/relay.js', 'addons/bridge/src/bridge/routes.js', 'depends_on'],
  ['addons/bridge/src/bridge/routes.js', 'addons/shared/lib/mail-routes.js', 'depends_on'],
  ['addons/bridge/src/bridge/routes.js', 'addons/shared/lib/compose-review.js', 'depends_on'],
  ['addons/shared/lib/mail-routes.js', 'addons/tools/src/approval/manager.js', 'depends_on'],
  ['addons/tools/src/approval/manager.js', 'addons/tools/src/ui/approve.js', 'depends_on'],
  ['scripts/build-xpi.mjs', 'addons/app/manifest.json', 'configures'],
  ['README.md', 'mcp/src/server.ts', 'documents'],
  ['SECURITY.md', 'addons/bridge/src/bridge/security.js', 'documents'],
];
for (const [a, b, type] of relationships) {
  edge(fileIds.get(a), fileIds.get(b), type, type === 'documents' ? 0.5 : 0.6);
}
for (const file of scan.files) {
  if (file.path === 'tsconfig.json') edge(fileIds.get(file.path), fileIds.get('mcp/src/server.ts'), 'configures', 0.6);
  if (file.path === 'package.json') edge(fileIds.get(file.path), fileIds.get('scripts/build-xpi.mjs'), 'configures', 0.6);
  if (file.path === '.github/workflows/ci.yml') edge(fileIds.get(file.path), fileIds.get('test/mcp-server.test.ts'), 'triggers', 0.6);
}

const layerDefs = [
  ['mcp', 'Agent and MCP server', 'Tools exposed to an agent and the client for the local Thunderbird bridge.'],
  ['startup', 'Thunderbird add-on startup', 'The single installed add-on and its startup relay.'],
  ['bridge', 'Thunderbird bridge', 'Authenticated local HTTP bridge and privileged Thunderbird Experiment.'],
  ['shared', 'Shared mail and composer logic', 'Mail reads, drafts, native composer updates and shared validation.'],
  ['approval', 'User approval', 'Trusted-click approval state and change review.'],
  ['features', 'Thunderbird mail features', 'Snooze, Send later and follow-up behaviors.'],
  ['ui', 'Thunderbird windows', 'Approval and feature windows used by the person.'],
  ['scripts', 'Build and update commands', 'Package, release, smoke and MCP update commands.'],
  ['verification', 'Tests, configuration and docs', 'Behavior tests, CI, project configuration and written guidance.'],
];
function layerFor(path) {
  if (path.startsWith('mcp/')) return 'mcp';
  if (path.startsWith('addons/app/')) return 'startup';
  if (path.startsWith('addons/bridge/')) return 'bridge';
  if (path.startsWith('addons/shared/')) return 'shared';
  if (path.startsWith('addons/tools/src/approval/')) return 'approval';
  if (path.startsWith('addons/tools/src/features/')) return 'features';
  if (path.startsWith('addons/tools/src/ui/')) return 'ui';
  if (path.startsWith('addons/tools/')) return 'features';
  if (path.startsWith('scripts/')) return 'scripts';
  return 'verification';
}
const layers = layerDefs.map(([key, name, description]) => ({
  id: `layer:${key}`, name, description,
  nodeIds: nodes.filter(x => layerFor(x.filePath) === key).map(x => x.id),
})).filter(x => x.nodeIds.length);
const steps = [
  ['Project overview', 'Start with the security boundary and the two running parts.', ['README.md', 'SECURITY.md']],
  ['Agent tools', 'See where MCP tools are registered and how calls enter the bridge client.', ['mcp/src/index.ts', 'mcp/src/server.ts', 'mcp/src/bridge-client.ts']],
  ['Local connection', 'Trace the authenticated loopback server and its route validation.', ['mcp/src/connection.ts', 'addons/bridge/src/bridge/server.js', 'addons/bridge/src/bridge/security.js', 'addons/bridge/src/bridge/routes.js']],
  ['Mail and composer', 'Follow reads, draft changes and native composer review.', ['addons/shared/lib/mail-routes.js', 'addons/shared/lib/mail-ops.js', 'addons/shared/lib/compose-review.js']],
  ['User approval', 'Understand how mailbox changes wait for a Thunderbird click.', ['addons/tools/src/approval/manager.js', 'addons/tools/src/ui/approve.js']],
  ['Add-on features', 'Explore Snooze, user-only Send later and follow-ups.', ['addons/tools/src/features/snooze.js', 'addons/tools/src/features/sendlater.js', 'addons/tools/src/features/followup.js']],
  ['Package and verify', 'Review packaging, integration tests and update checks.', ['scripts/build-xpi.mjs', 'test/loopback-e2e.test.ts', 'scripts/update-core.mjs']],
];
const tour = steps.map(([title, description, paths], index) => ({
  order: index + 1, title, description, nodeIds: paths.map(x => fileIds.get(x)).filter(Boolean),
}));

const commit = run('git', ['rev-parse', 'HEAD']);
const now = new Date().toISOString();
const ids = new Set(nodes.map(x => x.id));
if (ids.size !== nodes.length) throw new Error('Duplicate graph node IDs');
if (edges.some(x => !ids.has(x.source) || !ids.has(x.target))) throw new Error('Dangling graph edge');
if (scan.files.some(x => !ids.has(idFor(x)))) throw new Error('Missing file node');
const graph = {
  version: '1.0.0', kind: 'codebase',
  project: { name: pkg.name, languages: scan.languages, frameworks: scan.frameworks,
    description: pkg.description, analyzedAt: now, gitCommitHash: commit },
  nodes, edges, layers, tour,
};
writeJson(join(uaDir, 'knowledge-graph.json'), graph);
writeJson(fingerprintInput, { projectRoot: root, filePaths: scan.files.map(x => x.path), gitCommitHash: commit });
run(process.execPath, [join(skill, 'build-fingerprints.mjs'), fingerprintInput]);
writeJson(join(uaDir, 'meta.json'), {
  lastAnalyzedAt: now, gitCommitHash: commit, version: '1.0.0', analyzedFiles: scan.files.length,
});
const oldConfig = existsSync(join(uaDir, 'config.json')) ? readJson(join(uaDir, 'config.json')) : {};
writeJson(join(uaDir, 'config.json'), { ...oldConfig, autoUpdate: true, outputLanguage: 'en' });
process.stdout.write(`Understand Anything: ${scan.files.length} files, ${nodes.length} nodes, ${edges.length} edges, ${layers.length} layers, ${tour.length} tour steps.\n`);
