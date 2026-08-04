import { GoogleGenAI } from '@google/genai';

// Model resolution is a fallback chain rather than a single string.
//
// A bare '-latest' alias is convenient but unpinned: Google can swap what it
// resolves to at any time, changing cost, latency, and tool-calling behaviour
// in production with no deploy on our side. A bare dated ID is the opposite
// problem — 'gemini-2.5-flash' 404s as "no longer available to new users" on
// freshly created API keys even though the discovery API still lists it, so a
// hard pin can brick AI for a new deployment.
//
// So: try the pinned version first, fall back to the alias if the pin isn't
// available to this key. Set GEMINI_MODEL to force one specific model and skip
// the chain entirely (the chain still applies if that model 404s).
const MODEL_CHAIN = [
  process.env.GEMINI_MODEL,
  process.env.GEMINI_MODEL_PINNED || 'gemini-2.5-flash',
  'gemini-flash-latest',
].filter(Boolean);

// Which entry in the chain this process settled on. Resolved lazily on the
// first 404 and reused thereafter, so we pay the fallback cost at most once
// per cold start rather than on every request.
let resolvedModel = null;

const isModelUnavailable = (err) => {
  const status = err?.status ?? err?.code;
  const message = String(err?.message ?? '');
  return status === 404 || /not found|not available|does not exist/i.test(message);
};

let client = null;
const getClient = () => {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
};

/**
 * Runs `attempt` against each candidate model until one doesn't 404, then
 * remembers the winner. Any non-availability error (quota, safety, network)
 * propagates immediately — only "this model isn't available to you" advances
 * the chain.
 *
 * Exported because the chat path needs the same fallback the insight path has.
 * `chats.create()` is synchronous and performs no network I/O, so a caller can
 * cheaply rebuild the session per candidate inside `attempt` rather than
 * paying for a separate probe request.
 */
export const withResolvedModel = async (attempt) => {
  if (resolvedModel) return attempt(resolvedModel);

  let lastError;
  for (const candidate of MODEL_CHAIN) {
    try {
      const result = await attempt(candidate);
      if (resolvedModel !== candidate) {
        resolvedModel = candidate;
        console.log(`[geminiClient] using model: ${candidate}`);
      }
      return result;
    } catch (err) {
      if (!isModelUnavailable(err)) throw err;
      console.warn(`[geminiClient] model unavailable, trying next: ${candidate}`);
      lastError = err;
    }
  }
  throw lastError ?? new Error('No Gemini model is available to this API key');
};

/** The model this process is actually calling — surfaced for logging and cost attribution. */
export const getActiveModel = () => resolvedModel ?? MODEL_CHAIN[0];

/** Thin wrapper around the Gemini SDK — the only file in the backend that talks to Google's API. */
export const generateText = async (prompt) => {
  const ai = getClient();
  const response = await withResolvedModel((model) =>
    ai.models.generateContent({ model, contents: prompt }));
  return response.text;
};

/**
 * Opens a multi-turn, tool-calling-capable chat session — used by the chat
 * orchestrator. Session creation is synchronous in the SDK and does no network
 * I/O, so it can't probe the chain itself; `model` lets the caller drive it
 * from inside withResolvedModel, which is how the chat path gets the same
 * fallback as generateText. Omitting `model` uses whichever candidate the
 * chain already settled on, and falls back to the preferred one on a cold
 * start — only safe when the caller handles a 404 itself.
 */
export const createChatSession = ({ model, config, history } = {}) =>
  getClient().chats.create({ model: model ?? getActiveModel(), config, history });
