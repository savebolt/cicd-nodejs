'use strict';

/*
 * Supervisor / deploy agent.
 *
 * This is the only process Pterodactyl starts, so it must never exit on its
 * own: if it dies the container is marked offline. It binds no port. All HTTP
 * traffic is handled by server.js, which runs as a child and can therefore be
 * killed and respawned to pick up new code.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = __dirname;
const CHILD_PATH = path.join(ROOT, 'server.js');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, '.deploy-state.json');
const DEFAULT_REPO = 'savebolt/cicd-nodejs';

const log = (...args) => console.log(`[${new Date().toISOString()}] [deploy]`, ...args);

function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      log('config.json is not valid JSON, ignoring it:', err.message);
    }
  }

  const int = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    repo: process.env.GITHUB_REPO || file.repo || DEFAULT_REPO,
    branch: process.env.GITHUB_BRANCH || file.branch || 'main',
    secret: process.env.WEBHOOK_SECRET || file.secret || '',
    port: int(process.env.SERVER_PORT || process.env.PORT || file.port, 3000),
    pollSeconds: int(process.env.POLL_SECONDS ?? file.pollSeconds, 120),
  };
}

const config = loadConfig();

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(next) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  } catch (err) {
    log('could not persist deploy state:', err.message);
  }
}

let state = readState();

function hashFile(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, shell: false, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/* ---------- strategy detection ---------- */

let mode = 'unknown';

async function detectMode() {
  const git = await run('git', ['--version']);
  const hasRepo = fs.existsSync(path.join(ROOT, '.git'));

  if (git.ok && hasRepo) {
    mode = 'git';
    log(`using git (${git.stdout})`);
  } else if (git.ok) {
    mode = 'tarball';
    log('git is installed but this folder is not a clone; falling back to tarball downloads');
  } else {
    mode = 'tarball';
    log('git is not available in this container; falling back to tarball downloads');
  }
}

/* ---------- remote/local revisions ---------- */

const repoUrl = () => `https://github.com/${config.repo}.git`;

// git's smart-HTTP transport. No rate limit and no git binary needed, which
// makes it the most dependable option in a locked-down container.
async function shaFromGitProtocol() {
  const res = await fetch(`${repoUrl()}/info/refs?service=git-upload-pack`, {
    headers: { 'User-Agent': 'git/2.40.0' },
  });
  if (!res.ok) throw new Error(`info/refs responded ${res.status}`);

  const body = await res.text();
  const match = body.match(new RegExp(`([0-9a-f]{40})\\s+refs/heads/${config.branch}(?![\\w/-])`));
  if (!match) throw new Error(`branch ${config.branch} not found on the remote`);
  return match[1];
}

async function shaFromLsRemote() {
  const res = await run('git', ['ls-remote', repoUrl(), `refs/heads/${config.branch}`]);
  if (!res.ok || !res.stdout) throw new Error(`git ls-remote failed: ${res.stderr || res.code}`);
  return res.stdout.split(/\s+/)[0];
}

// Public but rate limited to 60 requests/hour per IP, so it is only a last
// resort: on shared hosting that budget is often already spent.
async function shaFromApi() {
  const res = await fetch(`https://api.github.com/repos/${config.repo}/commits/${config.branch}`, {
    headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'autodeploy-node' },
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  return (await res.text()).trim();
}

async function remoteSha() {
  const sources = mode === 'git'
    ? [shaFromLsRemote, shaFromGitProtocol, shaFromApi]
    : [shaFromGitProtocol, shaFromApi];

  const errors = [];
  for (const source of sources) {
    try {
      const sha = await source();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
      errors.push(`${source.name}: unexpected response "${sha}"`);
    } catch (err) {
      errors.push(`${source.name}: ${err.message}`);
    }
  }

  throw new Error(`could not read the remote commit (${errors.join('; ')})`);
}

async function localSha() {
  if (mode === 'git') {
    const res = await run('git', ['rev-parse', 'HEAD']);
    if (res.ok) return res.stdout;
  }
  return state.sha || '';
}

/* ---------- tarball fallback ---------- */

function cstr(buf, start, len) {
  const sub = buf.subarray(start, start + len);
  const end = sub.indexOf(0);
  return sub.subarray(0, end === -1 ? sub.length : end).toString('utf8');
}

// Minimal tar reader: enough for GitHub's codeload archives, which only
// contain directories and regular files.
function extractTar(buf, destDir, strip = 1) {
  const written = [];
  let off = 0;

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;

    const name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    const size = Number.parseInt(cstr(header, 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);

    off += 512;
    const dataStart = off;
    off += size + ((512 - (size % 512)) % 512);

    const full = prefix ? `${prefix}/${name}` : name;
    const parts = full.split('/').filter(Boolean).slice(strip);
    if (parts.length === 0) continue;

    const rel = parts.join('/');
    // Never let an archive escape the project or clobber local-only files.
    if (parts.includes('..') || parts[0] === '.git' || rel === 'config.json') continue;

    const target = path.join(destDir, rel);
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (type !== '0' && type !== '\0') continue;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf.subarray(dataStart, dataStart + size));
    written.push(rel);
  }

  return written;
}

