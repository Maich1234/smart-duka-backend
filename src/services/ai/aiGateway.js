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
  const rawText = await generateText(prompt);
  return formatResponse(rawText, snapshot);
};
