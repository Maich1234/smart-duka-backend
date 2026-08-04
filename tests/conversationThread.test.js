import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readThreadPage } from '../src/services/conversationThreadService.js';
import { parsePagination } from '../src/utils/pagination.js';

/**
 * Stands in for the Message model: holds a thread in conversation order and
 * honours sort direction, skip and limit the way Mongo does, so the service's
 * own ordering is what's under test rather than the fake's.
 */
const fakeMessageModel = (turnCount, { conversation = 'c1', shop = 's1' } = {}) => {
  const rows = Array.from({ length: turnCount }, (_, i) => ({
    _id: `m${i + 1}`,
    conversation,
    shop,
    kind: i % 2 === 0 ? 'user_message' : 'model_answer',
    role: i % 2 === 0 ? 'user' : 'model',
    turnIndex: i + 1,
    parts: [{ text: `turn ${i + 1}` }],
  }));
  // A tool call sits in the middle of the thread — it must never be returned,
  // and must not consume a slot in the page.
  rows.splice(3, 0, {
    _id: 'tool',
    conversation,
    shop,
    kind: 'tool_call',
    role: 'model',
    turnIndex: 0,
    parts: [{ text: 'internal' }],
  });

  const matching = (query) =>
    rows.filter(
      (r) =>
        r.conversation === query.conversation &&
        r.shop === query.shop &&
        query.kind.$in.includes(r.kind)
    );

  return {
    find(query) {
      let result = matching(query);
      const builder = {
        sort(spec) {
          const dir = spec.turnIndex;
          result = [...result].sort((a, b) => (a.turnIndex - b.turnIndex) * dir);
          return builder;
        },
        skip(n) {
          result = result.slice(n);
          return builder;
        },
        limit(n) {
          result = result.slice(0, n);
          return builder;
        },
        // `.select()` resolves the builder, as awaiting a Mongoose query does.
        select: async () => result,
      };
      return builder;
    },
    async countDocuments(query) {
      return matching(query).length;
    },
  };
};

const readPage = (model, query) => {
  const { skip, limit } = parsePagination(query, { defaultLimit: 50, maxLimit: 100 });
  return readThreadPage(model, { conversationId: 'c1', shopId: 's1', skip, limit });
};

const turnNumbers = (messages) => messages.map((m) => m.turnIndex);

test('a thread shorter than one page comes back whole, in order', async () => {
  const { messages, total } = await readPage(fakeMessageModel(6), {});
  assert.equal(total, 6);
  assert.deepEqual(turnNumbers(messages), [1, 2, 3, 4, 5, 6]);
});

test('page 1 is the newest turns, not the oldest', async () => {
  // The bug this pins: page 1 used to be turns 1-50 of 120, so a thread this
  // long opened on messages from weeks ago and new replies never appeared.
  const { messages, total } = await readPage(fakeMessageModel(120), {});
  assert.equal(total, 120);
  assert.equal(messages.length, 50);
  assert.equal(messages[0].turnIndex, 71);
  assert.equal(messages.at(-1).turnIndex, 120);
});

test('each page still reads oldest-to-newest within itself', async () => {
  const { messages } = await readPage(fakeMessageModel(120), {});
  const ordered = [...turnNumbers(messages)].sort((a, b) => a - b);
  assert.deepEqual(turnNumbers(messages), ordered);
});

test('later pages walk backwards through the thread without gaps or overlap', async () => {
  const model = fakeMessageModel(120);
  const [p1, p2, p3] = await Promise.all([
    readPage(model, { page: '1' }),
    readPage(model, { page: '2' }),
    readPage(model, { page: '3' }),
  ]);
  assert.equal(p2.messages[0].turnIndex, 21);
  assert.equal(p2.messages.at(-1).turnIndex, 70);
  // The oldest page is the short one — the remainder lands at the far end,
  // rather than page 1 being short the way start-of-thread paging left it.
  assert.deepEqual(turnNumbers(p3.messages), Array.from({ length: 20 }, (_, i) => i + 1));
  const seen = [...turnNumbers(p3.messages), ...turnNumbers(p2.messages), ...turnNumbers(p1.messages)];
  assert.deepEqual(seen, Array.from({ length: 120 }, (_, i) => i + 1));
});

test('a newly sent turn lands on page 1, where the client is looking', async () => {
  const before = await readPage(fakeMessageModel(100), {});
  const after = await readPage(fakeMessageModel(102), {});
  assert.equal(before.messages.at(-1).turnIndex, 100);
  assert.equal(after.messages.at(-1).turnIndex, 102);
});

test('tool rows are excluded and do not consume a slot in the page', async () => {
  const { messages, total } = await readPage(fakeMessageModel(4), {});
  assert.equal(total, 4);
  assert.deepEqual(turnNumbers(messages), [1, 2, 3, 4]);
  assert.ok(messages.every((m) => m._id !== 'tool'));
});
