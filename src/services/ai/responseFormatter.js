const VALID_PRIORITIES = ['low', 'medium', 'high'];

const stripCodeFence = (text) => text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

const isValidShape = (obj) =>
  !!obj
  && typeof obj.summary === 'string'
  && VALID_PRIORITIES.includes(obj.priority)
  && Array.isArray(obj.actions)
  && obj.actions.every((a) => typeof a === 'string')
  && typeof obj.health === 'number';

/** Deterministic fallback built from the snapshot's own insights/health — used whenever Gemini's output can't be trusted. */
const fallbackFrom = (snapshot) => ({
  summary: snapshot.insights[0] ?? 'No notable changes today.',
  priority: snapshot.alerts.some((a) => a.severity === 'critical') ? 'high' : snapshot.alerts.length ? 'medium' : 'low',
  actions: snapshot.insights.slice(0, 3),
  health: snapshot.health.score,
});

/**
 * Validates Gemini's JSON against the agreed `{summary, priority, actions, health}`
 * shape. On any parse or shape failure, falls back to the deterministic
 * snapshot data instead — a raw or malformed AI response is never surfaced.
 */
export const formatResponse = (rawText, snapshot) => {
  try {
    const parsed = JSON.parse(stripCodeFence(rawText));
    if (!isValidShape(parsed)) throw new Error('Unexpected response shape');
    return { ...parsed, source: 'gemini' };
  } catch {
    return { ...fallbackFrom(snapshot), source: 'fallback' };
  }
};
