'use strict';

/*
 * Web process. Serves ./public and exposes the deploy webhook.
 *
 * Started by index.js as a child with an IPC channel. It performs no git work
 * itself: it validates incoming webhooks and asks the supervisor to deploy, so
 * that this process can be safely killed and respawned with new code.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');

const config = (() => {
  try {
    return JSON.parse(process.env.AUTODEPLOY_CONFIG || '{}');
  } catch {
    return {};
  }
})();

const PORT = Number(config.port || process.env.SERVER_PORT || process.env.PORT || 3000);
const BRANCH = config.branch || 'main';
const SECRET = config.secret || '';

const log = (...args) => console.log(`[${new Date().toISOString()}] [web]`, ...args);

let deployState = { sha: '', lastDeploy: null, mode: 'unknown' };

process.on('message', (msg) => {
  if (msg?.type === 'state') {
    deployState = { sha: msg.sha, lastDeploy: msg.lastDeploy, mode: msg.mode };
  }
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function signatureValid(raw, header) {
  if (!SECRET) return true;
  if (!header) return false;

  const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- static files ---------- */

async function serveStatic(req, res, pathname) {
  const decoded = decodeURIComponent(pathname);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);

  // Reject anything that resolves outside public/.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return sendJson(res, 404, { error: 'not found', path: decoded });
  }

  let file = target;
  if (stat.isDirectory()) {
    file = path.join(target, 'index.html');
    try {
      stat = await fsp.stat(file);
    } catch {
      return sendJson(res, 404, { error: 'not found', path: decoded });
    }
  }

  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }

  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    // Always revalidate so a deploy is visible on the next reload.
    'Cache-Control': 'no-cache',
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }

  res.writeHead(200, headers);
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

/* ---------- webhook ---------- */

async function handleWebhook(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return sendJson(res, 413, { error: err.message });
  }

  if (!signatureValid(raw, req.headers['x-hub-signature-256'])) {
    log('rejected webhook: bad signature');
    return sendJson(res, 401, { error: 'invalid signature' });
  }

  const event = req.headers['x-github-event'] || 'unknown';

  if (event === 'ping') {
    log('webhook ping received');
    return sendJson(res, 200, { ok: true, pong: true });
  }

  if (event !== 'push') {
    return sendJson(res, 202, { ok: true, ignored: `event ${event}` });
  }

  let payload = {};
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON payload' });
  }

  if (payload.ref && payload.ref !== `refs/heads/${BRANCH}`) {
    log(`ignoring push to ${payload.ref}`);
    return sendJson(res, 202, { ok: true, ignored: payload.ref });
  }

  const pusher = payload.pusher?.name || 'unknown';
  log(`push from ${pusher} on ${BRANCH}, requesting deploy`);
  process.send?.({ type: 'deploy', reason: `webhook (${pusher})` });

  return sendJson(res, 202, { ok: true, deploying: true, branch: BRANCH });
}

/* ---------- routing ---------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/webhook') {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    return handleWebhook(req, res);
  }

  if (pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      commit: deployState.sha || null,
      lastDeploy: deployState.lastDeploy,
      deployMode: deployState.mode,
      branch: BRANCH,
      webhookSecured: Boolean(SECRET),
      node: process.version,
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }

  return serveStatic(req, res, pathname);
});

server.on('error', (err) => {
  log('server error:', err.message);
  // Surface the failure to the supervisor, which will retry with backoff.
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on 0.0.0.0:${PORT}`);
  process.send?.({ type: 'ready' });
});

process.on('SIGTERM', () => {
  log('SIGTERM received, closing');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});
