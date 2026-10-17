// Giving research contracts (pure). Implements docs/GIVING_RUBRIC.md (approved 2026-10-16).
//
// Organization review: six rubric dimensions, typed findings with provenance, supporting and
// cautioning evidence, open questions, an evaluator panel reported verbatim, and sources.
// Request evaluation: four request dimensions plus personal-fit readings against the confirmed
// lens. Neither carries a score, grade, rank or overall verdict. Validation repairs by removal:
// a finding that cites an unknown source, or states a figure absent from its sources, is dropped
// and the drop is recorded, so no unsupported claim survives silently.

import { GivingError } from './report.js';

export const GIVING_RUBRIC_VERSION = 1;
export const ORG_DIMENSIONS = Object.freeze([
  { id: 'theory_of_change', label: 'Theory of change' },
  { id: 'impact_evidence', label: 'Impact evidence' },
  { id: 'organization_execution', label: 'Organization and execution' },
  { id: 'financial_resilience', label: 'Financial resilience' },
  { id: 'use_of_funds', label: 'Use of additional funding' },
  { id: 'risks_open_questions', label: 'Risks, restrictions and open questions' },
]);
export const REQUEST_DIMENSIONS = Object.freeze([
  { id: 'use_of_these_funds', label: 'Use of these funds' },
  { id: 'marginal_effect', label: 'Marginal effect' },
  { id: 'terms_timing', label: 'Terms and timing' },
  { id: 'reporting_back', label: 'Reporting back' },
]);
export const PROVENANCE = Object.freeze(['organization_claim', 'independent_evidence', 'third_party_assessment', 'regulatory_record', 'user_statement', 'derived_result']);
export const CLAIM_TYPES = Object.freeze(['activity', 'output', 'intended_outcome', 'observed_outcome', 'causal_attribution', 'forecast']);
export const DIRECTIONS = Object.freeze(['supports', 'cautions', 'unknown']);
export const UNCERTAINTY = Object.freeze(['low', 'medium', 'high']);
export const COVERAGE = Object.freeze(['assessed', 'limited_evidence', 'not_assessable']);
export const CAUSE_READINGS = Object.freeze(['addresses', 'partially_addresses', 'does_not_address', 'unclear']);
export const PRIORITY_READINGS = Object.freeze(['fits', 'mixed', 'does_not_fit', 'unclear']);
export const MUST_HAVE_STATUS = Object.freeze(['appears_met', 'unresolved', 'possible_conflict']);

const str = (max, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
const ids = { type: 'array', maxItems: 12, items: str(80) };

export const ORG_REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['identity_confirmed', 'identity_note', 'summary', 'dimensions', 'evaluator_panel', 'web_sources'],
  properties: {
    identity_confirmed: { type: 'boolean' },
    identity_note: str(400, 0),
    summary: str(1200),
    dimensions: { type: 'array', minItems: 6, maxItems: 6, items: {
      type: 'object', additionalProperties: false, required: ['id', 'coverage', 'findings', 'open_questions'],
      properties: {
        id: { type: 'string', enum: ORG_DIMENSIONS.map(d => d.id) },
        coverage: { type: 'string', enum: COVERAGE },
        findings: { type: 'array', maxItems: 8, items: {
          type: 'object', additionalProperties: false, required: ['statement', 'claim_type', 'provenance', 'direction', 'uncertainty', 'evidence_ids'],
          properties: {
            statement: str(500), claim_type: { type: 'string', enum: CLAIM_TYPES }, provenance: { type: 'string', enum: PROVENANCE },
            direction: { type: 'string', enum: DIRECTIONS }, uncertainty: { type: 'string', enum: UNCERTAINTY }, evidence_ids: ids,
          },
        } },
        open_questions: { type: 'array', maxItems: 5, items: str(300) },
      },
    } },
    evaluator_panel: { type: 'array', maxItems: 4, items: {
      type: 'object', additionalProperties: false, required: ['evaluator', 'status', 'evidence_ids'],
      properties: { evaluator: str(80), status: str(300), evidence_ids: ids },
    } },
    web_sources: { type: 'array', maxItems: 30, items: {
      type: 'object', additionalProperties: false, required: ['id', 'url', 'title', 'quote'],
      properties: { id: { type: 'string', pattern: '^web:[0-9]{1,3}$' }, url: str(2048), title: str(500, 0), quote: str(600, 0) },
    } },
  },
};

