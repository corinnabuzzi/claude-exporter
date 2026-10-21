import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary } from '@claude-exporter/core';
import { busy, current, initialState, reducer, visible, windowStart, type Action, type State } from '../../src/tui/state.ts';

const chats: ConversationSummary[] = [
  { uuid: 'a', name: 'Imparare C', project: { name: 'Programming' } },
  { uuid: 'b', name: 'Claude chat exporter', project: { name: 'Programming' } },
  { uuid: 'c', name: 'Patente B', summary: 'driving exam notes' },
  { uuid: 'd', name: 'OK Computer cover' }
];

const run = (...actions: Action[]): State =>
  actions.reduce(reducer, reducer(initialState, { type: 'load/done', chats }));

test('search matches every word across title, project and summary', () => {
  assert.deepEqual(visible({ chats, query: 'programming' }).map(c => c.uuid), ['a', 'b']);
  assert.deepEqual(visible({ chats, query: 'prog export' }).map(c => c.uuid), ['b']);
  assert.deepEqual(visible({ chats, query: 'DRIVING' }).map(c => c.uuid), ['c']);
  assert.deepEqual(visible({ chats, query: '  ' }).length, 4);
});

test('the cursor stays inside the list, also when a search shrinks it', () => {
  assert.equal(run({ type: 'cursor/move', delta: -5 }).cursor, 0);
  assert.equal(run({ type: 'cursor/move', delta: 99 }).cursor, 3);
  assert.equal(run({ type: 'cursor/edge', edge: 'last' }).cursor, 3);

  const searched = run({ type: 'cursor/edge', edge: 'last' }, { type: 'search/type', text: 'prog' });
  assert.equal(searched.cursor, 1);
  assert.equal(current(searched)?.uuid, 'b');
});

test('escape in search clears the query; enter keeps it', () => {
  const typed: Action[] = [{ type: 'search/start' }, { type: 'search/type', text: 'pat' }];
  assert.equal(run(...typed, { type: 'search/end', keep: true }).query, 'pat');
  assert.equal(run(...typed, { type: 'search/end', keep: false }).query, '');
  assert.equal(run(...typed, { type: 'search/backspace' }).query, 'pa');
});

test('select all toggles only what is visible', () => {
  const some = run({ type: 'search/type', text: 'programming' }, { type: 'select/all' });
  assert.deepEqual([...some.selected].sort(), ['a', 'b']);
  assert.equal(reducer(some, { type: 'select/all' }).selected.size, 0);
});

test('export takes the selection in list order, or the current chat if nothing is selected', () => {
  const selected = run(
    { type: 'cursor/move', delta: 2 },
    { type: 'select/toggle' },
    { type: 'cursor/edge', edge: 'first' },
    { type: 'select/toggle' },
    { type: 'export/queue' }
  );
  assert.deepEqual(selected.queue, ['a', 'c']);
  assert.equal(selected.selected.size, 0);

  const single = run({ type: 'cursor/move', delta: 1 }, { type: 'export/queue' });
  assert.deepEqual(single.queue, ['b']);
});

test('a chat already queued or running is not queued twice', () => {
  let state = run({ type: 'export/queue' });
  state = reducer(state, { type: 'job/start', id: 'a' });
  state = reducer(state, { type: 'export/queue' });
  assert.deepEqual(state.queue, []);
  assert.equal(state.running, 'a');
});

test('jobs move through queued → running → done or error', () => {
  let state = run({ type: 'select/all' }, { type: 'export/queue' });
  assert.equal(state.jobs.a?.status, 'queued');
  assert.ok(busy(state));

  state = reducer(state, { type: 'job/start', id: 'a' });
  state = reducer(state, { type: 'job/done', id: 'a', dir: '/x', files: 2, warnings: 0 });
  state = reducer(state, { type: 'job/start', id: 'b' });
  state = reducer(state, { type: 'job/error', id: 'b', message: 'HTTP 404' });

  assert.deepEqual(state.jobs.a, { status: 'done', dir: '/x', files: 2, warnings: 0 });
  assert.deepEqual(state.jobs.b, { status: 'error', message: 'HTTP 404' });
  assert.deepEqual(state.queue, ['c', 'd']);
});

test('reloading keeps the selection only for chats that still exist', () => {
  const state = run({ type: 'select/all' });
  const reloaded = reducer(state, { type: 'load/done', chats: chats.slice(0, 2) });
  assert.deepEqual([...reloaded.selected].sort(), ['a', 'b']);
});

test('the window keeps the cursor in view without blank space at the end', () => {
  assert.equal(windowStart(0, 5, 10), 0);
  assert.equal(windowStart(0, 100, 10), 0);
  assert.equal(windowStart(50, 100, 10), 45);
  assert.equal(windowStart(99, 100, 10), 90);
});
