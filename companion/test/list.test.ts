import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listConversations, type FetchPage } from '../src/list.ts';

const chats = Array.from({ length: 23 }, (_, i) => ({ uuid: `c${i}`, name: `chat ${i}` }));

function v2(cap = Infinity): { fetch: FetchPage; calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = [];
  return {
    calls,
    fetch: async (offset, limit) => {
      calls.push([offset, limit]);
      const data = chats.slice(offset, offset + Math.min(limit, cap));
      return { data, has_more: offset + data.length < chats.length };
    }
  };
}

test('pages through everything until has_more is false', async () => {
  const api = v2();
  const all = await listConversations(api.fetch, { pageSize: 10, delayMs: 0 });
  assert.equal(all.length, 23);
  assert.deepEqual(api.calls, [[0, 10], [10, 10], [20, 10]]);
});

test('stops at max and asks only for what is still needed', async () => {
  const api = v2();
  const some = await listConversations(api.fetch, { max: 15, pageSize: 10, delayMs: 0 });
  assert.deepEqual(some.map(c => c.uuid), chats.slice(0, 15).map(c => c.uuid));
  assert.deepEqual(api.calls, [[0, 10], [10, 5]]);
});

test('a server that caps page size does not end the list early', async () => {
  const api = v2(4);
  const all = await listConversations(api.fetch, { pageSize: 10, delayMs: 0 });
  assert.equal(all.length, 23);
  assert.equal(api.calls[1]?.[0], 4);
});

test('an endpoint that ignores offset cannot loop forever', async () => {
  let calls = 0;
  const all = await listConversations(
    async () => {
      calls++;
      return { data: chats.slice(0, 5), has_more: true };
    },
    { pageSize: 5, delayMs: 0 }
  );
  assert.equal(all.length, 5);
  assert.equal(calls, 2);
});

test('the old array format works too, ending on a short page', async () => {
  const all = await listConversations(async (offset, limit) => chats.slice(offset, offset + limit), {
    pageSize: 10,
    delayMs: 0
  });
  assert.equal(all.length, 23);
});

test('duplicates across pages and items without a uuid are dropped', async () => {
  const pages = [
    { data: [{ uuid: 'a' }, { uuid: 'b' }], has_more: true },
    { data: [{ uuid: 'b' }, { name: 'no id' }, { uuid: 'c' }], has_more: false }
  ];
  let i = 0;
  const all = await listConversations(async () => pages[i++], { pageSize: 2, delayMs: 0 });
  assert.deepEqual(all.map(c => c.uuid), ['a', 'b', 'c']);
});
