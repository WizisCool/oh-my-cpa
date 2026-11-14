# Installation

Oh My CPA (OMC) runs beside [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
(CPA) **v8.0.0 or later**. The console's sign-in password is CPA's management key. The
image is **`wiziscool/oh-my-cpa`** on Docker Hub, for `linux/amd64` and `linux/arm64`.
Pick the path that matches where CPA runs today:

| Your situation | Guide |
| --- | --- |
| CPA is not deployed yet | [Quickstart](quickstart.md) |
| CPA runs on the host, in another Docker project, or on another machine | [Standalone](install/standalone.md) |
| CPA runs under Docker Compose and you want one Compose file | [Add to an existing Compose file](install/compose.md) |
| No Docker: macOS, Windows, Linux or FreeBSD on amd64/arm64 | [Native executable](install/native.md) |
| No published build for your platform, or you want to build it | [Build from source](install/source.md) |
| OMC is already installed | [Upgrading](install/upgrade.md) |

A coding agent can follow the same paths: give it [the agent guide](install-for-agents.md).

<a id="release-compose-files"></a>

## Release Compose files

The Docker paths need Docker Engine with the Compose plugin; the commands assume a Linux
or macOS shell with `curl` and `openssl`. Each release publishes two Compose files in
`deploy/` and as release assets:

- **`compose.full.yml`**: CPA, OMC and the updater ([Quickstart](quickstart.md)).
- **`compose.omc.yml`**: OMC and the updater beside an existing CPA ([Standalone](install/standalone.md)).

Both run OMC as non-root user `10001:10001` with a read-only root filesystem, no Linux
capabilities and `no-new-privileges:true`, keep its SQLite database in the
`oh-my-cpa-data` named volume (no `mkdir` or `chown` needed), include
`oh-my-cpa-updater` for one-click console updates, and read overrides from `.env` in
the same directory.

## New install

Covered step by step in the [Quickstart](quickstart.md).

## Standalone

See [Standalone](install/standalone.md), including how to make CPA reachable from the
container.

## Add to the existing Compose file

See [Add to an existing Compose file](install/compose.md).

## Native executable

See [Native executable](install/native.md).

## From source

See [Build from source](install/source.md).

## Verifying the install

See [Troubleshooting](install/troubleshooting.md).

## Upgrading

See [Upgrading](install/upgrade.md).
