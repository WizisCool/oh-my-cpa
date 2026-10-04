# Install Oh My CPA (for a coding agent)

You are installing Oh My CPA (OMC) for the person you are working with. OMC is a web
console for CLIProxyAPI (CPA). It needs **CPA v8.0.0 or later** and CPA's plaintext
management key, which is also OMC's sign-in password. The Docker image is
`wiziscool/oh-my-cpa:latest` (amd64 and arm64), so a normal install builds nothing.

The work is: look at what is already there, pick one of three paths, install, verify.

## Rules

1. **Keep secrets out of the conversation.** Do not print `.env` files, management
   keys, the master key or `docker compose config` output. When you need the existing
   management key, write a placeholder into the `.env` file and ask the user to fill it
   in themselves.
2. **Do not change the existing CPA.** No upgrade, no config edit, no restart, no
   stopping another panel or tracker, unless the user agrees to that specific change.
3. **Never replace an existing `OMCPA_MASTER_KEY`.** If an OMC data directory already
   exists, reuse its key. If the key is lost, stop and say so.
4. **Ask before** using `sudo`, installing Docker or a toolchain, opening a port beyond
   `127.0.0.1`, or sending a model request that costs money.

## 1. Look first

```bash
docker version --format '{{.Server.Version}}'; docker compose version
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Networks}}'
ss -ltn 2>/dev/null | grep -E ':(8080|8317)\b'
curl -fsS --max-time 3 http://127.0.0.1:8317/healthz
```

Find out:

- Is CPA running? As a container (which network?), a host process (listening on
  `127.0.0.1` or on all interfaces?), or on another machine?
- Is OMC already installed? Then this is an upgrade (step 5), not an install.
- Does anything else collect CPA's usage, such as another panel's statistics or an
  exporter? CPA gives each usage record to one reader only, so this decides step 3.
- Are ports 8080 and 8317 free?

Ask the user only for what you cannot find out.

## 2. Pick a path

| Found | Path |
| --- | --- |
| No CPA | **A**: install CPA and OMC together |
| CPA runs from a Compose file the user can edit | **B1**: add an OMC service to that file |
| CPA in Docker without such a file, on another machine, or on the host listening on all interfaces | **B2**: add OMC from its own Compose file |
| CPA on the host listening on `127.0.0.1` only, or no Docker | **C**: build OMC from source and run it on the host |
| OMC already installed | Step 5 |

Tell the user which path you chose and what it will create before you start.

## 3. Install

### A. CPA and OMC together

Use a new directory. If any target file already exists, stop and ask.

```bash
mkdir -p oh-my-cpa/{deploy,oh-my-cpa-data,cpa/auths,cpa/logs,cpa/plugins} && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.full.yml -o deploy/compose.full.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o cpa/config.yaml
sudo chown 10001:10001 oh-my-cpa-data

cat > deploy/.env <<EOF
CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 deploy/.env

docker compose -f deploy/compose.full.yml up -d
```

If port 8080 or 8317 is taken, add `OMCPA_BIND=127.0.0.1:<port>` or
`CPA_BIND=127.0.0.1:<port>` to `deploy/.env`. Do not stop whatever holds the port.

### B1. OMC in CPA's Compose file

Find CPA's Compose file (`docker inspect <cpa container>` shows it in the
`com.docker.compose.project.config_files` label). Show the user the change, then add
this under `services:` and leave every existing line as it is:

```yaml
  oh-my-cpa:
    image: wiziscool/oh-my-cpa:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      OMCPA_CPA_BASE_URL: http://cli-proxy-api:8317
      OMCPA_CPA_MANAGEMENT_KEY: ${OMCPA_CPA_MANAGEMENT_KEY:?}
      OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
      OMCPA_DATA_DIR: /data
    volumes:
      - oh-my-cpa-data:/data

volumes:
  oh-my-cpa-data:
```

Set the host in `OMCPA_CPA_BASE_URL` to CPA's service name in that file. If a
top-level `volumes:` key exists, add `oh-my-cpa-data:` under it. Then, in the Compose
file's directory:

```bash
cat >> .env <<EOF
OMCPA_CPA_MANAGEMENT_KEY=replace-me
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 .env
```

Have the user fill in the management key, apply the time-zone and usage-collection
points from B2 (as `environment:` entries here), and start OMC alone:

```bash
docker compose up -d oh-my-cpa
```

Name the service. A bare `docker compose up -d` would also recreate CPA if its
definition or image had drifted. Check afterwards that CPA's container ID and start
time are unchanged. The data lives in a Docker volume, so no `chown` is needed.

