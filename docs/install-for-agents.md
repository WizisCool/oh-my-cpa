# Installation by an agent

Use the same [installation guide](install.md) as a human operator. It owns the commands,
assets and supported deployment paths; this page adds the agent's preflight and handoff.

## Inspect before acting

Determine whether CPA and OMC already exist, how they are started, their network
reachability, OS/architecture, data directories and occupied ports. Inspect names,
image references and network metadata, not container environments or credential files
in tool output. Ask only for facts that cannot be established safely.

Find any other usage collector. CPA gives a queued record to one reader only; choose
one collector before enabling OMC ingestion. Never test availability by consuming a
record. OMC requires the v8 management API and the existing plaintext management key.

## Preserve the existing installation

- Do not print `.env`, management/master keys, auth files or `docker compose config`.
  Let the user supply missing secrets privately; placeholders are not working credentials.
- Never replace an existing master key. If encrypted data exists and its key is lost,
  stop and explain recovery limits before changing the deployment.
- Do not edit, upgrade, restart or remove an existing CPA or another panel without the
  user's authorization for that action. Keep its configuration and auth directories.
- Get explicit approval for privilege elevation, tool installation, opening a public
  port, granting Docker socket access or sending a billable inference request.
- Do not overwrite an existing target file to fit a new-install recipe. An existing
  OMC deployment follows [Upgrading](install.md#upgrading), not fresh key generation.

## Choose one path and use its guide

| Situation | Procedure |
| --- | --- |
| CPA is not installed | [New install](install.md#new-install) |
| Existing editable CPA Compose project | [Add to Compose](install.md#add-to-the-existing-compose-file) |
| Existing CPA reachable from a separate container | [Standalone](install.md#standalone) |
| Host-loopback CPA, or Docker unavailable | [Native executable](install.md#native-executable) |
| Explicit source request or unsupported native target | [From source](install.md#from-source) |

Explain what the chosen path creates before executing it. The updater has host-level
Docker authority; disclose that before starting its service. If declined, omit the
updater and leave ordinary OMC operation intact. Follow
[coexistence](install.md#other-panels-and-usage-trackers) for competing collectors.

## Verify and hand off

Follow [Verifying the install](install.md#verifying-the-install). Check the actual
browser/API base path, health, CPA management reachability and usage-consumer choice.
Do not claim historical usage was imported or issue paid traffic just to populate a graph.

Report the console URL, deployment and data locations, selected update method, how to
start/stop it and any unresolved warnings. Say that the existing CPA management key is
the sign-in password without repeating the value. Link the operator to
[Operations](operations.md) and the [backup/restore runbook](ops/sqlite-operations.md).
