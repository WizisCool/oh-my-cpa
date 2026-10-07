import assert from 'node:assert/strict';
import {
  USAGE_REGEX_MAX_LENGTH,
  formatUsageRegex,
  parseUsageRegex,
  usageEventParams,
  usageRegexProblem,
} from '../web/src/types/usageEvents.ts';
import { EMPTY_FILTER_DRAFT, draftFromView, draftToView, validateFilterDraft } from '../web/src/types/usageEventFilters.ts';
import { activeFilterCount, readEventQuery, readFilterParams } from '../web/src/types/usageEventQuery.ts';

// Everything after the first colon is the pattern, colons included.
assert.deepEqual(parseUsageRegex('model:^claude-.*:beta$'), { field: 'model', pattern: '^claude-.*:beta$' });
assert.equal(formatUsageRegex('ua', '(?i)codex'), 'ua:(?i)codex');
assert.equal(formatUsageRegex('ua', ''), '', 'a field without a pattern is no filter');
for (const value of [undefined, '', 'model', 'model:', ':x', 'client_ip:x', 'source:x']) {
  assert.equal(parseUsageRegex(value), undefined, `${value} is not a pattern filter`);
}

// Only what is certain about RE2 is refused before the server sees it.
assert.equal(usageRegexProblem('^claude-.*-(opus|sonnet)'), undefined);
assert.equal(usageRegexProblem('(?i)codex'), undefined, 'an inline flag is RE2, whatever this engine thinks of it');
assert.equal(usageRegexProblem('a'.repeat(USAGE_REGEX_MAX_LENGTH)), undefined);
assert.equal(usageRegexProblem('a'.repeat(USAGE_REGEX_MAX_LENGTH + 1)), 'events.regex_too_long');
for (const pattern of ['foo(?=bar)', 'foo(?!bar)', '(?<=foo)bar', '(?<!foo)bar', '(a)\\1']) {
  assert.equal(usageRegexProblem(pattern), 'events.regex_unsupported', pattern);
}
assert.equal(usageRegexProblem('(?P<name>a)'), undefined, 'a named group is not a lookbehind');

// One URL parameter in, the same value out to the API, and one filter counted.
const url = new URLSearchParams({ preset: '24h', regex: 'model:^gpt-(4|5)' });
const query = readEventQuery(url);
assert.equal(query.text?.regex, 'model:^gpt-(4|5)');
assert.equal(new URLSearchParams(usageEventParams(query)).get('regex'), 'model:^gpt-(4|5)');
const committed = readFilterParams(url);
assert.deepEqual(committed.regex, ['model:^gpt-(4|5)']);
assert.equal(activeFilterCount(committed), 1);

// The drawer's draft carries it whole, and clearing the pattern clears the filter.
const draft = draftFromView({ result: 'all', params: committed });
assert.equal(draft.text.regex, 'model:^gpt-(4|5)');
assert.deepEqual(draftToView(draft).params.regex, ['model:^gpt-(4|5)']);
assert.equal(draftToView({ ...draft, text: { regex: formatUsageRegex('model', '') } }).params.regex, undefined);
assert.deepEqual(validateFilterDraft({ ...EMPTY_FILTER_DRAFT, text: { regex: 'model:a(?=b)' } }), { regex: 'events.regex_unsupported' });
assert.deepEqual(validateFilterDraft(draft), {});

console.log('PASS usage regex filter: field:pattern parsing, RE2-certain refusals, URL and draft round trips');
