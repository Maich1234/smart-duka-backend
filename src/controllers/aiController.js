import DailySummary from '../models/DailySummary.js';
import { buildBusinessSnapshot } from '../services/intelligence/businessSnapshotBuilder.js';
import { explainSnapshot } from '../services/ai/aiGateway.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

/** Cheap digest of the numbers Gemini's explanation actually depends on — not a timestamp, since DailySummary.generatedAt bumps on every unrelated read. */
const fingerprintOf = (snapshot) =>
  `${snapshot.today.revenue}:${snapshot.today.transactions}:${snapshot.today.expenses}:${snapshot.today.profit}`;

/**
 * GET /ai/insight — the BusinessSnapshot plus a Gemini-generated explanation
 * of today's business. The Gemini call itself is cached per (shop, day,
 * fingerprint) on the DailySummary doc so repeat requests on an unchanged
 * day never re-hit the API.
 */
export const getBusinessInsight = async (req, res) => {
  try {
    const shopId = req.user.shop._id;
    const date = todayStr();

    const snapshot = await buildBusinessSnapshot(shopId);
    const fingerprint = fingerprintOf(snapshot);

    const existing = await DailySummary.findOne({ shop: shopId, date }).select('aiInsight');
    const cached = existing?.aiInsight;
    const isFresh = cached?.fingerprint === fingerprint;

    const insight = isFresh
      ? { summary: cached.summary, priority: cached.priority, actions: cached.actions, health: cached.health, source: 'cache' }
      : await explainSnapshot(snapshot);

    if (!isFresh) {
      await DailySummary.updateOne(
        { shop: shopId, date },
        {
          $set: {
            aiInsight: {
              summary: insight.summary,
              priority: insight.priority,
              actions: insight.actions,
              health: insight.health,
              fingerprint,
              generatedAt: new Date(),
            },
          },
        }
      );
    }

    res.json({ success: true, data: { snapshot, insight } });
  } catch (err) {
    console.error('[AI] getBusinessInsight error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to generate business insight.' });
  }
};
