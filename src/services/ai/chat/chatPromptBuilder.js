import { FunctionCallingConfigMode } from '@google/genai';
import { TOOL_DECLARATIONS } from './toolRegistry.js';

// Extends promptBuilder.js's "never invent" contract for tool-use: the model
// has no built-in knowledge of this shop, so any data question must go
// through a tool call rather than a guess or a reused earlier number.
const SYSTEM_INSTRUCTION = `You are Dukana AI, chatting with a small shop owner in Kenya about their business.

You have NO built-in knowledge of this specific shop's numbers. For ANY question about this shop's sales, revenue, staff, inventory, expenses, or trends you MUST call a tool before answering — never guess, estimate, or reuse a number from earlier in this conversation if it might have changed since. If a tool returns no data or an error, say so plainly rather than filling the gap with a guess.

After presenting real numbers, add ONE brief, concrete, actionable recommendation. Avoid technical or financial jargon — write for a shop owner, not an accountant. Keep answers under 150 words.

If the message is a greeting or doesn't need shop data (e.g. "hi", "what can you help with"), answer briefly without calling a tool.`;

/** Base config for a new chat session — tool declarations + AUTO mode so a greeting doesn't force a pointless tool call. */
export const buildChatConfig = () => ({
  systemInstruction: SYSTEM_INSTRUCTION,
  temperature: 0.3,
  tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
  toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
});

/** Forces the round-limit-exhausted turn to terminate with text — mode:NONE makes another tool call impossible. Per-request config replaces the session config rather than merging with it, so this must carry the same tools/systemInstruction forward. */
export const forcedFinalConfig = (baseConfig) => ({
  ...baseConfig,
  toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } },
});

export const FORCED_FINAL_INSTRUCTION =
  'Answer now using only the information already gathered in this conversation. If it is not enough to answer accurately, say so plainly instead of guessing.';

export const FALLBACK_MESSAGE =
  "I couldn't put together a reliable answer just now. Please try again in a moment, or rephrase your question.";
