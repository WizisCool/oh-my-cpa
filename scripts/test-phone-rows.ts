/**
 * Behavioural tests for the phone row's field derivation.
 *
 * The property this suite exists for is not "the fields are right" but "a field cannot be
 * silently lost". A list renders as a table on a wide viewport and as labelled rows on a phone,
 * and the two are derived from one column array precisely so that a column added to the table
 * reaches both. The failure mode being ruled out is a field that is visible on a desktop and
 * absent on a phone, with nothing in the app saying so - which is what a hand-written row would
 * produce the first time a column was added and forgotten.
 *
 * These import the module directly rather than restating its loop, so the assertions cannot
 * drift from the implementation.
 */
import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { phoneRowFields, type PhoneRowSource } from '../web/src/components/common/phoneRowFields.ts';

interface Record_ {
  id: string;
  name: string;
  secret: string;
  nested?: { count: number };
}

const record: Record_ = { id: 'r1', name: 'Primary', secret: 'sk-abcd', nested: { count: 7 } };

// ---- labels and values come from the columns themselves ----
{
  const columns: PhoneRowSource<Record_>[] = [
    { title: 'Name', key: 'name', render: (_value, row) => row.name },
    { title: 'Secret', key: 'secret', render: (_value, row) => row.secret },
  ];
  const fields = phoneRowFields(columns, record, { index: 0 });

  assert.deepEqual(fields.map((field) => field.key), ['name', 'secret']);
  assert.deepEqual(fields.map((field) => field.label), ['Name', 'Secret']);
  assert.deepEqual(fields.map((field) => field.value), ['Primary', 'sk-abcd']);
}

// ---- the table's own order is the row's order ----
{
  const columns: PhoneRowSource<Record_>[] = [
    { title: 'Nested', key: 'nested', render: (_value, row) => row.nested?.count },
    { title: 'Name', key: 'name', render: (_value, row) => row.name },
  ];
  const fields = phoneRowFields(columns, record, { index: 0 });
  assert.deepEqual(fields.map((field) => field.key), ['nested', 'name']);
}

// ---- `skip` removes a column from the fields without removing it from the table ----
{
  const columns: PhoneRowSource<Record_>[] = [
    { title: 'Name', key: 'name', render: (_value, row) => row.name },
    { title: 'Secret', key: 'secret', render: (_value, row) => row.secret },
    { title: 'Actions', key: 'actions', render: () => 'controls' },
  ];
  const fields = phoneRowFields(columns, record, { skip: ['name', 'actions'], index: 0 });
  assert.deepEqual(fields.map((field) => field.key), ['secret']);
}

// ---- a column addressed by dataIndex is a field too ----
//
// A column without a `render` is how antd is told to print the value it found, and a list that
// simply names fields this way must not lose them.
{
  const columns: PhoneRowSource<Record_>[] = [
    { title: 'Name', dataIndex: 'name' },
    { title: 'Count', dataIndex: ['nested', 'count'] },
  ];
  const fields = phoneRowFields(columns, record, { index: 0 });
  assert.deepEqual(fields.map((field) => field.value), ['Primary', 7]);
}

// ---- two nested paths under one parent are two fields, not one ----
//
// The identity is what names the field, keys it in React and finds it again in `renderedCell`, so
// two paths sharing a first segment must not share an identity: the second column would be
// unreachable and the first would silently stand in for it.
{
  const nested: Record_ = { id: 'r1', name: 'Primary', secret: 'sk-abcd', counts: { prompt: 3, completion: 9 } } as Record_;
  const columns: PhoneRowSource<Record_>[] = [
    { title: 'Prompt', dataIndex: ['counts', 'prompt'] },
    { title: 'Completion', dataIndex: ['counts', 'completion'] },
  ];
  const fields = phoneRowFields(columns, nested, { index: 0 });

  assert.deepEqual(fields.map((field) => field.key), ['counts.prompt', 'counts.completion']);
  assert.deepEqual(fields.map((field) => field.value), [3, 9]);
}

// ---- the render function is called the way antd calls it ----
//
// A cell and a field must format a value identically, which holds only if the renderer receives
// the same first argument antd passes: the value at `dataIndex`, not the record.
{
  const calls: unknown[][] = [];
  const columns: PhoneRowSource<Record_>[] = [
    {
      title: 'Count',
      key: 'count',
      dataIndex: 'nested',
      render: (value, row, index) => {
        calls.push([value, row, index]);
        return 'rendered';
      },
    },
  ];
  const fields = phoneRowFields(columns, record, { index: 4 });

  assert.deepEqual(calls, [[{ count: 7 }, record, 4]]);
  assert.equal(fields[0].value, 'rendered');
}

