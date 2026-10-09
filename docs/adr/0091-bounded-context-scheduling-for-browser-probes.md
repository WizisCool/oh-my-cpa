# ADR 0091: Bounded context scheduling for browser probes

- Status: Accepted
- Date: 2026-10-09

Allow at most two scenario workers inside one owned Vite/Chromium batch. Each
scenario retains its fresh context, fixture state, storage, cookies, fault ledger,
120-second budget and bounded close. Keep separate local batches and built/browser/
demo lanes sequential; keep the 480-second batch watchdog and complete hosted shard
membership. A queue stops admission on shutdown and joins every admitted worker
before shared teardown. Outcomes/failures are collated in catalog order, and the
watchdog names every active scenario/step rather than one overwritten global label.

Four representative complex scenarios retain all 276 checks in paired serial/two-
worker samples. Measured lower wall time with similar CPU comes at higher memory
and longer individual scenario durations; this is scheduling efficiency, not less
coverage or a faster product. Catalog entrypoints choose two workers and expose
`--workers 1` for identical serial reproduction; `verify:full:serial` explicitly
selects it. The core runner keeps its serial default for direct harness callers.
Do not infer that more workers are safe or beneficial. Complete catalog/fault and
hosted evidence, resource limits and measurement caveats belong in
`docs/plans/architecture-governance.md`.

Real-browser harness tests retain all runtime/method/unknown-route/outbound faults
in both schedules and show a fault in one context cannot fail its healthy sibling.
Queue tests pin bounded admission, exact-once coverage, serial order, peer joining
and shutdown. Reusing an already verified dashboard landing between locale cases
avoids redundant bootstrap navigation; all actual failure/reload/home, locale,
geometry, keyboard, progress and error assertions remain engine-owned.
