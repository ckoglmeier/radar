import { query, withAtomicWrite } from '../db/index.js';
import { canonicalEntityRecord, resolveCanonicalEntityId } from './canonical-identity.js';
import { companyIndirectExposureRecord, policyAllows } from './vehicle-disclosures.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIDENCE = new Set(['confirmed', 'reported', 'calculated', 'estimated', 'unknown']);
const CONFIDENTIALITY = new Set(['standard', 'confidential_company', 'tax_sensitive']);
const PROCESSING = new Set(['local_only', 'model_allowed']);
const SYNC = new Set(['local_only', 'encrypted_backup_allowed']);

export const COMPANY_FACT_REGISTRY = Object.freeze({
  canonical_domain: { valueType: 'text', version: 1 },
  company_status: { valueType: 'text', version: 1 },
  sector: { valueType: 'text', version: 1 },
  headquarters: { valueType: 'text', version: 1 },
  key_people: { valueType: 'json', version: 1 },
  financing_date: { valueType: 'date', version: 1 },
  financing_round: { valueType: 'text', version: 1 },
  financing_amount: { valueType: 'money', version: 1 },
  financing_valuation: { valueType: 'money', version: 1 },
  valuation_basis: { valueType: 'text', version: 1 },
});

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(String(value || ''))) throw new TypeError(`${label} must be a UUID`);
  return String(value);
}

function assertEnum(value, allowed, label) {
  const text = requiredText(value, label);
  if (!allowed.has(text)) throw new TypeError(`invalid ${label}: ${text}`);
  return text;
}

function isoDate(value, label, { nullable = false } = {}) {
  if (nullable && (value == null || value === '')) return null;
  const text = requiredText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new TypeError(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
  return text;
}

function validateValue(factKey, value) {
  const contract = COMPANY_FACT_REGISTRY[factKey];
  if (!contract) throw new TypeError(`unsupported Company fact key: ${factKey}`);
  if (contract.valueType === 'text') return requiredText(value, `${factKey} value`);
  if (contract.valueType === 'date') return isoDate(value, `${factKey} value`);
  if (contract.valueType === 'json') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${factKey} value must be an object`);
    }
    return value;
  }
  if (contract.valueType === 'money') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${factKey} value must be a monetary object`);
    }
    const amount = Number(value.amount);
    if (!Number.isFinite(amount)) throw new TypeError(`${factKey} amount must be a number`);
    return {
      amount,
      currency: requiredText(value.currency, `${factKey} currency`).toUpperCase(),
      unit_scale: requiredText(value.unit_scale, `${factKey} unit scale`),
      basis: requiredText(value.basis, `${factKey} basis`),
      effective_date: isoDate(value.effective_date, `${factKey} effective date`, { nullable: true }),
    };
  }
  return value;
}

async function ensureFactRegistry(factKey) {
  const contract = COMPANY_FACT_REGISTRY[factKey];
  if (!contract) throw new TypeError(`unsupported Company fact key: ${factKey}`);
  const rows = await query(`
    INSERT INTO company_fact_registry (fact_key, value_type, registry_version)
    VALUES ($1,$2,$3)
    ON CONFLICT (fact_key) DO NOTHING
    RETURNING *
  `, [factKey, contract.valueType, contract.version]);
  const current = rows[0] || (await query(`
    SELECT * FROM company_fact_registry WHERE fact_key = $1
  `, [factKey]))[0];
  if (current.value_type !== contract.valueType || Number(current.registry_version) !== contract.version) {
    throw new Error(`Company fact registry conflict for ${factKey}`);
  }
  return current;
}

async function companyEntity(companyEntityId) {
  assertUuid(companyEntityId, 'Company Entity ID');
  const canonicalId = await resolveCanonicalEntityId(companyEntityId);
  const [company] = await query(`
    SELECT pe.*, c.metadata_reviewed_at
      FROM companies c JOIN portfolio_entities pe ON pe.id = c.entity_id
     WHERE c.entity_id = $1
  `, [canonicalId]);
  if (!company) throw new Error('Company Fact requires a reviewed Company Entity');
  return company;
}

export async function proposeCompanyFact(fields = {}) {
  const company = await companyEntity(fields.companyEntityId);
  const factKey = requiredText(fields.factKey, 'Fact key');
  await ensureFactRegistry(factKey);
  const value = validateValue(factKey, fields.value);
  const sourceNamespace = requiredText(fields.sourceNamespace, 'Source namespace');
  const sourceClaimId = requiredText(fields.sourceClaimId, 'Source claim ID');
  const sourceHash = requiredText(fields.sourceHash, 'Source hash');
  const confidence = assertEnum(fields.confidence || 'reported', CONFIDENCE, 'confidence');
  const confidentiality = assertEnum(fields.confidentiality || 'confidential_company', CONFIDENTIALITY, 'confidentiality');
  const processingPolicy = assertEnum(fields.processingPolicy || 'local_only', PROCESSING, 'processing policy');
  const syncPolicy = assertEnum(fields.syncPolicy || 'encrypted_backup_allowed', SYNC, 'sync policy');

  return withAtomicWrite(async () => {
    const [existing] = await query(`
      SELECT * FROM company_facts
       WHERE company_entity_id = $1 AND source_namespace = $2
         AND source_claim_id = $3 AND fact_key = $4
    `, [company.id, sourceNamespace, sourceClaimId, factKey]);
    if (existing) {
      if (
        existing.source_hash !== sourceHash ||
        JSON.stringify(stableValue(existing.value)) !== JSON.stringify(stableValue(value))
      ) {
        throw new Error('Company Fact source claim conflicts with another value');
      }
      return { fact: existing, idempotent_replay: true };
    }
    const [fact] = await query(`
      INSERT INTO company_facts
        (company_entity_id, fact_key, value, effective_date, effective_end_date,
         source_namespace, source_claim_id, source_hash, source_document_id,
         confidence, confidentiality, processing_policy, sync_policy,
         policy_version, review_state, supersedes_fact_id)
      VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
              'needs_review',$15)
      RETURNING *
    `, [
      company.id,
      factKey,
      JSON.stringify(value),
      isoDate(fields.effectiveDate, 'Effective date', { nullable: true }),
      isoDate(fields.effectiveEndDate, 'Effective end date', { nullable: true }),
      sourceNamespace,
      sourceClaimId,
      sourceHash,
      fields.sourceDocumentId || null,
      confidence,
      confidentiality,
      processingPolicy,
      syncPolicy,
      fields.policyVersion == null ? 1 : Number(fields.policyVersion),
      fields.supersedesFactId ? assertUuid(fields.supersedesFactId, 'Superseded Fact ID') : null,
    ]);
    return { fact, idempotent_replay: false };
  });
}

