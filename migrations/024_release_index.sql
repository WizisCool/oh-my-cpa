-- Release index and check state for the System Information page.
--
-- This table caches what a release feed already told us, so the console can answer
-- "which versions exist, and what changed between mine and the newest" without
-- asking again for every page view. A release feed is a remote, rate-limited,
-- rate-limited-by-IP resource: the unauthenticated GitHub API allows sixty
-- requests per hour, so a page that fetched on every render would spend the
-- operator's whole budget on reloads and then leave the page unable to say
-- anything at all.
--
-- What is stored here is metadata only, and that is a deliberate boundary. A
-- release's prose body is NOT stored: the console keeps bodies in bounded process
-- memory for the lifetime of the process and re-reads them from the feed. The
-- operator chose that explicitly. The consequence is honest and visible in the
-- UI - after a restart, or offline, the index still answers "is there a newer
-- version" while the change log itself is unavailable - and it keeps untrusted,
-- arbitrarily large remote text out of the database that holds the audit trail.
--
-- The row is keyed by product rather than by version, because the question this
-- table exists to answer is per product: "the newest release I know of for Oh My
-- CPA" and "for the gateway". A product's index is replaced as a unit on a
-- successful check, so a feed that no longer lists a withdrawn release does not
-- keep claiming it exists.
--
-- `prerelease` is stored rather than filtered on write: the page shows stable
-- releases by default and the flag is what lets it be honest about a version that
-- is newer but was never released as stable.

CREATE TABLE IF NOT EXISTS release_index (
    -- Product key: 'omc' or 'cpa'. Not an enum, so adding a product is a code
    -- change rather than a migration.
    product TEXT NOT NULL,
    -- The upstream repository the row was read from ('owner/name'), recorded so a
    -- changed source invalidates the index instead of mixing two feeds.
    repository TEXT NOT NULL,
    tag TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    -- Publication time in milliseconds. Zero means the feed did not say.
    published_at_ms INTEGER NOT NULL DEFAULT 0,
    prerelease INTEGER NOT NULL DEFAULT 0 CHECK (prerelease IN (0, 1)),
    -- Guards against a re-read of the same tag being a no-op: the page can tell
    -- whether anything actually moved since the last successful check.
    checked_at_ms INTEGER NOT NULL,
    PRIMARY KEY (product, tag)
);

-- The page reads one product's releases newest-first, and the checker compares the
-- stored index against the feed it just read.
CREATE INDEX IF NOT EXISTS idx_release_index_product_published
    ON release_index(product, published_at_ms DESC);

-- Per-product check state. This mirrors pricing_sync_state deliberately: the
-- System Information page has to be able to say "checked 4 minutes ago and it
-- failed with this reason" rather than presenting stale data as current, and that
-- needs a place to record the last attempt separately from the last success.
--
-- `last_success_at_ms` and `last_attempt_at_ms` are separate on purpose. A failed
-- check must not erase when the data actually came from, and a check that has
-- never succeeded must be distinguishable from one that succeeded at epoch zero.
--
-- `last_error` is a redacted, operator-facing sentence. It never carries a token:
-- the checker is unauthenticated and sends no credential, and the field is passed
-- through the same redaction the rest of the audit surface uses.
CREATE TABLE IF NOT EXISTS release_check_state (
    product TEXT PRIMARY KEY,
    repository TEXT NOT NULL DEFAULT '',
    running INTEGER NOT NULL DEFAULT 0 CHECK (running IN (0, 1)),
    last_attempt_at_ms INTEGER,
    last_success_at_ms INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    -- The latest tag the feed reported, so the page can name a newer version even
    -- when no release row survived a source change.
    latest_tag TEXT NOT NULL DEFAULT '',
    -- ETag of the last successful feed read. GitHub answers a conditional request
    -- with 304 and does not charge the rate limit for it. The validator is only
    -- used while its body representation is still in memory: a 304 after a restart
    -- would claim "nothing changed" about a body this process no longer holds, so
    -- the checker clears this column when it starts without bodies.
    etag TEXT NOT NULL DEFAULT '',
    updated_at_ms INTEGER NOT NULL
);
