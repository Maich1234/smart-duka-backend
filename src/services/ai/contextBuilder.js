/**
 * Selects the subset of a BusinessSnapshot relevant to "explain today's
 * business" — the only question this plan wires up. No per-question
 * filtering yet since there's no chat UI, but kept as its own function so
 * that can be added later without touching promptBuilder, geminiClient, or
 * responseFormatter.
 */
export const buildContext = (snapshot) => ({
  business: snapshot.business,
  today: snapshot.today,
  trend: snapshot.trend,
  inventory: snapshot.inventory,
  health: snapshot.health,
  alerts: snapshot.alerts,
  insights: snapshot.insights,
});
