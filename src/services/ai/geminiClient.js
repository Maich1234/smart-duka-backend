import { GoogleGenAI } from '@google/genai';

// 'gemini-2.5-flash' 404s as "no longer available to new users" on freshly
// created API keys even though the discovery API still lists it — the
// -latest alias tracks whatever flash-tier model is actually available
// instead of a version string that can silently stop working.
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

let client = null;
const getClient = () => {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
};

/** Thin wrapper around the Gemini SDK — the only file in the backend that talks to Google's API. */
export const generateText = async (prompt) => {
  const ai = getClient();
  const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
  return response.text;
};

/** Opens a multi-turn, tool-calling-capable chat session — used by the chat orchestrator. */
export const createChatSession = ({ config, history } = {}) =>
  getClient().chats.create({ model: MODEL, config, history });
