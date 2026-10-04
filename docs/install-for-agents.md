# Install Oh My CPA (instructions for a coding agent)

You are an AI coding agent installing Oh My CPA for the person you are working with.
Follow the steps in order. The human-oriented version of this guide is
`docs/install.md`; this one states the decisions and the checks explicitly.

Oh My CPA is a self-hosted web console for
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA): one Go binary with an
embedded console and a local SQLite database. It needs a CPA **v8.0.0 or later** and that
gateway's plaintext management key, which is also the console's sign-in password.

## Rules

- **Never print, log or commit a secret.** The management key and `OMCPA_MASTER_KEY`
  go into an environment file that is gitignored (`.env`, `deploy/.env`) and nowhere
  else. When you report back, name the file a value lives in, not the value.
- **Never reuse or overwrite an existing `OMCPA_MASTER_KEY`.** If an environment file
  already has one, keep it: data encrypted with it is unreadable under a new key.
- **Do not point a second collector at a CPA.** CPA's usage queue is destructive, so
  only one process may read it. If something else already collects usage from that
  gateway, set `OMCPA_USAGE_INGEST_MODE=off` and tell the user.
- **Ask before taking ports 80 and 443**, before exposing anything beyond loopback,
  and before using `sudo`.
- Do not edit files under `migrations/` or the database by hand.

## Step 1: Find out what you are working with

Run these and read the answers before choosing a path:

```bash
docker version --format '{{.Server.Version}}' 2>/dev/null; docker compose version 2>/dev/null
go version 2>/dev/null; node --version 2>/dev/null; pnpm --version 2>/dev/null
curl -s -m 3 http://127.0.0.1:8317/healthz    # is a CPA already running locally?
```

Then ask the user only what you cannot determine:

1. Is there an existing CPA to connect to? If so, its URL and management key.
2. Will the console be opened on this machine only, or under a public host name?

## Step 2: Choose a path

| Situation | Path |
| --- | --- |
| Docker is available and there is no CPA yet | A: full stack |
| Docker is available and a CPA already runs | B: console only |
| No Docker; Go 1.25+, Node.js 22+ and pnpm 11+ are available | C: from source |

If none applies, stop and tell the user which requirement is missing.

All paths start the same way:

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa
```

### Path A: full stack (CPA + Oh My CPA + Caddy)

```bash
mkdir -p cpa oh-my-cpa-data
[ -f cpa/config.yaml ] || curl -fsSL \
  https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml \
  -o cpa/config.yaml
sudo chown 10001:10001 oh-my-cpa-data

[ -f deploy/.env ] || cat > deploy/.env <<EOF
CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
DOMAIN=localhost
OMCPA_PUBLIC_URL=https://localhost
EOF
chmod 600 deploy/.env

docker compose --env-file deploy/.env -f deploy/compose.full.yml up -d --build
```

- For a public host name, set `DOMAIN` to it and `OMCPA_PUBLIC_URL` to
  `https://<that name>`.
- If ports 80 or 443 are taken, set `HTTP_BIND` and `HTTPS_BIND` in `deploy/.env`
  (for example `127.0.0.1:8088` and `127.0.0.1:8443`) and include the port in
  `OMCPA_PUBLIC_URL`.
- Console address: `https://<DOMAIN>/omc/`. On `localhost` the certificate comes from
  Caddy's local authority, so the browser warns once.

### Path B: console only, beside an existing CPA

```bash
mkdir -p oh-my-cpa-data
sudo chown 10001:10001 oh-my-cpa-data

[ -f deploy/.env ] || cat > deploy/.env <<EOF
OMCPA_CPA_BASE_URL=<CPA URL reachable from inside the container>
OMCPA_CPA_MANAGEMENT_KEY=<CPA management key>
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
OMCPA_PUBLIC_URL=http://127.0.0.1:8080
EOF
chmod 600 deploy/.env

docker compose --env-file deploy/.env -f deploy/compose.omc.yml up -d --build
```

`127.0.0.1` inside the container is the container, not the host. If CPA listens only
on the host's loopback, use path C or path A instead. Console address:
`http://127.0.0.1:8080/omc/`.

### Path C: from source

```bash
pnpm install --frozen-lockfile
[ -f .env ] || cp .env.example .env
```

Edit `.env`: set `OMCPA_MASTER_KEY` to the output of `openssl rand -hex 32`, set
`OMCPA_CPA_MANAGEMENT_KEY`, and set `OMCPA_CPA_BASE_URL` and `OMCPA_CPA_USAGE_ADDR` if
CPA is not on `127.0.0.1:8317`. Then:

```bash
pnpm build
go build -o bin/oh-my-cpa ./cmd/oh-my-cpa
./bin/oh-my-cpa
```

The process stays in the foreground; run it under the user's service manager if they
want it to survive a reboot. Console address: `http://127.0.0.1:8080/omc/`.

## Step 3: Verify

Do not report success until this passes. Use the console address from your path:

```bash
curl -sk <console address>api/healthz
```

| Answer | Meaning | What to do |
| --- | --- | --- |
| `"status":"ok"`, `"cpa_connected":true` | Installed and connected | Go to step 4 |
| `"status":"degraded"` | The console runs but cannot reach CPA | Check `OMCPA_CPA_BASE_URL` and the management key |
| No answer; logs say `unable to open database file` | The data directory is not writable by uid 10001 | `sudo chown 10001:10001 oh-my-cpa-data`, then start again |
| No answer; logs say `invalid configuration` | A variable is missing or malformed | Read the message: it names the variable |

Logs: `docker compose --env-file deploy/.env -f <compose file> logs oh-my-cpa`, or the
process's stderr for a source install.

## Step 4: Report back

Tell the user:

- the console address, and that the sign-in password is the CPA management key;
- which file holds the management key and `OMCPA_MASTER_KEY`, and that the master key
  must be backed up outside the data directory;
- anything you changed from the defaults (ports, base path, ingest mode).

## Optional: connect yourself through MCP

Oh My CPA exposes its management capabilities to external agents through a stdio MCP
server built into the same binary. Offer it; do not set it up unasked, because the
management key it needs is administrator-equivalent.

```bash
go build -o bin/oh-my-cpa ./cmd/oh-my-cpa
```

```json
{
  "mcpServers": {
    "oh-my-cpa": {
      "command": "/absolute/path/to/oh-my-cpa/bin/oh-my-cpa",
      "args": ["mcp"],
      "env": {
        "OMCPA_SERVER_URL": "http://127.0.0.1:8080/omc",
        "OMCPA_CPA_MANAGEMENT_KEY": "<CPA management key>"
      }
    }
  }
}
```

`OMCPA_SERVER_URL` is the console address including its base path. Plain HTTP is
accepted for loopback addresses only; any other host must be HTTPS. Through MCP you can
read state and prepare changes, but you cannot approve a change, submit a secret or
complete an OAuth sign-in: those stay with the person at the console. The full contract
is `docs/agent-capabilities.md`.