export const REQUEST_EVALUATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'request_dimensions', 'causes', 'priorities', 'questions_for_organization'],
  properties: {
    summary: str(1000),
    request_dimensions: { type: 'array', minItems: 4, maxItems: 4, items: {
      type: 'object', additionalProperties: false, required: ['id', 'coverage', 'explanation', 'evidence_ids', 'open_question'],
      properties: { id: { type: 'string', enum: REQUEST_DIMENSIONS.map(d => d.id) }, coverage: { type: 'string', enum: COVERAGE }, explanation: str(800), evidence_ids: ids, open_question: { type: ['string', 'null'], maxLength: 300 } },
    } },
    causes: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false, required: ['item_id', 'reading', 'explanation', 'evidence_ids'],
      properties: { item_id: str(64), reading: { type: 'string', enum: CAUSE_READINGS }, explanation: str(600), evidence_ids: ids },
    } },
    priorities: { type: 'array', maxItems: 6, items: {
      type: 'object', additionalProperties: false, required: ['item_id', 'reading', 'explanation', 'evidence_ids', 'must_have_status', 'next_question'],
      properties: {
        item_id: str(64), reading: { type: 'string', enum: PRIORITY_READINGS }, explanation: str(600), evidence_ids: ids,
        must_have_status: { type: ['string', 'null'], enum: [...MUST_HAVE_STATUS, null] }, next_question: { type: ['string', 'null'], maxLength: 300 },
      },
    } },
    questions_for_organization: { type: 'array', maxItems: 8, items: str(300) },
  },
};

// ── Figures must come from their sources ──
// A figure is supported when some number in its cited sources has the same value, allowing 5%
// for rounding ("$1.4 million" ↔ 1,415,000). Years and single digits are not checked.
const FIGURE = /\$?(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|[mbk](?![a-z]))?/gi;
const SCALE = { million: 1e6, m: 1e6, billion: 1e9, b: 1e9, thousand: 1e3, k: 1e3 };
function figures(text) {
  const out = [];
  for (const match of String(text).matchAll(FIGURE)) {
    const value = Number(match[1].replace(/,/g, '')) * (SCALE[(match[2] || '').toLowerCase()] || 1);
    if (Number.isFinite(value)) out.push({ token: match[0].trim(), value, scaled: Boolean(match[2]) });
  }
  return out;
}
const isYear = figure => !figure.scaled && Number.isInteger(figure.value) && figure.value >= 1900 && figure.value <= 2100;
export function unsupportedFigures(statement, sourceTexts) {
  const pool = sourceTexts.flatMap(figures).map(f => f.value);
  return figures(statement)
    .filter(f => f.value >= 10 && !isYear(f))
    .filter(f => !pool.some(v => Math.abs(v - f.value) <= 0.05 * Math.max(Math.abs(f.value), 1)))
    .map(f => f.token);
}

const RADAR_VERDICT = /\b(overall (?:score|rating|grade|verdict)|we (?:rate|score|grade)|radar (?:rates|scores|grades)|\d+\s*(?:\/|out of)\s*(?:5|10|100)\b)/i;

// Summaries have no claim-level citations. Do not give that unvalidated model
// channel authority to repeat rejected findings or introduce an overall verdict.
// Describe coverage only; the source-linked detail carries the actual analysis.
function coverageSummary(dimensions, subject) {
  const assessed = dimensions.filter(d => d.coverage === 'assessed').length;
  return `${subject}: ${assessed} of ${dimensions.length} areas assessed. ${assessed === dimensions.length ? 'Review the evidence and open questions below.' : 'The remaining areas have limited evidence or cannot yet be assessed. Review the evidence and open questions below.'} This is not an overall rating or a giving decision.`;
}

