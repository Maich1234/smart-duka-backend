import { buildContext } from './contextBuilder.js';
import { buildPrompt } from './promptBuilder.js';
import { generateText } from './geminiClient.js';
import { formatResponse } from './responseFormatter.js';

/**
 * Controller-facing entry point — the only function that needs to change if
 * Gemini is ever swapped for another model, since everything upstream
 * (contextBuilder, promptBuilder) and downstream (responseFormatter) is
 * model-agnostic.
 */
export const explainSnapshot = async (snapshot) => {
  const context = buildContext(snapshot);
  const prompt = buildPrompt(context);
  let rawText;
  try {
    rawText = await generateText(prompt);
  } catch (err) {
    // The financial snapshot is already calculated. A provider outage must
    // not discard it or turn a working business report into a server error.
    console.warn('[AI] Explanation unavailable; returning calculated summary.', { status: err?.status ?? err?.code ?? 'unknown' });
    const fallback = formatResponse('', snapshot);
    return { ...fallback, summary: `AI is temporarily unavailable. ${fallback.summary}` };
  }
  return formatResponse(rawText, snapshot);
};
