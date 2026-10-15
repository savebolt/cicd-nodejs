# autodeploy-node

A single entry point Node.js app that serves the **Kasir Sederhana** web app and
keeps itself up to date from this GitHub repository. No dependencies, no build
step, no shell access required — designed for a Pterodactyl container that can
only run `node index.js` on one open port.

```
node index.js
│
├─ index.js      supervisor: never exits, binds no port, does the git work
│   └─ server.js web process: serves public/ + /webhook, killed & respawned on deploy
│
└─ public/       the kasir app (index.html, app.js, style.css)
```

## How a deploy works

1. You push to `main`.
2. GitHub posts to `POST /webhook` (or the 2 minute poll notices the new commit).
3. `server.js` verifies the request and asks the supervisor to deploy.
4. The supervisor pulls the new commit, then decides what to reload:

| What changed | What happens | Downtime |
| --- | --- | --- |
| `public/**` only | nothing to restart, files are read per request | none |
| `server.js` | the web process is killed and respawned | ~50 ms |
| `index.js` | logged as stale — restart from the panel to apply | none until you restart |

`index.js` is deliberately small and boring so you rarely need that manual
restart. It never exits on its own, which is what keeps Pterodactyl from
marking the container offline.

## Deploy strategies

The supervisor probes the container at boot and logs which mode it picked:

- **git** — used when `git` exists and the folder is a clone:
  `git fetch --depth 1` then `git reset --hard FETCH_HEAD`.
- **tarball** — the fallback when `git` is missing (common in Node eggs). It
  downloads `codeload.github.com/<repo>/tar.gz/<sha>`, gunzips it with
  `node:zlib` and unpacks it with a small built-in tar reader. `.git/` and
  `config.json` are never overwritten.

Either way you do not need CLI access.

### Reading the latest commit

To decide whether anything changed, the supervisor asks the remote for the SHA
of the branch tip, trying these in order and using the first that answers:

1. `git ls-remote` — only when a git binary exists
2. `GET /info/refs?service=git-upload-pack` — git's smart-HTTP transport over
   plain `fetch`. **No rate limit**, no git binary required.
3. the GitHub REST API — last resort, capped at 60 requests/hour per IP

That order matters on shared hosting: the REST API limit is per IP, so on a
provider like Danbot it is often already exhausted by other tenants. The git
protocol endpoint has no such cap, which is what keeps polling dependable.

## Running it

```bash
node index.js
```

Then open the port in a browser for the kasir app.

| Route | Purpose |
| --- | --- |
| `GET /` | the kasir web app |
| `GET /health` | JSON status: uptime, current commit, last deploy, mode |
| `POST /webhook` | GitHub push receiver |

### Pterodactyl setup

1. Set the startup command to `node index.js` (or let it use `npm start`).
2. Make sure the server's **primary allocation** is the port you want; the app
   reads `SERVER_PORT`, then `PORT`, then falls back to `3000`.
3. Upload a `config.json` via the file manager (see below) if you want a secret.
4. Start the server. The web app and the webhook share the one open port.

## Configuration

Everything is optional. Values are read from environment variables first, then
`config.json`, then sane defaults. Copy `config.example.json` to `config.json`
and edit it:

```json
{
  "repo": "savebolt/cicd-nodejs",
  "branch": "main",
  "secret": "some-long-random-string",
  "pollSeconds": 120
}
```

| Key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `repo` | `GITHUB_REPO` | `savebolt/cicd-nodejs` | `owner/name` to deploy from |
| `branch` | `GITHUB_BRANCH` | `main` | branch to track |
| `secret` | `WEBHOOK_SECRET` | *(empty)* | shared secret for signature checks |
| `port` | `SERVER_PORT` / `PORT` | `3000` | HTTP port |
| `pollSeconds` | `POLL_SECONDS` | `120` | backup poll interval, `0` disables |

`config.json` and `.deploy-state.json` are gitignored, so deploys never
overwrite your local settings.

### The webhook secret

The secret is just a password you invent. You paste the same string into
GitHub's webhook form and into `config.json`. GitHub then signs every payload
with it (`X-Hub-Signature-256`) and the server recomputes that signature to
confirm the request really came from GitHub.

If you leave it empty the app still works — it logs a warning and accepts
unsigned requests. The worst a stranger can do is make the server pull your own
repo, but setting a secret is one line and closes that off.

Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### GitHub webhook setup

In the repo: **Settings → Webhooks → Add webhook**

- **Payload URL**: `http://<your-host>:<port>/webhook`
- **Content type**: `application/json`
- **Secret**: the same string as in `config.json`
- **Events**: just the push event

GitHub sends a `ping` on save; a `200` with `{"pong": true}` means it is wired
up. Pushes to other branches are answered with `202` and ignored.

Even if GitHub cannot reach the URL, the backup poll still picks up new commits
within two minutes.

## The kasir app

`public/` is the unmodified static app: product CRUD, a cart with stock checks,
payment with change calculation, and transaction history. State lives in the
browser's `localStorage`, so there is no database and nothing server-side to
back up.
