# How it works

Oh My CPA (OMC) is the control plane for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
(CPA). CPA is the gateway: it holds provider credentials and proxies your clients' model
requests. OMC sits beside it and never carries model traffic. It manages CPA through its
Management API and records what CPA did.

```text
Clients ──▶ CLIProxyAPI (:8317) ──▶ Model providers
                  ▲   │
     Management API   │ usage records
                  │   ▼
Browser ──▶ Oh My CPA (:8080)
              ├─ Embedded web console
              ├─ SQLite database (/data)
              └─ Usage collector
```

## The two processes

| | CLIProxyAPI | Oh My CPA |
| --- | --- | --- |
| Role | Gateway that clients call | Console and records for operators |
| Holds | Provider keys, OAuth credentials, client keys, `config.yaml` | Request records, prices, quota observations, audit log, preferences |
| Port | `8317` | `8080` |
| Needed by clients | Yes | No: clients keep working while OMC is stopped |

OMC requires CPA v8.0.0 or later. It discovers what the gateway supports instead of
guessing from a version number; the [CPA contract](cpa-v8-compat.md) lists what it reads
and writes.

## Two keys

- **CPA's management key** authenticates OMC to CPA and is also your console sign-in
  password. OMC never stores it in its database; the one deliberate browser-storage
  exception is mirroring it into the CPAMC-compatible `cli-proxy-auth` entry while signed
  in so native plugin pages can read it (withdrawn on sign-out, a refused session check,
  or the next sign-in).
- **`OMCPA_MASTER_KEY`** encrypts credentials, payloads and backups inside OMC's database.
  It is generated once and must never change; losing it makes existing database records
  unreadable unless you restore a passphrase-protected `.omcbackup` into a deployment
  with a new master key (see [Backup and restore](ops/sqlite-operations.md)).

## What happens to a request

1. A client sends a request to CPA, which routes it to a provider and writes a usage
   record.
2. OMC's collector reads that record, prices it from its price book and stores it.
3. The console shows it within a second: latency, tokens, cache use, cost, and which key,
   credential and provider served it.

Configuration changes take the opposite path. On the console's checked write path, OMC
checks the revision it last read (native plugin writes retain CPA's last-write
semantics), saves an encrypted backup of CPA's configuration, writes only the changed
fields and reads the result back. Every change lands in the audit log.

## Where things run

- **One OMC per data directory.** SQLite in WAL mode needs exclusive access on a local disk.
- **The console is unprivileged.** It runs as a non-root user with a read-only filesystem.
  Only the optional `oh-my-cpa-updater` container holds the Docker socket; it verifies the
  project's Ed25519 manifest signature for OMC updates (CPA updates pull the running
  container's configured tag).
- **The console is one server.** The web UI and its API share port `8080`, so a reverse
  proxy needs a single upstream.

For the module-level design, see [Architecture](dev/architecture.md).
