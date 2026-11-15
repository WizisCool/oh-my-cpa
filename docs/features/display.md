# Display and icons

## Display currency

**OMC Settings → Data display → Display currency** converts
Dashboard, Request Records and Insights readouts using cached Frankfurter USD-base
exchange rates (`api.frankfurter.dev`, refreshed daily or on demand and persisted in
`exchange_rate_cache`). Model Pricing, price editing and stored accounting remain in USD.

## TPS calculation

**OMC Settings → Display** selects whether request-record and
Playground TPS includes first-token latency (default) or excludes TTFT when a non-reasoning
first-token boundary is known. Stored usage and timing are never rewritten.

## Custom provider icons

Upload up to 100 static PNG/JPEG/WebP/SVG icons (≤ 512 KiB,
≤ 1024 × 1024) in the provider icon picker. Icons persist in SQLite and are included in
database backups; deleting an icon restores affected providers to their default mark.
