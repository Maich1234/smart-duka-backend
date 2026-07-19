import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateChatLimits } from '../src/services/chatLimitsService.js';
import { hasFeature } from '../src/middlewares/requireFeature.js';

// ─── evaluateChatLimits ────────────────────────────────────────────────────

test('no chatLimits on the plan → never blocks', () => {
  assert.equal(evaluateChatLimits({ limits: null, isNewConversation: true }), null);
});

test('all limits null (unlimited) → never blocks, regardless of usage', () => {
  const limits = { maxConversations: null, maxNewConversationsPerDay: null, maxMessagesPerDay: null };
  const blocked = evaluateChatLimits({
    limits,
    isNewConversation: true,
    activeConversationCount: 999,
    newConversationsToday: 999,
    messagesToday: 999,
  });
  assert.equal(blocked, null);
});

test('maxConversations blocks a new conversation at the cap', () => {
  const limits = { maxConversations: 5, maxNewConversationsPerDay: null, maxMessagesPerDay: null };
  const blocked = evaluateChatLimits({ limits, isNewConversation: true, activeConversationCount: 5 });
  assert.equal(blocked.code, 'CHAT_CONVERSATION_LIMIT');
});

test('maxConversations does not block one under the cap', () => {
  const limits = { maxConversations: 5, maxNewConversationsPerDay: null, maxMessagesPerDay: null };
  const blocked = evaluateChatLimits({ limits, isNewConversation: true, activeConversationCount: 4 });
  assert.equal(blocked, null);
});

test('maxConversations does not apply to an existing conversation', () => {
  const limits = { maxConversations: 5, maxNewConversationsPerDay: null, maxMessagesPerDay: null };
  const blocked = evaluateChatLimits({ limits, isNewConversation: false, activeConversationCount: 999 });
  assert.equal(blocked, null);
});

test('maxNewConversationsPerDay blocks starting a new thread at the daily cap', () => {
  const limits = { maxConversations: null, maxNewConversationsPerDay: 1, maxMessagesPerDay: null };
  const blocked = evaluateChatLimits({ limits, isNewConversation: true, newConversationsToday: 1 });
  assert.equal(blocked.code, 'CHAT_NEW_CONVERSATION_DAILY_LIMIT');
});

test('maxNewConversationsPerDay does not block sending in an existing conversation', () => {
  const limits = { maxConversations: null, maxNewConversationsPerDay: 1, maxMessagesPerDay: null };
  const blocked = evaluateChatLimits({ limits, isNewConversation: false, newConversationsToday: 999 });
  assert.equal(blocked, null);
});

test('maxMessagesPerDay blocks any send (new or existing conversation) at the daily cap', () => {
  const limits = { maxConversations: null, maxNewConversationsPerDay: null, maxMessagesPerDay: 3 };
  assert.equal(evaluateChatLimits({ limits, isNewConversation: false, messagesToday: 3 }).code, 'CHAT_MESSAGE_DAILY_LIMIT');
  assert.equal(evaluateChatLimits({ limits, isNewConversation: true, messagesToday: 3 }).code, 'CHAT_MESSAGE_DAILY_LIMIT');
});

test('maxMessagesPerDay does not block one message under the cap', () => {
  const limits = { maxConversations: null, maxNewConversationsPerDay: null, maxMessagesPerDay: 3 };
  const blocked = evaluateChatLimits({ limits, isNewConversation: false, messagesToday: 2 });
  assert.equal(blocked, null);
});

test('conversation cap is checked before the daily message cap on a new conversation', () => {
  const limits = { maxConversations: 1, maxNewConversationsPerDay: null, maxMessagesPerDay: 100 };
  const blocked = evaluateChatLimits({ limits, isNewConversation: true, activeConversationCount: 1, messagesToday: 0 });
  assert.equal(blocked.code, 'CHAT_CONVERSATION_LIMIT');
});

// ─── hasFeature ─────────────────────────────────────────────────────────────

test('hasFeature is true when the plan lists the flag', () => {
  assert.ok(hasFeature({ features: ['reports', 'advanced_analytics'] }, 'reports'));
});

test('hasFeature is false when the plan does not list the flag', () => {
  assert.ok(!hasFeature({ features: ['reports'] }, 'advanced_analytics'));
});

test('hasFeature is false for a plan with no features array, or no plan at all', () => {
  assert.ok(!hasFeature({}, 'reports'));
  assert.ok(!hasFeature(undefined, 'reports'));
  assert.ok(!hasFeature(null, 'reports'));
});
