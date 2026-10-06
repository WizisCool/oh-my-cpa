# ADR 0063: A time-of-day tier is read on its own billing clock

- Status: Accepted
- Date: 2026-10-06
- Extends: ADR 0030, whose tier rule is unchanged apart from the clock a window is
  read on.

## Context

ADR 0030 gave a price time-of-day tiers as a half-open UTC window, because that is
how OpenRouter publishes them. The editor let an operator type the window in the OMC
Time Zone and converted it to UTC at the zone's offset on the day of the edit.

Vendors do not bill on one clock. DeepSeek publishes off-peak hours in Beijing time,
others in US Pacific or Eastern time, and one deployment routes to several of them.
Neither UTC nor the OMC Time Zone can be right for all of them at once: the OMC Time
Zone is a display preference for the whole console (ADR 0039), and a window converted
to UTC once is an hour wrong for half the year wherever the vendor observes daylight
saving.

## Decision

1. **A tier names its clock.** `PriceTier` gains `time_zone`, an IANA name validated
   by `timezone.Load`. A window is tested against the request's own instant placed on
   that zone's wall clock; an absent zone is UTC. The zone belongs to the tier, so one
   price can carry windows on different clocks, and it is independent of the OMC Time
   Zone.
2. **The stored spelling of existing tiers does not change.** The window fields keep
   their `utc_start` / `utc_end` names and `time_zone` is omitted when empty. The
   version trigger compares the stored tier text, so renaming the fields would mint a
   price version for every tiered price at the next sync. The editor writes a UTC
   window without a zone for the same reason.
3. **Hours are stored as published, never converted.** The editor, the HTTP API and
   the agent capabilities all take the vendor's hours with the vendor's zone.
4. **A zone that cannot be read never applies.** Validation refuses it on write; if a
   stored one ever fails to load, the tier is skipped rather than read as UTC.
5. **The lock is unchanged.** `pricing.Quote` remains the single implementation, the
   console mirrors it in `web/src/types/pricingDisplay.ts`, and a recorded request
   keeps the tier index and price version it locked (ADR 0003).

## Consequences

- `utc_start` and `utc_end` are misnomers on a tier that names a zone. The field
  descriptions the agent sees and the type comments say so; a rename was judged not
  worth a version per tiered price and a second wire shape to accept forever.
- The Go binary already embeds the zone database (`time/tzdata`), so the rule does not
  depend on the host. Loaded zones are cached, since a tier is selected for every
  ingested request.
- Around a daylight-saving change a wall-clock window is an hour shorter or longer in
  absolute time, which is what the vendor's own meter does.
- The browser reads zones through `Intl`. A zone the server accepts but an old browser
  does not know makes the editor's preview skip that tier; the server's amount is
  authoritative either way.

## Alternatives rejected

- **A deployment-wide billing zone.** One more global setting that is still wrong for
  the second vendor.
- **A fixed UTC offset per tier.** Simple, but wrong across daylight saving, and
  `Etc/GMT-8` already expresses a fixed offset where one is wanted.
- **Converting to UTC in the editor.** The behaviour being replaced.