// ---- a column that cannot be addressed is not a field ----
//
// Without a `key` or a `dataIndex` there is nothing to name the field or to look its value up
// by, so it is skipped - and it cannot be reached by `skip` either, which is why the rule lives
// here rather than at the call sites.
{
  const columns: PhoneRowSource<Record_>[] = [{ title: 'Unaddressable', render: () => 'x' }];
  assert.deepEqual(phoneRowFields(columns, record, { index: 0 }), []);
}

// ---- a column whose cell prints nothing is not a field ----
//
// The table shows an empty cell; a labelled empty row would be noise around the headline. This
// is how a record whose optional columns are all empty ends up with no fields at all, which the
// row component treats as normal rather than as an error.
{
  const columns: PhoneRowSource<Record_>[] = [
    { title: 'Name', key: 'name', render: (_value, row) => row.name },
    { title: 'Absent', key: 'absent', render: () => null },
    { title: 'Undefined', key: 'undefined', render: () => undefined },
  ];
  const fields = phoneRowFields(columns, record, { index: 0 });
  assert.deepEqual(fields.map((field) => field.key), ['name']);
}

// ---- a spanning cell is unwrapped, a React element is not ----
//
// antd's renderer may return `{ children, props }` to control a cell's own colSpan. React would
// receive an object if that envelope were passed through; and because a rendered element is also
// an object with `props`, the unwrapping has to key off `$$typeof` rather than "has props".
{
  const envelope: PhoneRowSource<Record_>[] = [
    { title: 'Spanning', key: 'spanning', render: () => ({ children: 'spanned', props: { colSpan: 2 } }) },
  ];
  assert.deepEqual(phoneRowFields(envelope, record, { index: 0 }).map((field) => field.value), ['spanned']);

  const element = { $$typeof: Symbol.for('react.element'), type: 'span', key: null, props: { children: 'kept' }, ref: null };
  const rendered: PhoneRowSource<Record_>[] = [
    { title: 'Element', key: 'element', render: () => element as unknown as ReactNode },
  ];
  assert.equal(phoneRowFields(rendered, record, { index: 0 })[0].value, element);
}

// ---- an array of nodes is a node ----
//
// A row of tags or a mapped list is one of the commonest things a renderer returns, and it is an
// object without `$$typeof` - so the envelope test used to turn it into `undefined`, leaving the
// field visible in the table and absent from the phone row.
{
  const first = { $$typeof: Symbol.for('react.element'), type: 'span', key: null, props: { children: 'a' }, ref: null };
  const second = { $$typeof: Symbol.for('react.element'), type: 'span', key: null, props: { children: 'b' }, ref: null };
  const nodes = [first, second];
  const columns: PhoneRowSource<Record_>[] = [
    { title: 'Tags', key: 'tags', render: () => nodes as unknown as ReactNode },
  ];
  const fields = phoneRowFields(columns, record, { index: 0 });
  assert.equal(fields.length, 1, 'an array of nodes is still a field');
  assert.equal(fields[0].value, nodes, 'and it is passed through as the array React expects');
}

// ---- a function title becomes a label rather than dropping its column ----
{
  const columns: PhoneRowSource<Record_>[] = [
    { title: () => 'Computed', key: 'computed', render: (_value, row) => row.name },
  ];
  const fields = phoneRowFields(columns, record, { index: 0 });
  assert.deepEqual(fields.map((field) => field.label), ['Computed']);
}

// ---- a title-less column is not a field ----
//
// A grouping column has children and a divider has neither title nor value; neither can label
// anything, so neither becomes a labelled blank.
{
  const columns: PhoneRowSource<Record_>[] = [
    { key: 'grouped', render: () => 'x' },
    { key: 'titled', title: '', render: () => 'y' },
  ];
  const fields = phoneRowFields(columns, record, { index: 0 });
  assert.deepEqual(fields.map((field) => field.key), ['titled'], 'an empty title still names a field');
}

// ---- an empty column list yields nothing rather than throwing ----
{
  assert.deepEqual(phoneRowFields([], record, { index: 0 }), []);
}

console.log('phone row fields: all cases passed');
