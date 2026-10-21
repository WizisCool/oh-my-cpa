# ADR 0104: Oh My CPA's plugin registry is a managed store source

- Status: Accepted
- Date: 2026-10-22

## Context

CPA's plugin store reads its built-in `official` registry plus whatever
`plugins.store-sources` lists. Oh My CPA had no registry of its own, so a plugin
published by this project had to live in someone else's registry or be pasted onto
every installation by hand, and the console that ships it could not offer it as a
first-class entry.

Two constraints shaped the decision. CPA can only list and install from a registry it
has in its own configuration, so the address has to reach `plugins.store-sources`: the
console cannot serve a catalogue CPA does not know. And the console has a
whole-document configuration editor, so anything stored in that file can be removed by
hand — while an operator expects the source this product ships to work like CPA's
built-in one.

The store's trust model already has two answers: an entry from the built-in registry
with a first-party repository is **official**, and everything else is **third-party**,
installed only after the plugin id is typed. A registry published by this project is
still someone else's code relative to the gateway.

## Decision

1. **The registry is a file in this repository.** `plugins/registry.json` is published
   over HTTPS from the `master` branch and compiled in as
   `pluginregistry.OMCSourceURL`. It is neither an operator setting nor an environment
   variable: every installation has the same registry, and publishing a plugin is a
   change to that file.

2. **One preference, reconciled by the server.**
   `omc_plugin_source_enabled` (default on) is read server-side. Reading the store,
   installing, saving the plugin settings and saving either form of the configuration
   put the address into `plugins.store-sources` when the preference is on and remove
   it when off, under the provider write gate and the configuration mutex. A
   configuration save that removed the address is repaired inside the save's own lock
   scope, so the revision the editor receives already contains it. Direct
   configuration editing therefore cannot switch the source off; only the preference
   can.

3. **The store marks and orders it.** Entries from the managed registry carry
   `is_omc`, the source is named "Oh My CPA" rather than CPA's URL-host default, and
   its entries are listed before every other registry's, with each registry's own order
   kept. They are not **official**: only the built-in registry plus a first-party
   repository is (ADR 0029), and installing one still requires typing the plugin id.

4. **The switch lives on the OMC settings page.** The plugin settings tab shows the
   source as a fixed row — its address, whether it is on, and a link to the switch — and
   never includes it in the editable source list. A plugin-settings save that omits it
   keeps it exactly as the preference says, and one that submits it does not store a
   second copy.

## Consequences

- A store read can now write the configuration. It is the one read that does, it
  writes only when the file disagrees with the preference, and it takes a backup and
  writes an audit row. A failure there fails the read rather than serving a store that
  is not the one the operator configured.
- `plugins.store-sources` is no longer purely the operator's list: one entry is
  managed, and the settings page says so. A deployment's store read either repairs the
  file or fails; it never serves entries the switch turned off.
- The published registry starts empty and an empty document is valid, so the source is
  present and healthy before the first Oh My CPA plugin exists.
- The demonstration cannot write its fixture, so it answers the switch by filtering the
  managed entries out of the store response; the switch has the same visible effect
  there.
- A changed registry address silently changes the source id CPA derives from it, so the
  address and its derived id are pinned by a test: moving the registry is a deliberate
  edit, not an accident in a constant.
