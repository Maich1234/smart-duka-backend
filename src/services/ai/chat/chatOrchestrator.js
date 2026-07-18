import Conversation from '../../../models/Conversation.js';
import Message from '../../../models/Message.js';
import { createChatSession } from '../geminiClient.js';
import { buildChatConfig, forcedFinalConfig, FORCED_FINAL_INSTRUCTION, FALLBACK_MESSAGE } from './chatPromptBuilder.js';
import { toolExecutors } from './toolExecutors.js';

// Worst case: MAX_TOOL_ROUNDS rounds + 1 forced-final call = 5 Gemini calls
// for one chat turn. Overridable in dev to exercise the round-limit guard
// (see the plan's verification step 4) without waiting for a real multi-tool
// question.
const MAX_TOOL_ROUNDS = Number(process.env.AI_CHAT_MAX_TOOL_ROUNDS) || 4;

// Only whole user_message/model_answer turns are ever replayed into a new
// session — tool_call/tool_result turns are dropped. A replayed tool result
// baked into history would let the model answer a later "how are things
// now" question from stale cached data instead of calling the tool again,
// and it sidesteps Gemini rejecting a functionCall/functionResponse pair
// split by truncation.
const HISTORY_PAIR_LIMIT = 6;

const toGeminiContent = (doc) => ({ role: doc.role, parts: doc.parts });

const loadReplayableHistory = async (conversationId, shopId) => {
  if (!conversationId) return [];
  const docs = await Message.find({
    conversation: conversationId,
    shop: shopId,
    kind: { $in: ['user_message', 'model_answer'] },
  })
    .sort({ turnIndex: -1 })
    .limit(HISTORY_PAIR_LIMIT * 2)
    .lean();
  return docs.reverse().map(toGeminiContent);
};

const classifyKind = (content) => {
  if (content.parts?.some((p) => p.functionCall)) return 'tool_call';
  if (content.parts?.some((p) => p.functionResponse)) return 'tool_result';
  return content.role === 'user' ? 'user_message' : 'model_answer';
};

/** shopId is always the orchestrator-injected first argument — call.args (Gemini's own arguments) never carry tenant scoping. */
const executeToolCall = async (shopId, call) => {
  const executor = toolExecutors[call.name];
  if (!executor) return { id: call.id, name: call.name, response: { error: `Unknown tool: ${call.name}` } };
  try {
    const output = await executor(shopId, call.args ?? {});
    return { id: call.id, name: call.name, response: { output } };
  } catch (err) {
    return { id: call.id, name: call.name, response: { error: err.message } };
  }
};

/**
 * Persists every new Content turn from this exchange (full audit trail —
 * see the plan's verification checks) and bumps the conversation's list
 * metadata. If the model never produced usable text (round budget
 * exhausted, forced-final also empty), the persisted model_answer's text is
 * overwritten with `finalText` so the stored transcript never diverges from
 * what the client was shown.
 */
const persistTurn = async ({ conversation, shopId, priorHistoryLength, chat, toolsUsed, userText, finalText }) => {
  const fullHistory = chat.getHistory(true);
  const newTurns = fullHistory.slice(priorHistoryLength);
  let turnIndex = conversation.nextTurnIndex;

  const docs = newTurns.map((content) => ({
    conversation: conversation._id,
    shop: shopId,
    role: content.role,
    kind: classifyKind(content),
    parts: content.parts ?? [],
    turnIndex: turnIndex++,
  }));

  const lastDoc = docs[docs.length - 1];
  if (lastDoc?.kind === 'model_answer') {
    lastDoc.parts = [{ text: finalText }];
    if (toolsUsed.length) lastDoc.toolsUsed = toolsUsed;
  }

  if (docs.length) await Message.insertMany(docs);

  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $set: { lastMessageAt: new Date(), ...(conversation.title ? {} : { title: userText.slice(0, 80) }) },
      $inc: { messageCount: 1, nextTurnIndex: docs.length },
    }
  );
};

/**
 * Runs one full chat exchange: opens a session seeded with this
 * conversation's replayable history, sends the user's message, executes any
 * tool calls Gemini requests (up to MAX_TOOL_ROUNDS rounds), forces a final
 * text answer if the round budget is exhausted, persists the turn, and
 * returns the reply. `conversation` must already be scoped/owned by the
 * caller (aiChatController resolves it against req.user.shop._id — this
 * function trusts the id it's handed).
 */
export const runChatTurn = async ({ shopId, conversation, userText }) => {
  try {
    const baseConfig = buildChatConfig();
    const priorHistory = await loadReplayableHistory(conversation._id, shopId);
    const chat = createChatSession({ config: baseConfig, history: priorHistory });

    const toolsUsed = [];
    let response = await chat.sendMessage({ message: userText });
    let round = 0;

    while (response.functionCalls?.length && round < MAX_TOOL_ROUNDS) {
      round += 1;
      const calls = response.functionCalls;
      toolsUsed.push(...calls.map((c) => c.name));
      const results = await Promise.all(calls.map((call) => executeToolCall(shopId, call)));
      response = await chat.sendMessage({ message: results.map((r) => ({ functionResponse: r })) });
    }

    if (response.functionCalls?.length) {
      response = await chat.sendMessage({
        message: FORCED_FINAL_INSTRUCTION,
        config: forcedFinalConfig(baseConfig),
      });
    }

    const text = response.text?.trim();
    const finalText = text || FALLBACK_MESSAGE;
    const source = text ? 'gemini' : 'fallback';
    const dedupedTools = [...new Set(toolsUsed)];

    await persistTurn({
      conversation,
      shopId,
      priorHistoryLength: priorHistory.length,
      chat,
      toolsUsed: dedupedTools,
      userText,
      finalText,
    });

    return { conversationId: String(conversation._id), text: finalText, toolsUsed: dedupedTools, source };
  } catch (err) {
    console.error('[AI Chat] runChatTurn error:', err.message);
    return { conversationId: String(conversation._id), text: FALLBACK_MESSAGE, toolsUsed: [], source: 'error' };
  }
};
