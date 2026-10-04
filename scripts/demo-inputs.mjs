/**
 * The files the demonstration dataset is derived from.
 *
 * A change to any of them can change a served response, so each one invalidates the
 * committed copy. The list is deliberately the shape of the dependency rather than
 * every file that could be involved: a digest over the whole repository would fail on
 * a documentation edit and train everyone to regenerate without reading.
 *
 * Both `generate-demo-data.mjs` and `check-demo.mjs` import this list so the two can
 * never drift apart.
 */
export const INPUTS = [
  'internal/api/demo_export_test.go',
  'internal/demo/fixture.go',
  'internal/demo/seed.go',
  'internal/demo/quota.go',
  'internal/api/management_quota.go',
  'internal/api/management_quota_capacity.go',
  'internal/quota/capacity.go',
  'internal/quota/capacity_scope.go',
  'internal/quota/capacity_history.go',
  'internal/quota/types.go',
  'internal/quota/claude.go',
  'internal/quota/codex.go',
  'internal/quota/antigravity.go',
  'internal/repository/quota.go',
  'scripts/demo-inputs.mjs',
  'internal/demo/upstream.go',
  // The price book is priced from this snapshot by the same decoder and matcher a sync uses.
  'internal/demo/openrouter_snapshot.json',
  'internal/pricing/openrouter.go',
  'internal/pricing/match.go',
  'internal/api/management_pricing.go',
  'internal/cpa/gateway/client.go',
  'internal/cpa/gateway/types.go',
  'internal/cpa/gateway/agent.go',
  'internal/api/playground.go',
  'internal/api/agent_http.go',
  'internal/api/agent_projection.go',
  'internal/api/browser_runs.go',
  'internal/api/playground_run_state.go',
  'internal/api/agent_wiring.go',
  'internal/capability/registry.go',
  'internal/agent/runtime.go',
  'internal/operations/config.go',
  'internal/operations/config_validation.go',
  'internal/operations/keys.go',
  'internal/operations/oauth.go',
  'internal/operations/pricing.go',
  'internal/operations/provider_mutations.go',
  'internal/operations/providers.go',
  'internal/operations/quota.go',
  'internal/operations/quota_actions.go',
  'internal/operations/service.go',
  'internal/operations/system.go',
  'internal/operations/usage.go',

  'internal/api/demo_policy.go',
  'web/src/api/client.ts',
  'web/src/types/usageEvents.ts',
  'deploy/cloudflare/routes.mjs',
  'deploy/cloudflare/time.mjs',
  // The Worker decides routing, refusals and what each response becomes, so a change to
  // it changes what a visitor is served as surely as a change to the export does. It was
  // missing from this list, which meant the two files that most directly shape a served
  // response were the two the digest did not cover.
  'deploy/cloudflare/worker.mjs',
  'scripts/generate-demo-data.mjs',
  // The dataset states the pinned Go toolchain as the gateway's runtime version.
  'scripts/tools-versions.json',
  // The packaging step decides what the served assets reference, so a change to it
  // changes the demonstration as surely as a change to the Worker does.
  'scripts/build-demo.mjs',
];
