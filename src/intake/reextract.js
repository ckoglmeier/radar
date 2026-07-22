import { query } from '../db/index.js';
import { classifyArtifact } from './index.js';

const FILLABLE_FIELDS = [
  'lead',
  'co_investors',
  'market',
  'round',
  'allocation_usd',
  'min_investment_usd',
  'carry_pct',
  'valuation_text',
  'valuation_usd',
];

export async function reextractIntake({ dryRun = false, inviteIds = null } = {}) {
  const rows = await query(`
    SELECT
      p.id, p.company_name,
      p.lead, p.co_investors, p.market, p.round,
      p.allocation_usd, p.min_investment_usd, p.carry_pct,
      p.valuation_text, p.valuation_usd,
      d.id AS document_id, d.filename, d.mime, d.content
    FROM pipeline_invites p
    JOIN documents d
      ON d.entity_type = 'pipeline_invite' AND d.entity_id = p.id
    WHERE p.source = 'intake'
      AND (
        p.lead IS NULL OR p.co_investors IS NULL OR p.market IS NULL OR
        p.round IS NULL OR p.allocation_usd IS NULL OR
        p.min_investment_usd IS NULL OR p.carry_pct IS NULL OR
        p.valuation_text IS NULL OR p.valuation_usd IS NULL
      )
    ORDER BY p.id, d.created_at DESC, d.id DESC
  `);

  const selectedIds = inviteIds ? new Set(inviteIds.map(Number)) : null;
  const groups = new Map();
  for (const row of rows) {
    if (selectedIds && !selectedIds.has(Number(row.id))) continue;
    if (!groups.has(row.id)) {
      groups.set(row.id, {
        id: row.id,
        company_name: row.company_name,
        current: Object.fromEntries(FILLABLE_FIELDS.map(field => [field, row[field]])),
        documents: [],
      });
    }
    groups.get(row.id).documents.push(row);
  }

  const results = [];
  for (const group of groups.values()) {
    const proposed = {};
    for (const document of group.documents) {
      const classified = await classifyArtifact(
        Buffer.isBuffer(document.content) ? document.content : Buffer.from(document.content),
        document.filename,
        document.mime
      );
      if (classified.type !== 'pipeline_invite' || !classified.parsed) continue;
      for (const field of FILLABLE_FIELDS) {
        if (group.current[field] !== null || proposed[field] !== undefined) continue;
        const value = classified.parsed[field];
        if (value !== null && value !== undefined && value !== '') proposed[field] = value;
      }
    }

    const changedFields = Object.keys(proposed);
    if (changedFields.length === 0) continue;

    if (!dryRun) {
      await query(`
        UPDATE pipeline_invites SET
          lead = COALESCE(lead, $1),
          co_investors = COALESCE(co_investors, $2),
          market = COALESCE(market, $3),
          round = COALESCE(round, $4),
          allocation_usd = COALESCE(allocation_usd, $5),
          min_investment_usd = COALESCE(min_investment_usd, $6),
          carry_pct = COALESCE(carry_pct, $7),
          valuation_text = COALESCE(valuation_text, $8),
          valuation_usd = COALESCE(valuation_usd, $9),
          updated_at = NOW()
        WHERE id = $10
      `, [
        proposed.lead ?? null,
        proposed.co_investors ?? null,
        proposed.market ?? null,
        proposed.round ?? null,
        proposed.allocation_usd ?? null,
        proposed.min_investment_usd ?? null,
        proposed.carry_pct ?? null,
        proposed.valuation_text ?? null,
        proposed.valuation_usd ?? null,
        group.id,
      ]);
    }

    results.push({
      id: group.id,
      company_name: group.company_name,
      documents_checked: group.documents.length,
      changes: Object.fromEntries(changedFields.map(field => [field, { from: null, to: proposed[field] }])),
    });
  }

  return results;
}
