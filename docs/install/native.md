# Native executable

[GitHub Releases](https://github.com/WizisCool/oh-my-cpa/releases) publish OMC for
Darwin (macOS), Windows, Linux and FreeBSD, each on **amd64** and **arm64**. `x86_64`
is amd64; `aarch64` and Apple Silicon are arm64. Unix archives are `.tar.gz`; Windows
archives are `.zip`. CPA must already be installed separately (v8.0.0 or later).
The console and IANA time-zone database are embedded, so neither Node, Go nor Docker
is needed. HTTPS uses the operating system's certificate roots. Darwin/Windows
binaries are unsigned; inspect the release and verify its checksum before handling
any operating-system trust prompt.

Choose one published version and its matching OS/architecture asset. On Unix, set
these values to that release and host; the example uses Linux amd64:

```bash
VERSION=MAJOR.MINOR.PATCH
OS=linux
ARCH=amd64
ASSET="oh-my-cpa_${VERSION}_${OS}_${ARCH}.tar.gz"
mkdir -p oh-my-cpa && cd oh-my-cpa
curl -fLO "https://github.com/WizisCool/oh-my-cpa/releases/download/v${VERSION}/${ASSET}"
curl -fLO "https://github.com/WizisCool/oh-my-cpa/releases/download/v${VERSION}/checksums.txt"
```

Verify **only the downloaded archive's entry** (the manifest also lists the other
platforms and installation attachments). On Linux use `sha256sum -c`, on macOS
`shasum -a 256 -c`, or on FreeBSD compare `sha256 -q "$ASSET"` with its entry:

```bash
grep -F "  $ASSET" checksums.txt | sha256sum -c -
tar -xzf "$ASSET"
cp -n .env.example .env
chmod 600 .env
```

On Windows, download the matching ZIP and `checksums.txt` from the same release,
use PowerShell `Get-FileHash -Algorithm SHA256` and compare with that ZIP's manifest
entry, then `Expand-Archive` into a new directory and copy `.env.example` to `.env`.
Restrict access to `.env` and the data directory to the service account with Windows
file ACLs. Do not overwrite an existing configuration or data directory.

Set `OMCPA_MASTER_KEY` once to a random 64-character hex string (`openssl rand -hex 32`
on Unix; use a cryptographic random generator on Windows), set CPA's plaintext
management key and its reachable URL, and match CPA's `TZ`. Keep `OMCPA_VERSION`
unset so the tagged build reports its embedded version. The included template binds
`127.0.0.1:8080` via `OMCPA_LISTEN_ADDR`, serves the site root and writes SQLite to
`./data` under the working directory. Change `OMCPA_LISTEN_ADDR` if port `8080` is
already in use on the host. When CPA is on the same host, its loopback URL works without
changing CPA's remote management policy.

Run `./oh-my-cpa` on Unix or `.\oh-my-cpa.exe` on Windows from that directory. Verify
[health and connectivity](troubleshooting.md), then open `http://127.0.0.1:8080/`
(or your configured `OMCPA_LISTEN_ADDR`) and sign in with CPA's management key. For an
operator-owned service manager, keep the same working directory, environment file,
service account and data path. Do not open the listener to the network without
configuring remote access and HTTPS.


## Running it as a service

Run OMC under a dedicated user or service account, keep its working directory, and
restrict `.env` and the data directory with Unix permissions or Windows ACLs. The
container's `10001:10001` user is not a requirement for native installs. Leave
`OMCPA_VERSION` unset so the release tag embedded in the executable is reported.

## Upgrading a native install

Stop OMC alone, back up `.env` and its data directory, verify and extract the new archive
separately, then replace only the executable and start it from the original working
directory. Preserve the master key and state. Verify health and the new running version.
Migrations are forward-only: returning to an older executable requires restoring the
matching data backup.