async function pullViaTarball(sha) {
  const url = `https://codeload.github.com/${config.repo}/tar.gz/${sha}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'autodeploy-node' } });
  if (!res.ok) throw new Error(`codeload responded ${res.status}`);

  const gz = Buffer.from(await res.arrayBuffer());
  const tar = zlib.gunzipSync(gz);
  const files = extractTar(tar, ROOT, 1);
  log(`extracted ${files.length} file(s) from tarball`);
}

async function pullViaGit() {
  const fetched = await run('git', ['fetch', 'origin', config.branch, '--depth', '1']);
  if (!fetched.ok) throw new Error(`git fetch failed: ${fetched.stderr || fetched.code}`);

  const reset = await run('git', ['reset', '--hard', 'FETCH_HEAD']);
  if (!reset.ok) throw new Error(`git reset failed: ${reset.stderr || reset.code}`);

  log(reset.stdout || 'working tree reset to FETCH_HEAD');
}

/* ---------- deploy ---------- */

let deploying = false;
let queued = null;

async function deploy(reason) {
  if (deploying) {
    queued = reason;
    log(`deploy already running, queued follow-up (${reason})`);
    return { status: 'queued' };
  }

  deploying = true;
  try {
    log(`checking for updates (${reason})`);

    const before = await localSha();
    const target = await remoteSha();

    if (!target) throw new Error('could not determine the remote commit');
    if (before && before === target) {
      log(`already up to date at ${target.slice(0, 7)}`);
      return { status: 'up-to-date', sha: target };
    }

    log(`updating ${before ? `${before.slice(0, 7)} -> ` : ''}${target.slice(0, 7)}`);

    const prevServer = hashFile(CHILD_PATH);
    const prevIndex = hashFile(__filename);

    if (mode === 'git') await pullViaGit();
    else await pullViaTarball(target);

    state = { sha: target, lastDeploy: new Date().toISOString() };
    writeState(state);

    const serverChanged = hashFile(CHILD_PATH) !== prevServer;
    const indexChanged = hashFile(__filename) !== prevIndex;

    if (indexChanged) {
      log('!! index.js changed - restart the server from the Pterodactyl panel to apply it');
    }

    if (serverChanged) {
      log('server.js changed, restarting the web process');
      await restartChild();
    } else {
      // Static assets are read from disk per request, so they are already live.
      log('no server code changed; new files are already being served');
      sendState();
    }

    log(`deployed ${target.slice(0, 7)}`);
    return { status: 'deployed', sha: target, restarted: serverChanged, supervisorStale: indexChanged };
  } catch (err) {
    log('deploy failed:', err.message);
    return { status: 'error', error: err.message };
  } finally {
    deploying = false;
    if (queued) {
      const next = queued;
      queued = null;
      setTimeout(() => deploy(next), 500);
    }
  }
}

/* ---------- child process ---------- */

let child = null;
let restarting = false;
let crashes = 0;

function childEnv() {
  return {
    ...process.env,
    AUTODEPLOY_CONFIG: JSON.stringify({
      branch: config.branch,
      repo: config.repo,
      secret: config.secret,
      port: config.port,
    }),
  };
}

function sendState() {
  if (child?.connected) {
    child.send({ type: 'state', sha: state.sha || '', lastDeploy: state.lastDeploy || null, mode });
  }
}

function startChild() {
  child = spawn(process.execPath, [CHILD_PATH], {
    cwd: ROOT,
    env: childEnv(),
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  child.on('message', (msg) => {
    if (msg?.type === 'deploy') deploy(msg.reason || 'webhook');
    if (msg?.type === 'ready') sendState();
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (restarting) return;

    crashes += 1;
    const delay = Math.min(30_000, 1000 * 2 ** (crashes - 1));
    log(`web process exited (code ${code}, signal ${signal || 'none'}); restarting in ${delay / 1000}s`);
    setTimeout(startChild, delay);
  });

  // A process that stays up for a while is considered healthy again.
  setTimeout(() => {
    if (child && !child.killed) crashes = 0;
  }, 60_000);
}

function restartChild() {
  return new Promise((resolve) => {
    if (!child) {
      startChild();
      return resolve();
    }

    restarting = true;
    const current = child;

    // Wait for the port to actually be released before rebinding it.
    current.once('exit', () => {
      restarting = false;
      child = null;
      startChild();
      resolve();
    });

    current.kill('SIGTERM');
    setTimeout(() => {
      if (current === child || !current.killed) current.kill('SIGKILL');
    }, 5000);
  });
}

/* ---------- boot ---------- */

process.on('uncaughtException', (err) => log('uncaught exception in supervisor:', err));
process.on('unhandledRejection', (err) => log('unhandled rejection in supervisor:', err));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    restarting = true;
    child?.kill('SIGTERM');
    setTimeout(() => process.exit(0), 1000);
  });
}

(async () => {
  log(`repo ${config.repo} branch ${config.branch}`);
  if (!config.secret) {
    log('no webhook secret configured - /webhook will accept unsigned requests');
  }

  await detectMode();
  startChild();

  if (config.pollSeconds > 0) {
    log(`polling for new commits every ${config.pollSeconds}s`);
    setInterval(() => deploy('poll'), config.pollSeconds * 1000);
  }
})();
