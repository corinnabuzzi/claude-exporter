import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fg, shortDate, truncate } from '../src/format.ts';

const now = new Date(2026, 9, 21, 12, 0);

test('dates have a fixed width, with the year only for other years', () => {
  assert.equal(shortDate(new Date(2026, 9, 21, 9, 5).toISOString(), now), '21 Oct 09:05');
  assert.equal(shortDate(new Date(2026, 8, 1, 23, 59).toISOString(), now), '01 Sep 23:59');
  assert.equal(shortDate(new Date(2025, 11, 31, 10, 0).toISOString(), now), '31 Dec 2025');
  assert.equal(shortDate(undefined, now), '');
  assert.equal(shortDate('garbage', now), '');
});

test('truncate pads short text and marks cut text', () => {
  assert.equal(truncate('abc', 5), 'abc  ');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 0), '');
});

test('fg omits the color prop instead of passing undefined', () => {
  assert.deepEqual(fg('red'), { color: 'red' });
  assert.deepEqual(fg(false), {});
  assert.deepEqual(fg(undefined), {});
});
