# ADR 0077: Composer settings use named picker lists

- Status: Accepted
- Date: 2026-10-08
- Supersedes the reasoning-scale and client-key-selector presentation in
  [ADR 0076](0076-the-agent-has-its-own-shell-and-names-its-model-in-the-composer.md).
  Its conversation shell and target request semantics remain unchanged.

## Context

Model and reasoning are settings of the same message. Operators need to read the
current choice, browse alternatives and confirm a change with the same interaction.
Reasoning has short discrete names, while a model may have a long call-point name;
the surfaces therefore share behaviour without sharing a fixed width.

## Decision

`ComposerPicker` owns the popover, trigger and focus policy for both settings.
`ComposerPickerList` offers named choices with a roving tab stop. Arrows, Home and
End browse without changing a request; Enter, Space or click commits. Confirmation
and Escape close the surface and return focus to the trigger.

Model lists use a 304px surface, manufacturer marks and search beyond eight names.
The client key is a secondary footer action: its list replaces the model list in the
same surface, and choosing a different key returns to that key's available models.

Reasoning lists use a 180px surface with model default first, followed by parameter
names and secondary localized descriptions. The text trigger states the current parameter name
(`Low`, `High`, `Max`, `xHigh`) across languages in foreground ink at regular 400
weight. These display spellings do not change the stored or transmitted request value.
A filled selected row and bold name identify the current choice. Reasoning leads
with the parameter name; its localized description is trailing-aligned in muted ink.
Identical descriptions are omitted. Model rows also carry an ink-colored check.

Both surfaces are viewport-bounded and reuse existing palette, typography and motion
tokens. Touch rows keep a 44px hit target.

## Consequences

The model call-point name, key fingerprint and reasoning value travel unchanged.
The empty reasoning value still omits the request field; a provider-specific stored
value stays visible and selectable. The menu presents request values rather than
model speed or answer-quality guarantees.
