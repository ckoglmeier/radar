// One-time angel evaluation: personal context contract (pure, no DB, no I/O).
//
// Personal context has two separate dimensions and is never one ranked list:
//   interests (WHAT I want to back): an unranked set. Items reuse existing
//     theses by copying their wording at confirmation, or are custom and
//     evaluation-only.
//   business (HOW I prefer the business to work): up to six ordered
//     preferences. Order is explanatory focus only, never a numeric weight.
// Deal terms and portfolio constraints are confirmed FACTS, kept apart from
// both dimensions. Preference notes are never parsed into facts.
//
// Objective research, Council, calibration, sizing and calculators never read
// this module's output. Only personal-fit synthesis and the report do.

import { createHash, randomUUID } from 'node:crypto';

export const PERSONAL_CONTEXT_CONTRACT_VERSION = 1;
export const LIMITS = Object.freeze({
  interests: 12,
  business: 6,
  label: 120,
  note: 1000,
  companyName: 200,
  url: 500,
});
export const DIMENSION_MODES = Object.freeze(['unspecified', 'saved', 'custom']);
// Editable suggestions offered when no saved business-preference list exists.
// They are not endorsed until the user confirms them.
export const BUSINESS_SUGGESTIONS = Object.freeze([
  'Recurring revenue',
  'Capital-efficient growth',
  'Repeatable go-to-market',
  'Durable unit economics',
  'Limited hardware exposure',
]);
export const DEAL_TERM_FIELDS = Object.freeze([
  'round', 'instrument', 'valuation_cap_usd', 'valuation_text', 'discount_pct', 'min_investment_usd', 'allocation_usd',
]);
export const PORTFOLIO_FIELDS = Object.freeze(['proposed_check_usd', 'max_position_usd']);
export const INSTRUMENTS = Object.freeze(['safe', 'convertible_note', 'priced_equity', 'spv_units', 'other']);
const NUMERIC_FIELDS = new Set(['valuation_cap_usd', 'discount_pct', 'min_investment_usd', 'allocation_usd', 'proposed_check_usd', 'max_position_usd']);
const FACT_STATUSES = Object.freeze(['confirmed', 'unknown']);
const FACT_PROVENANCE = Object.freeze(['extracted', 'user_entered']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class PersonalContextError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'PersonalContextError';
    this.code = 'INVALID_PERSONAL_CONTEXT';
    this.field = field;
  }
}

