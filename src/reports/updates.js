// Pure data fetchers for investor updates. Thin wrappers over the model.

import { listUpdates, getUpdateById, getUpdateTimeline } from '../models/updates.js';

export async function updatesList(opts = {}) {
  return listUpdates(opts);
}

export async function updateDetail(id) {
  return getUpdateById(id);
}

// Returns the chronological list plus QoQ deltas on numeric metrics.
export async function updateTimeline(companyName) {
  const rows = await getUpdateTimeline(companyName);
  if (rows.length === 0) return { company: companyName, rows: [] };

  const metrics = ['revenue_arr', 'burn_rate', 'runway_months', 'headcount', 'cash_on_hand'];
  const enriched = rows.map((r, i) => {
    const deltas = {};
    if (i > 0) {
      const prev = rows[i - 1];
      for (const m of metrics) {
        const a = prev[m] == null ? null : Number(prev[m]);
        const b = r[m] == null ? null : Number(r[m]);
        if (a == null || b == null || a === 0) deltas[m] = null;
        else deltas[m] = (b - a) / a;
      }
    }
    return { ...r, deltas };
  });

  return { company: companyName, rows: enriched };
}