### B2. OMC beside an existing CPA

```bash
mkdir -p oh-my-cpa/{deploy,oh-my-cpa-data} && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.omc.yml -o deploy/compose.omc.yml
sudo chown 10001:10001 oh-my-cpa-data

cat > deploy/.env <<EOF
OMCPA_CPA_BASE_URL=http://host.docker.internal:8317
OMCPA_CPA_MANAGEMENT_KEY=replace-me
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 deploy/.env
```

Then adjust `deploy/.env`:

- **CPA URL.** It must be reachable from inside OMC's container.
  - CPA in Docker: add `OMCPA_NETWORK_NAME=<CPA's network>` and
    `OMCPA_NETWORK_EXTERNAL=true`, and use `http://<CPA container name>:8317`.
  - CPA on this host, all interfaces: keep `http://host.docker.internal:8317`.
  - CPA elsewhere: its private or HTTPS address. Leave TLS verification on.
- **Management key.** Ask the user to replace `replace-me` with the plaintext key.
  The bcrypt hash in CPA's `config.yaml` will not work.
- **Time zone.** Add `TZ=` matching CPA's if it is not UTC.
- **Usage collection.** If something else already collects CPA's usage, ask the user:
  stop that tool so OMC records requests, or keep it and add
  `OMCPA_USAGE_INGEST_MODE=off` (OMC then manages CPA but shows no usage). If you
  cannot tell, use `off` and say so. Another management panel that does not collect
  usage needs nothing; leave it running.

```bash
docker compose -f deploy/compose.omc.yml up -d
```

In B1 and B2 alike, CPA treats OMC's container as a remote client. If health reports
`cpa_connected: false` with a correct URL and key, CPA has `management.allow-remote`
turned off. Turning it on is a change to CPA: explain it and ask first.

### C. From source

Needs Go 1.25+, Node.js 22+ and pnpm 11+.

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git && cd oh-my-cpa
pnpm install --frozen-lockfile
cp -n .env.example .env
```

In `.env`, set `OMCPA_MASTER_KEY` (`openssl rand -hex 32`), `OMCPA_CPA_BASE_URL`, and a
placeholder `OMCPA_CPA_MANAGEMENT_KEY` for the user to fill in. Apply the time zone
and usage-collection points from B2. Then:

```bash
pnpm build
go build -trimpath -o bin/oh-my-cpa ./cmd/oh-my-cpa
./bin/oh-my-cpa
```

It runs in the foreground. Offer a systemd unit or similar only if the user wants one.

## 4. Verify

```bash
curl -fsS http://127.0.0.1:8080/omc/api/healthz
```

The install is done only when the response has `"status":"ok"`, `"database_status":"ok"`
and `"cpa_connected":true`. A container that Docker calls healthy is not proof: OMC
stays up with `"status":"degraded"` when it cannot reach CPA. If the check fails, report
the actual reason. Common ones:

| Symptom | Cause |
| --- | --- |
| Database will not open | The `oh-my-cpa-data` directory is not owned by `10001:10001` (A and B2) |
| `degraded`, `cpa_connected: false` | Wrong URL or key, or CPA refuses remote management |
| `cpa_management_api: unsupported` | CPA is older than v8.0.0; the user must upgrade it |

## 5. Upgrading an existing OMC

Do not reinstall. Find the existing Compose file, data directory and `.env`, back up
the data directory and `.env`, then:

```bash
docker compose -f deploy/compose.omc.yml pull oh-my-cpa
docker compose -f deploy/compose.omc.yml up -d --no-deps oh-my-cpa
```

Use `compose.full.yml` if that is the file in place. When OMC is a service in CPA's
Compose file, run `docker compose pull oh-my-cpa` and `docker compose up -d oh-my-cpa`
in that directory. Database migrations only go
forward, so the way back to an older version is to restore the backup. Verify as in
step 4.

## 6. Tell the user

- The console address, `http://127.0.0.1:8080/omc/` unless you changed the port. On a
  remote server, give them `ssh -L 18080:127.0.0.1:8080 user@server` and
  `http://127.0.0.1:18080/omc/`.
- That the sign-in password is the CPA management key, and which file holds it. Not
  the key itself.
- To back up the `.env` file and OMC's data (the `oh-my-cpa-data` directory or volume). Without `OMCPA_MASTER_KEY` the data
  cannot be read.
- Whether OMC is collecting usage, and why not if it is off.
- Anything you changed outside the new `oh-my-cpa` directory.

More detail, including HTTPS behind a reverse proxy and every setting, is in
`docs/install.md`.
