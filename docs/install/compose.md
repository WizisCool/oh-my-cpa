# Add to an existing Compose file

If CPA already runs under Docker Compose and you prefer not to edit CPA's Compose file,
use [Standalone](standalone.md) with `OMCPA_NETWORK_NAME` and `OMCPA_NETWORK_EXTERNAL=true`.

If you prefer to manage CPA and OMC in a single Compose file, add `oh-my-cpa` and
`oh-my-cpa-updater` under `services:` in CPA's Compose file, and add `oh-my-cpa-data:`
under the top-level `volumes:` key:

```yaml
  oh-my-cpa:
    image: ${OMCPA_IMAGE:-wiziscool/oh-my-cpa:latest}
    restart: unless-stopped
    user: ${OMCPA_USER:-10001:10001}
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    ports:
      - ${OMCPA_BIND:-127.0.0.1:8080}:8080
    environment:
      TZ: ${TZ:-UTC}
      OMCPA_BASE_PATH: ${OMCPA_BASE_PATH:-/}
      OMCPA_DATA_DIR: /data
      OMCPA_DEFAULT_LANGUAGE: ${OMCPA_DEFAULT_LANGUAGE:-}
      OMCPA_CPA_BASE_URL: ${OMCPA_CPA_BASE_URL:-http://cli-proxy-api:8317}
      OMCPA_CPA_MANAGEMENT_KEY: ${OMCPA_CPA_MANAGEMENT_KEY:?}
      OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
      OMCPA_USAGE_INGEST_MODE: ${OMCPA_USAGE_INGEST_MODE:-auto}
      OMCPA_PUBLIC_URL: ${OMCPA_PUBLIC_URL:-}
      OMCPA_TRUSTED_PROXY_CIDRS: ${OMCPA_TRUSTED_PROXY_CIDRS:-}
    volumes:
      - ${OMCPA_DATA_PATH:-oh-my-cpa-data}:/data

  oh-my-cpa-updater:
    image: ${OMCPA_IMAGE:-wiziscool/oh-my-cpa:latest}
    container_name: ${OMCPA_UPDATER_CONTAINER_NAME:-oh-my-cpa-updater}
    restart: unless-stopped
    command: ["updater", "serve"]
    user: "0:0"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - ${DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock

volumes:
  oh-my-cpa-data:
```

`cli-proxy-api` is the service name in CPA's official Compose file; if your CPA service
has another name, set `OMCPA_CPA_BASE_URL=http://<cpa-service-name>:8317` in `.env`.

Append `OMCPA_MASTER_KEY` and CPA's plaintext management key (single-quoted in `.env` so
`$` is not expanded) to `.env` in the Compose directory (`>>` preserves existing lines):

```bash
printf 'OMCPA_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
cat >> .env <<'EOF'
OMCPA_CPA_MANAGEMENT_KEY='<CPA plaintext management key>'
EOF
chmod 600 .env
```

Edit `.env` to replace `<CPA plaintext management key>` (and add
`OMCPA_USAGE_INGEST_MODE=off` if another management panel already drains CPA's Redis usage
queue; see [Other management panels](standalone.md#other-management-panels)).

Start only the new services so the running CPA container is not recreated or restarted:

```bash
docker compose up -d oh-my-cpa oh-my-cpa-updater
```

Open **`http://127.0.0.1:8080/`** and sign in with CPA's management key.