const fail = (message, field) => { throw new PersonalContextError(message, field); };
const isPlain = value => value && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, allowed, label) {
  if (!isPlain(value)) fail(`${label} must be an object`, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} has unexpected field ${key}`, label);
}

// Exact wording is preserved: no trimming inside, no case changes. Only
// surrounding whitespace is removed, and blank labels are rejected.
function label(value, field) {
  if (typeof value !== 'string') fail('Label must be text', field);
  const text = value.trim();
  if (!text) fail('Label cannot be blank', field);
  if (text.length > LIMITS.label) fail(`Label must be ${LIMITS.label} characters or fewer`, field);
  return text;
}

function note(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') fail('Note must be text', field);
  const text = value.trim();
  if (text.length > LIMITS.note) fail(`Note must be ${LIMITS.note} characters or fewer`, field);
  return text || null;
}

function itemId(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('Each item needs a stable ID', field);
  return value;
}

export function newItemId(prefix = 'p') {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function uniqueIds(items, field) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) fail('Duplicate item ID', field);
    seen.add(item.id);
  }
}

export function validateInterestItem(value, index = 0) {
  const field = `interests.items[${index}]`;
  exactKeys(value, ['id', 'label', 'note', 'source'], field);
  const source = value.source ?? { kind: 'custom' };
  if (!isPlain(source)) fail('Interest source must be an object', field);
  let normalizedSource;
  if (source.kind === 'custom') {
    exactKeys(source, ['kind'], `${field}.source`);
    normalizedSource = { kind: 'custom' };
  } else if (source.kind === 'thesis') {
    exactKeys(source, ['kind', 'lens_thesis_id', 'thesis_name', 'thesis_belief'], `${field}.source`);
    if (typeof source.lens_thesis_id !== 'string' || !source.lens_thesis_id.trim()) fail('Thesis interests need the thesis slug', field);
    normalizedSource = {
      kind: 'thesis',
      lens_thesis_id: source.lens_thesis_id.trim(),
      thesis_name: label(source.thesis_name, `${field}.source.thesis_name`),
      thesis_belief: source.thesis_belief == null ? null : note(String(source.thesis_belief), `${field}.source.thesis_belief`),
    };
  } else {
    fail('Interest source must be a thesis or custom', field);
  }
  return { id: itemId(value.id, field), label: label(value.label, field), note: note(value.note, field), source: normalizedSource };
}

// Interests are an unranked set: canonical storage order is by ID so no
// position can be read as a rank. Display sorts by label.
export function validateInterests(items) {
  if (!Array.isArray(items)) fail('Interests must be a list', 'interests');
  if (items.length > LIMITS.interests) fail(`Choose up to ${LIMITS.interests} interests`, 'interests');
  const normalized = items.map(validateInterestItem);
  uniqueIds(normalized, 'interests');
  const thesisIds = normalized.filter(item => item.source.kind === 'thesis').map(item => item.source.lens_thesis_id);
  if (new Set(thesisIds).size !== thesisIds.length) fail('A thesis can be selected once', 'interests');
  return normalized.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function validateBusinessItem(value, index = 0) {
  const field = `business.items[${index}]`;
  exactKeys(value, ['id', 'label', 'note', 'must_have'], field);
  if (value.must_have != null && typeof value.must_have !== 'boolean') fail('Must-have must be true or false', field);
  return { id: itemId(value.id, field), label: label(value.label, field), note: note(value.note, field), must_have: value.must_have === true };
}

// Business preferences keep the user's order exactly. No weights.
export function validateBusinessPreferences(items) {
  if (!Array.isArray(items)) fail('Business preferences must be a list', 'business');
  if (items.length > LIMITS.business) fail(`Choose up to ${LIMITS.business} business preferences`, 'business');
  const normalized = items.map(validateBusinessItem);
  uniqueIds(normalized, 'business');
  return normalized;
}

// A dimension is explicitly unspecified (empty) or confirmed with items.
// `saved` means the confirmed items came unchanged from a reusable source
// (a saved business list, or theses for interests); `custom` means edited.
export function validateDimension(value, kind) {
  const field = kind;
  exactKeys(value, kind === 'business' ? ['mode', 'items', 'origin'] : ['mode', 'items'], field);
  if (!DIMENSION_MODES.includes(value.mode)) fail('Choose how this dimension was confirmed', field);
  const items = kind === 'business' ? validateBusinessPreferences(value.items ?? []) : validateInterests(value.items ?? []);
  if (value.mode === 'unspecified' && items.length) fail('An unspecified dimension cannot contain items', field);
  if (value.mode !== 'unspecified' && !items.length) fail('Confirmed dimensions need at least one item; otherwise leave it unspecified', field);
  const result = { mode: value.mode, items };
  if (kind === 'business') {
    const origin = value.origin ?? null;
    if (origin != null) {
      exactKeys(origin, ['list_id', 'version'], `${field}.origin`);
      if (typeof origin.list_id !== 'string' || !Number.isSafeInteger(origin.version) || origin.version < 1) fail('Invalid saved list origin', field);
    }
    if (value.mode === 'saved' && !origin) fail('Saved business preferences need their list origin', field);
    result.origin = origin ? { list_id: origin.list_id, version: origin.version } : null;
  }
  return result;
}

function factValue(field, value) {
  if (value == null) return null;
  if (NUMERIC_FIELDS.has(field)) {
    const number = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(number) || number < 0) fail('Enter a non-negative number', field);
    if (field === 'discount_pct' && number > 100) fail('Discount must be between 0 and 100', field);
    return number;
  }
  if (field === 'instrument') {
    if (!INSTRUMENTS.includes(value)) fail('Choose a supported instrument or Unknown', field);
    return value;
  }
  if (typeof value !== 'string') fail('Enter text', field);
  const text = value.trim();
  if (text.length > LIMITS.label) fail(`Must be ${LIMITS.label} characters or fewer`, field);
  return text || null;
}

function validateFactGroup(group, fields, label) {
  const input = group ?? {};
  exactKeys(input, fields, label);
  const out = {};
  for (const field of fields) {
    const fact = input[field] ?? { value: null, status: 'unknown', provenance: null };
    exactKeys(fact, ['value', 'status', 'provenance'], `${label}.${field}`);
    if (!FACT_STATUSES.includes(fact.status)) fail('Fact status must be confirmed or unknown', field);
    const value = factValue(field, fact.value);
    if (fact.status === 'confirmed' && value == null) fail('A confirmed fact needs a value; otherwise mark it Unknown', field);
    if (fact.status === 'unknown' && value != null) fail('An unknown fact cannot carry a value', field);
    if (fact.provenance != null && !FACT_PROVENANCE.includes(fact.provenance)) fail('Invalid fact provenance', field);
    out[field] = { value, status: fact.status, provenance: fact.status === 'confirmed' ? (fact.provenance || 'user_entered') : null };
  }
  return out;
}

// Deal terms are facts about the deal. Portfolio constraints are facts about the
// investor. Neither is a preference, and neither is inferred from notes.
export function validateFacts(value) {
  const input = value ?? {};
  exactKeys(input, ['deal_terms', 'portfolio'], 'facts');
  return {
    deal_terms: validateFactGroup(input.deal_terms, DEAL_TERM_FIELDS, 'deal_terms'),
    portfolio: validateFactGroup(input.portfolio, PORTFOLIO_FIELDS, 'portfolio'),
  };
}

export function emptyFacts() {
  return validateFacts({});
}

function validateCompany(value) {
  exactKeys(value, ['name', 'url', 'pipeline_invite_id', 'deal_slug'], 'company');
  const name = label(String(value.name ?? ''), 'company.name');
  let url = null;
  if (value.url != null && String(value.url).trim()) {
    let parsed;
    try { parsed = new URL(String(value.url).trim()); } catch { fail('Enter a full company URL, including https://', 'company.url'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('Enter an http(s) company URL', 'company.url');
    url = parsed.toString().slice(0, LIMITS.url);
  }
  const inviteId = Number(value.pipeline_invite_id);
  if (!Number.isSafeInteger(inviteId) || inviteId <= 0) fail('The evaluation needs its pipeline deal', 'company.pipeline_invite_id');
  return { name, url, pipeline_invite_id: inviteId, deal_slug: value.deal_slug ? String(value.deal_slug) : null };
}

function validateFramework(value) {
  exactKeys(value, ['review_mode', 'framework_version_id', 'framework_label'], 'framework');
  if (!['personalized', 'ad_hoc'].includes(value.review_mode)) fail('Choose an objective review mode', 'framework.review_mode');
  return {
    review_mode: value.review_mode,
    framework_version_id: value.framework_version_id == null ? null : Number(value.framework_version_id),
    framework_label: value.framework_label == null ? null : String(value.framework_label).slice(0, LIMITS.label),
  };
}

// Canonical JSON (sorted keys) so the snapshot hash is stable across runs.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function snapshotHash(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

// The immutable evaluation context, captured at submission time.
export function buildEvaluationSnapshot({ company, interests, business, facts, framework }) {
  const snapshot = {
    contract_version: PERSONAL_CONTEXT_CONTRACT_VERSION,
    company: validateCompany(company ?? {}),
    interests: validateDimension(interests ?? { mode: 'unspecified', items: [] }, 'interests'),
    business: validateDimension(business ?? { mode: 'unspecified', items: [], origin: null }, 'business'),
    facts: validateFacts(facts),
    framework: validateFramework(framework ?? {}),
  };
  return { snapshot, sha256: snapshotHash(snapshot) };
}

export function validateSnapshot(snapshot) {
  if (!isPlain(snapshot) || snapshot.contract_version !== PERSONAL_CONTEXT_CONTRACT_VERSION) fail('Unsupported evaluation context version', 'snapshot');
  exactKeys(snapshot, ['contract_version', 'company', 'interests', 'business', 'facts', 'framework'], 'snapshot');
  return buildEvaluationSnapshot(snapshot).snapshot;
}

export function personalFitApplicable(snapshot) {
  return snapshot.interests.items.length > 0 || snapshot.business.items.length > 0;
}

// Only the parts personal-fit synthesis may read. Facts are labeled as confirmed
// facts; preference notes are labeled as preferences and are never numeric evidence.
export function personalFitContext(snapshot) {
  const s = validateSnapshot(snapshot);
  return {
    company: s.company.name,
    interests: s.interests.items.map(item => ({ id: item.id, label: item.label, note: item.note, source: item.source.kind === 'thesis' ? `Your thesis “${item.source.thesis_name}”` : 'Added for this evaluation' })).sort((a, b) => a.label.localeCompare(b.label)),
    business: s.business.items.map(item => ({ id: item.id, label: item.label, note: item.note, must_have: item.must_have })),
    confirmed_facts: Object.fromEntries(Object.entries({ ...s.facts.deal_terms, ...s.facts.portfolio })
      .filter(([, fact]) => fact.status === 'confirmed').map(([key, fact]) => [key, fact.value])),
  };
}

// Draft state: everything optional and partially filled, persisted between steps.
// Validation here is shape-only so failed saves never lose edits client-side.
export const DRAFT_STEPS = Object.freeze(['deal', 'terms', 'interests', 'business', 'review']);
export function validateDraftState(value) {
  const input = value ?? {};
  exactKeys(input, ['step', 'company', 'interests', 'business', 'facts', 'framework', 'save_business_preferences', 'materials'], 'draft');
  const out = { step: DRAFT_STEPS.includes(input.step) ? input.step : 'deal' };
  if (input.company != null) {
    exactKeys(input.company, ['name', 'url', 'pipeline_invite_id', 'deal_slug'], 'draft.company');
    out.company = {
      name: input.company.name == null ? null : String(input.company.name).slice(0, LIMITS.companyName),
      url: input.company.url == null ? null : String(input.company.url).slice(0, LIMITS.url),
      pipeline_invite_id: input.company.pipeline_invite_id == null ? null : Number(input.company.pipeline_invite_id),
      deal_slug: input.company.deal_slug == null ? null : String(input.company.deal_slug),
    };
  }
  // Partial dimensions are allowed in a draft (confirmation happens at submit),
  // but items must already be well-formed so exact wording is preserved.
  if (input.interests != null) {
    exactKeys(input.interests, ['mode', 'items', 'confirmed'], 'draft.interests');
    out.interests = { mode: DIMENSION_MODES.includes(input.interests.mode) ? input.interests.mode : null, items: validateInterests(input.interests.items ?? []), confirmed: input.interests.confirmed === true };
  }
  if (input.business != null) {
    exactKeys(input.business, ['mode', 'items', 'origin', 'confirmed'], 'draft.business');
    out.business = {
      mode: DIMENSION_MODES.includes(input.business.mode) ? input.business.mode : null,
      items: validateBusinessPreferences(input.business.items ?? []),
      origin: input.business.origin ?? null,
      confirmed: input.business.confirmed === true,
    };
  }
  if (input.facts != null) out.facts = validateFacts(input.facts);
  if (input.framework != null) out.framework = validateFramework(input.framework);
  out.save_business_preferences = input.save_business_preferences === true;
  if (input.materials != null) {
    if (!Array.isArray(input.materials) || input.materials.length > 50) fail('Too many materials', 'draft.materials');
    out.materials = input.materials.map(item => {
      exactKeys(item, ['document_id', 'filename', 'kind'], 'draft.materials');
      return { document_id: Number(item.document_id), filename: String(item.filename || '').slice(0, 255), kind: ['upload', 'paste'].includes(item.kind) ? item.kind : 'upload' };
    });
  }
  return out;
}
