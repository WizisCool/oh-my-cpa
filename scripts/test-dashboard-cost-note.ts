import assert from 'node:assert/strict';
import { costNoteKey } from '../web/src/types/dashboard.ts';

/**
 * The cost tile's caption.
 *
 * The three states the server reports are not interchangeable, and the tile used to
 * collapse two of them: anything that was not a partial estimate was captioned
 * "pricing not configured", which is what a window whose requests all locked a price
 * would read as. The distinction is worth a suite because the caption is the only
 * thing that tells an operator whether the number beside it is the whole story.
 */
assert.equal(costNoteKey('estimated'), undefined, 'a complete total carries no caption');
assert.equal(costNoteKey('partial'), 'dash.cost_partial_note', 'a partial estimate says so');
assert.equal(costNoteKey('placeholder'), 'dash.cost_placeholder_note', 'an unpriced window says so');
assert.equal(costNoteKey('none'), 'dash.cost_placeholder_note', 'an unknown state is treated as unpriced, never as complete');

console.log('dashboard cost note: 4 cases passed');
