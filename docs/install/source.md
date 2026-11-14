# Build from source

Needs Go 1.26+, Node.js 22+, pnpm 11+ and a running CPA.

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa
pnpm install --frozen-lockfile
cp .env.example .env
```

In `.env`, set `OMCPA_MASTER_KEY` (`openssl rand -hex 32`), `OMCPA_CPA_MANAGEMENT_KEY`
and `OMCPA_CPA_BASE_URL`. Then:

```bash
pnpm build
go build -trimpath -o bin/oh-my-cpa ./cmd/oh-my-cpa
./bin/oh-my-cpa
```

Open `http://127.0.0.1:8080/`. The process runs in the foreground; a service manager
such as systemd keeps it running. Variables in the environment win over `.env`, and
`OMCPA_ENV_FILE` points at a different file. A build from an untagged checkout reports
itself as `v0.1.0-dev`. For hot reload while developing, see
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).
