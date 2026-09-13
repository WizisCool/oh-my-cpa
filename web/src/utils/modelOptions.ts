/**
 * Options for one provider's model autocomplete.
 *
 * Grouped here rather than inline because both halves are behaviour the operator
 * notices when they are wrong, and both need pinning by a test: the list has to
 * narrow as they type, and a model that is already configured on this provider
 * must not be offered a second time.
 */

/**
 * filterModelOptions narrows the fetched model list to what the operator has
 * typed so far.
 *
 * The match is case-insensitive and on the model name itself. A provider's
 * catalog is long (hundreds of ids) and the operator already knows the prefix
 * they want, so the filter is a prefix-and-substring test rather than a ranked
 * search: `gpt` should show `gpt-5.4` without hiding `azure/gpt-5.4`, because on
 * a relay both are real ids and the operator is looking for one of them.
 *
 * An empty query returns everything, which is the state the control opens in and
 * the state it returns to when the field is cleared.
 */
export function filterModelOptions(
  models: readonly string[],
  query: string,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter((name) => name.toLowerCase().includes(needle));
}

/**
 * modelOptionsFor resolves the dropdown for one model row.
 *
 * `configuredElsewhere` holds the names already chosen on this provider's other
 * rows. Those are suppressed so the same model cannot be configured twice under
 * one provider - which the backend would accept and the gateway would then treat
 * as two entries competing for the same requests - while the row's *own* current
 * value is always kept, or editing an existing model would drop its own option
 * out from under the cursor.
 *
 * The typed text is applied last, so the list narrows as the operator types while
 * the already-configured suppression keeps working underneath it.
 */
export function modelOptionsFor(
  models: readonly string[],
  query: string,
  configuredElsewhere: ReadonlySet<string>,
): string[] {
  const own = query.trim();
  return filterModelOptions(models, query).filter(
    (name) => !configuredElsewhere.has(name) || name === own,
  );
}