export async function acceptCompanyFact(factId, fields = {}) {
  assertUuid(factId, 'Company Fact ID');
  const reviewedBy = requiredText(fields.reviewedBy || 'local_user', 'Reviewer');
  return withAtomicWrite(async () => {
    const [before] = await query(`SELECT * FROM company_facts WHERE id = $1 FOR UPDATE`, [factId]);
    if (!before) throw new Error(`Company Fact not found: ${factId}`);
    if (before.review_state === 'accepted') return { fact: before, idempotent_replay: true };
    if (before.review_state === 'rejected') throw new Error('rejected Company Fact cannot be accepted');
    if (before.supersedes_fact_id) {
      const [prior] = await query(`SELECT * FROM company_facts WHERE id = $1`, [before.supersedes_fact_id]);
      if (!prior || prior.review_state !== 'accepted') {
        throw new Error('superseding Company Fact requires an accepted prior fact');
      }
      if (prior.company_entity_id !== before.company_entity_id || prior.fact_key !== before.fact_key) {
        throw new Error('superseding Company Fact must share Company and fact key');
      }
    }
    const [fact] = await query(`
      UPDATE company_facts
         SET review_state = 'accepted', reviewed_by = $2,
             reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *
    `, [factId, reviewedBy]);
    await query(`
      UPDATE companies SET metadata_reviewed_at = NOW(), updated_at = NOW()
       WHERE entity_id = $1
    `, [fact.company_entity_id]);
    return { fact, idempotent_replay: false };
  });
}

export async function rejectCompanyFact(factId, fields = {}) {
  assertUuid(factId, 'Company Fact ID');
  const reviewedBy = requiredText(fields.reviewedBy || 'local_user', 'Reviewer');
  return withAtomicWrite(async () => {
    const [before] = await query(`SELECT * FROM company_facts WHERE id = $1 FOR UPDATE`, [factId]);
    if (!before) throw new Error(`Company Fact not found: ${factId}`);
    if (before.review_state === 'rejected') return { fact: before, idempotent_replay: true };
    if (before.review_state === 'accepted') throw new Error('accepted Company Fact is immutable');
    const [fact] = await query(`
      UPDATE company_facts
         SET review_state = 'rejected', reviewed_by = $2,
             reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *
    `, [factId, reviewedBy]);
    return { fact, idempotent_replay: false };
  });
}

export async function companyFactHistory(companyEntityId, factKey, context) {
  const company = await companyEntity(companyEntityId);
  const params = [company.id];
  let filter = '';
  if (factKey != null) {
    params.push(requiredText(factKey, 'Fact key'));
    filter = `AND cf.fact_key = $${params.length}`;
  }
  const rows = await query(`
    SELECT cf.*
      FROM company_facts cf
     WHERE cf.company_entity_id = $1 ${filter}
     ORDER BY cf.fact_key, cf.effective_date DESC NULLS LAST, cf.created_at DESC
  `, params);
  return rows.filter(row => policyAllows(row, context));
}

export async function canonicalCompanyRecord(companyEntityId, context) {
  const company = await companyEntity(companyEntityId);
  const [entityRecord, facts, positions, indirectExposures] = await Promise.all([
    canonicalEntityRecord(company.id),
    companyFactHistory(company.id, null, context),
    query(`
      SELECT i.id, i.position_key, i.company_name, i.asset_class, i.status,
             i.invest_date, i.invested, i.net_value, i.holder_entity_id,
             i.issuer_entity_id, i.route_classification,
             holder.legal_name AS holder_name
        FROM investments i
        LEFT JOIN portfolio_entities holder ON holder.id = i.holder_entity_id
       WHERE i.issuer_entity_id = $1
         AND i.identity_review_status = 'accepted'
         AND i.route_classification = 'direct_issuer'
         AND i.asset_class IN ('direct', 'employment_equity')
       ORDER BY i.asset_class, i.invest_date, i.id
    `, [company.id]),
    companyIndirectExposureRecord(company.id, context),
  ]);
  const superseded = new Set(facts.filter(row => row.supersedes_fact_id).map(row => row.supersedes_fact_id));
  const currentFacts = facts.filter(row => row.review_state === 'accepted' && !superseded.has(row.id));
  return {
    entity: entityRecord,
    current_facts: currentFacts,
    fact_history: facts,
    issued_positions: positions,
    indirect_exposures: indirectExposures,
  };
}