// sources: [{ id, kind: 'registry'|'derived'|'web'|'request'|'user', text }]
export function validateOrgReview(output, registrySources) {
  if (!output || typeof output !== 'object') throw new GivingError('The review is missing.', 'review');
  const notes = [];
  const web = [];
  const seenUrls = new Set();
  for (const source of output.web_sources || []) {
    let url;
    try { url = new URL(source.url); } catch { notes.push(`Dropped a source with an invalid address (${source.id}).`); continue; }
    if (!['http:', 'https:'].includes(url.protocol) || seenUrls.has(url.href)) continue;
    seenUrls.add(url.href);
    web.push({ id: source.id, kind: 'web', url: url.href, title: source.title || url.hostname, text: `${source.title || ''} ${source.quote || ''}`, quote: source.quote || '' });
  }
  const sources = [...registrySources, ...web];
  const byId = new Map(sources.map(source => [source.id, source]));
  const checkFinding = (finding, where) => {
    const cited = (finding.evidence_ids || []).filter(id => byId.has(id));
    if (!cited.length || cited.length !== finding.evidence_ids.length) { notes.push(`Dropped a ${where} finding that cited a source Radar does not have.`); return null; }
    const kinds = cited.map(id => byId.get(id).kind);
    if (finding.provenance === 'derived_result' && !kinds.includes('derived')) { notes.push(`Dropped a ${where} finding labeled as Radar's calculation without one.`); return null; }
    if (finding.provenance === 'regulatory_record' && !kinds.includes('registry')) { notes.push(`Dropped a ${where} finding labeled as a filing without citing one.`); return null; }
    if (['independent_evidence', 'third_party_assessment'].includes(finding.provenance) && !kinds.includes('web')) { notes.push(`Dropped a ${where} finding labeled independent without an outside source.`); return null; }
    if (RADAR_VERDICT.test(finding.statement)) { notes.push(`Dropped a ${where} finding that read as a score or verdict.`); return null; }
    const unsupported = unsupportedFigures(finding.statement, cited.map(id => byId.get(id).text));
    if (unsupported.length) { notes.push(`Dropped a ${where} finding whose figure (${unsupported.join(', ')}) did not appear in its sources.`); return null; }
    return { ...finding, evidence_ids: cited };
  };
  const dimensions = ORG_DIMENSIONS.map(definition => {
    const found = (output.dimensions || []).filter(d => d.id === definition.id);
    if (found.length !== 1) throw new GivingError(`The review must cover ${definition.label} exactly once.`, 'dimensions');
    const findings = found[0].findings.map(f => checkFinding(f, definition.label)).filter(Boolean)
      .map((finding, index) => ({ id: `finding:${definition.id}:${index + 1}`, ...finding }));
    let coverage = found[0].coverage;
    if (coverage === 'assessed' && !findings.length) coverage = 'limited_evidence';
    const directions = new Set(findings.map(f => f.direction));
    const oneSided = findings.length >= 2 && directions.size === 1 && !directions.has('unknown');
    return { id: definition.id, label: definition.label, coverage, findings, one_sided: oneSided, open_questions: found[0].open_questions };
  });
  const panel = (output.evaluator_panel || []).map(entry => ({ ...entry, evidence_ids: entry.evidence_ids.filter(id => byId.has(id)) }));
  return {
    rubric_version: GIVING_RUBRIC_VERSION,
    identity_confirmed: output.identity_confirmed === true,
    identity_note: output.identity_note || null,
    summary: coverageSummary(dimensions, 'Organization review'),
    dimensions,
    evaluator_panel: panel,
    sources: sources.map(({ id, kind, url = null, title = null, quote = null, text }) => ({ id, kind, url, title: title || null, quote: quote || (kind === 'web' ? null : text) })),
    validation_notes: notes,
  };
}

// snapshot: { causes: [{id,label}], priorities: [{id,label,must_have}] }; evidence: review findings,
// review sources and request sources, by id.
export function validateRequestEvaluation(output, { snapshot, evidenceIds }) {
  if (!output || typeof output !== 'object') throw new GivingError('The evaluation is missing.', 'evaluation');
  const known = new Set(evidenceIds);
  const notes = [];
  const keep = (list, where) => {
    const kept = (list || []).filter(id => known.has(id));
    if (kept.length !== (list || []).length) notes.push(`Removed citations to unknown evidence in ${where}.`);
    return kept;
  };
  const requestDimensions = REQUEST_DIMENSIONS.map(definition => {
    const found = output.request_dimensions.filter(d => d.id === definition.id);
    if (found.length !== 1) throw new GivingError(`The evaluation must cover ${definition.label} exactly once.`, 'request_dimensions');
    const evidence = keep(found[0].evidence_ids, definition.label);
    return { id: definition.id, label: definition.label, coverage: evidence.length ? found[0].coverage : (found[0].coverage === 'assessed' ? 'limited_evidence' : found[0].coverage), explanation: found[0].explanation, evidence_ids: evidence, open_question: found[0].open_question };
  });
  const byItem = (list, item) => list.filter(entry => entry.item_id === item.id);
  const causes = snapshot.causes.map(cause => {
    const [reading] = byItem(output.causes, cause);
    if (!reading) return { item_id: cause.id, label: cause.label, reading: 'unclear', explanation: 'No reading was produced for this cause.', evidence_ids: [] };
    return { item_id: cause.id, label: cause.label, reading: reading.reading, explanation: reading.explanation, evidence_ids: keep(reading.evidence_ids, cause.label) };
  });
  const priorities = snapshot.priorities.map(priority => {
    const [reading] = byItem(output.priorities, priority);
    if (!reading) return { item_id: priority.id, label: priority.label, must_have: priority.must_have, reading: 'unclear', explanation: 'No reading was produced for this priority.', evidence_ids: [], must_have_status: priority.must_have ? 'unresolved' : null, next_question: null };
    return {
      item_id: priority.id, label: priority.label, must_have: priority.must_have, reading: reading.reading, explanation: reading.explanation,
      evidence_ids: keep(reading.evidence_ids, priority.label),
      // A must-have is a question, never a decision: only must-haves carry a status.
      must_have_status: priority.must_have ? (reading.must_have_status || 'unresolved') : null,
      next_question: reading.next_question,
    };
  });
  return {
    rubric_version: GIVING_RUBRIC_VERSION,
    summary: coverageSummary(requestDimensions, 'Request review'),
    request_dimensions: requestDimensions,
    causes,
    priorities,
    questions_for_organization: output.questions_for_organization,
    validation_notes: notes,
  };
}
