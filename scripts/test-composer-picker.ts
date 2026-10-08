import assert from 'node:assert/strict';
import test from 'node:test';
import { nextPickerIndex, pickerRoom } from '../web/src/components/workspace/pickerNavigation.ts';

test('picker arrows wrap so every named choice is reachable', () => {
  assert.equal(nextPickerIndex('ArrowDown', 0, 8), 1);
  assert.equal(nextPickerIndex('ArrowDown', 7, 8), 0);
  assert.equal(nextPickerIndex('ArrowUp', 0, 8), 7);
  assert.equal(nextPickerIndex('ArrowUp', 7, 8), 6);
});

test('Home and End jump to the ends after filtering', () => {
  assert.equal(nextPickerIndex('Home', 5, 8), 0);
  assert.equal(nextPickerIndex('End', 0, 8), 7);
  assert.equal(nextPickerIndex('ArrowDown', 7, 2), 0);
  assert.equal(nextPickerIndex('ArrowUp', -1, 2), 1);
});

test('empty and singleton lists have no nonexistent focus target', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.equal(nextPickerIndex(key, 0, 0), null);
    assert.equal(nextPickerIndex(key, 0, 1), 0);
  }
});

test('confirmation, dismissal and ordinary typing are not navigation', () => {
  for (const key of ['Enter', ' ', 'Escape', 'Tab', 'a', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(nextPickerIndex(key, 1, 8), null);
  }
});

test('the surface opens above its trigger while there is comfortable room there', () => {
  assert.deepEqual(pickerRoom(900, 928, 1000), { placement: 'topRight', height: 882 });
  // Roomier below, but above is already enough: the surface stays where the eye expects it.
  assert.deepEqual(pickerRoom(320, 348, 1000), { placement: 'topRight', height: 302 });
});

test('a cramped trigger opens to the roomier side, capped to what that side holds', () => {
  assert.deepEqual(pickerRoom(200, 228, 1000), { placement: 'bottomRight', height: 754 });
  assert.deepEqual(pickerRoom(200, 228, 400), { placement: 'topRight', height: 182 });
  assert.equal(pickerRoom(4, 32, 40).height, 0);
});
