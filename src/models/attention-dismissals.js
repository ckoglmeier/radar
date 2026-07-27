import { query } from '../db/index.js';

export async function listAttentionDismissals() {
  return query(`
    SELECT signal_key, signal_type, dismissed_at
      FROM attention_dismissals
     ORDER BY dismissed_at DESC, signal_key
  `);
}

export async function dismissAttentionItem({ signalKey, signalType }) {
  if (!signalKey || !signalType) throw new Error('signalKey and signalType are required');
  const rows = await query(`
    INSERT INTO attention_dismissals (signal_key, signal_type)
    VALUES ($1, $2)
    ON CONFLICT (signal_key) DO UPDATE SET
      signal_type = EXCLUDED.signal_type,
      dismissed_at = NOW()
    RETURNING signal_key, signal_type, dismissed_at
  `, [signalKey, signalType]);
  return rows[0];
}

export async function restoreAttentionItem(signalKey) {
  const rows = await query(`
    DELETE FROM attention_dismissals
     WHERE signal_key = $1
    RETURNING signal_key, signal_type, dismissed_at
  `, [signalKey]);
  return rows[0] || null;
}

export async function restoreAllAttentionItems() {
  return query(`
    DELETE FROM attention_dismissals
    RETURNING signal_key, signal_type, dismissed_at
  `);
}
