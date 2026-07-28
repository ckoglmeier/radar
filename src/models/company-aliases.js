import { query } from '../db/index.js';
import { normalize } from '../utils/company-names.js';

function requiredName(value, label) {
  const name = String(value || '').trim();
  if (!name) throw new TypeError(`${label} is required`);
  return name;
}

export async function listCompanyAliases() {
  return query(`
    SELECT id, alias, alias_normalized, canonical_company_name,
           canonical_normalized, provenance_source, provenance_note,
           confirmed_by, created_at, updated_at
      FROM company_aliases
     ORDER BY LOWER(alias), id
  `);
}

export async function resolveCompanyAlias(value) {
  const normalized = normalize(value);
  if (!normalized) return null;
  const rows = await query(`
    SELECT id, alias, alias_normalized, canonical_company_name,
           canonical_normalized, provenance_source, provenance_note,
           confirmed_by, created_at, updated_at
      FROM company_aliases
     WHERE alias_normalized = $1
     LIMIT 1
  `, [normalized]);
  return rows[0] || null;
}

export async function saveCompanyAlias({
  alias,
  canonicalCompanyName,
  provenanceSource = 'manual_match',
  provenanceNote = null,
  confirmedBy = 'user',
} = {}) {
  const aliasName = requiredName(alias, 'Alias');
  const canonicalName = requiredName(canonicalCompanyName, 'Canonical company name');
  const aliasNormalized = normalize(aliasName);
  const canonicalNormalized = normalize(canonicalName);
  if (!aliasNormalized || !canonicalNormalized) {
    throw new TypeError('Alias and canonical company name must contain searchable text');
  }
  if (aliasNormalized === canonicalNormalized) {
    throw new TypeError('Alias must differ from the canonical company name');
  }

  const canonicalRows = await query(`
    SELECT company_name
      FROM investments
     WHERE asset_class = 'direct'
       AND LOWER(BTRIM(company_name)) = LOWER(BTRIM($1))
     ORDER BY id
  `, [canonicalName]);
  if (canonicalRows.length === 0) {
    throw new Error('Canonical company must be an existing direct position');
  }
  const storedCanonicalName = canonicalRows[0].company_name;

  const rows = await query(`
    INSERT INTO company_aliases
      (alias, alias_normalized, canonical_company_name, canonical_normalized,
       provenance_source, provenance_note, confirmed_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (alias_normalized) DO UPDATE
      SET alias = EXCLUDED.alias,
          canonical_company_name = EXCLUDED.canonical_company_name,
          canonical_normalized = EXCLUDED.canonical_normalized,
          provenance_source = EXCLUDED.provenance_source,
          provenance_note = EXCLUDED.provenance_note,
          confirmed_by = EXCLUDED.confirmed_by,
          updated_at = NOW()
    RETURNING *
  `, [
    aliasName,
    aliasNormalized,
    storedCanonicalName,
    canonicalNormalized,
    requiredName(provenanceSource, 'Provenance source'),
    provenanceNote ? String(provenanceNote).trim() : null,
    requiredName(confirmedBy, 'Confirmed by'),
  ]);
  return rows[0];
}

export async function companyPositions(value) {
  const alias = await resolveCompanyAlias(value);
  const canonicalNormalized = alias?.canonical_normalized || normalize(value);
  if (!canonicalNormalized) return { alias, positions: [] };
  const positions = await query(`
    SELECT id, company_name, status, invest_date, invested, lead, round, source
      FROM investments
     WHERE asset_class = 'direct'
     ORDER BY invest_date, id
  `);
  return {
    alias,
    positions: positions.filter(position =>
      normalize(position.company_name) === canonicalNormalized
    ),
  };
}
