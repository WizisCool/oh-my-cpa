# Routing and model rules

## Model rules

In OAuth management, edit provider-wide model aliases or
`oauth.excluded-models`. A non-empty per-credential `excluded_models` list replaces
the provider default (requires CPA v8.0.33+); clearing the credential override restores
inheritance. Exclusions apply before alias mapping.

## Routing

`/routing` arranges provider keys, OpenAI-compatible providers and OAuth
credentials into priority tiers. Applying a routing plan records an audit attempt,
saves an encrypted configuration backup (`routing_plan`), updates provider priorities/weights
and patches affected OAuth credentials against the board revision (`routing_conflict` on
concurrent changes).
