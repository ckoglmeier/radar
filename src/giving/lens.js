// Giving lens: My causes and My priorities (pure).
//
// Causes are an unranked set (what to support: issues, outcomes, communities, geography).
// Priorities are up to six ordered items (how an organization should work). Order is
// focus only, never a weight. Both may be empty, meaning unspecified. Nothing here is
// inferred: a cause drafted from past gifts carries the gift ids it came from and is
// stored only after the user confirms it.

import { canonicalJson, snapshotHash } from '../angel/personal-context.js';
import { GivingError } from './report.js';

export const GIVING_LENS_CONTRACT_VERSION = 1;
export const LENS_LIMITS = Object.freeze({ causes: 20, priorities: 6, label: 120, note: 1000, reasoning: 4000, draftCauses: 8, draftHints: 2, organizations: 200, dismissed: 100 });
export const PRIORITY_SUGGESTIONS = Object.freeze([
  'Approach to change',
  'Evidence of impact',
  'Organization and execution',
  'Use of additional funding',
  'Personal connection and involvement',
]);

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isPlain = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, field) => { throw new GivingError(message, field); };

function text(value, max, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) fail(`${field} is required`, field);
    return null;
  }
  if (typeof value !== 'string') fail(`${field} must be text`, field);
  const trimmed = value.trim();
  if (required && !trimmed) fail(`${field} is required`, field);
  if (trimmed.length > max) fail(`${field} is longer than ${max} characters`, field);
  return trimmed || null;
}

function keys(value, allowed, field) {
  if (!isPlain(value)) fail(`${field} must be an object`, field);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field} has unexpected field ${key}`, field);
}

function origin(value, field) {
  if (value == null) return { kind: 'user' };
  keys(value, ['kind', 'gift_ids', 'basis'], field);
  if (value.kind === 'user') return { kind: 'user' };
  if (value.kind !== 'drafted_from_gifts' && value.kind !== 'hint') fail(`${field}.kind is unknown`, field);
  const giftIds = value.gift_ids ?? [];
  if (!Array.isArray(giftIds) || !giftIds.length || giftIds.some(id => typeof id !== 'string' || !id)) fail(`${field} must cite at least one gift`, field);
  return { kind: value.kind, gift_ids: [...new Set(giftIds)].sort(), basis: text(value.basis, 300, `${field}.basis`) };
}

function uniqueIds(items, field) {
  const seen = new Set();
  for (const item of items) {
    if (!ID.test(item.id || '')) fail(`${field} item id is invalid`, field);
    if (seen.has(item.id)) fail(`${field} has a repeated id`, field);
    seen.add(item.id);
  }
}

export function validateLens(lens) {
  // contract_version is accepted (and replaced) so a saved lens can be edited and saved again.
  keys(lens, ['contract_version', 'causes', 'priorities', 'reasoning', 'dismissed'], 'lens');
  const causes = lens.causes ?? [];
  const priorities = lens.priorities ?? [];
  if (!Array.isArray(causes) || causes.length > LENS_LIMITS.causes) fail(`At most ${LENS_LIMITS.causes} causes`, 'causes');
  if (!Array.isArray(priorities) || priorities.length > LENS_LIMITS.priorities) fail(`At most ${LENS_LIMITS.priorities} priorities`, 'priorities');
  uniqueIds(causes, 'causes');
  uniqueIds(priorities, 'priorities');
  const normalizedCauses = causes.map((cause, index) => {
    const field = `causes[${index}]`;
    keys(cause, ['id', 'label', 'note', 'outcome', 'community', 'geography', 'origin', 'organization_ids'], field);
    // Organizations whose gifts count toward this cause (the person's own linking).
    const organizationIds = cause.organization_ids ?? [];
    if (!Array.isArray(organizationIds) || organizationIds.length > LENS_LIMITS.organizations || organizationIds.some(id => typeof id !== 'string' || !id)) {
      fail(`${field}.organization_ids must be a list of organizations`, field);
    }
    return {
      id: cause.id,
      label: text(cause.label, LENS_LIMITS.label, `${field}.label`, { required: true }),
      note: text(cause.note, LENS_LIMITS.note, `${field}.note`),
      outcome: text(cause.outcome, 300, `${field}.outcome`),
      community: text(cause.community, 300, `${field}.community`),
      geography: text(cause.geography, 300, `${field}.geography`),
      origin: origin(cause.origin, `${field}.origin`),
      organization_ids: [...new Set(organizationIds)].sort(),
    };
  });
  const normalizedPriorities = priorities.map((priority, index) => {
    const field = `priorities[${index}]`;
    keys(priority, ['id', 'label', 'note', 'must_have', 'origin'], field);
    if (priority.must_have != null && typeof priority.must_have !== 'boolean') fail(`${field}.must_have must be true or false`, field);
    return {
      id: priority.id,
      label: text(priority.label, LENS_LIMITS.label, `${field}.label`, { required: true }),
      note: text(priority.note, LENS_LIMITS.note, `${field}.note`),
      must_have: priority.must_have === true,
      origin: origin(priority.origin, `${field}.origin`),
    };
  });
  return {
    contract_version: GIVING_LENS_CONTRACT_VERSION,
    // Unranked: stored in id order so reordering never changes the hash.
    causes: normalizedCauses.sort((a, b) => a.id.localeCompare(b.id)),
    priorities: normalizedPriorities,
    reasoning: text(lens.reasoning, LENS_LIMITS.reasoning, 'reasoning'),
    dismissed: dismissedList(lens.dismissed),
  };
}

// Drafted suggestions the person rejected, so a later draft does not offer them again.
function dismissedList(value) {
  const list = value ?? [];
  if (!Array.isArray(list) || list.length > LENS_LIMITS.dismissed) fail(`At most ${LENS_LIMITS.dismissed} dismissed suggestions`, 'dismissed');
  const seen = new Map();
  for (const [index, entry] of list.entries()) {
    keys(entry, ['kind', 'label'], `dismissed[${index}]`);
    if (!['cause', 'hint'].includes(entry.kind)) fail(`dismissed[${index}].kind is unknown`, 'dismissed');
    const label = text(entry.label, LENS_LIMITS.label, `dismissed[${index}].label`, { required: true });
    seen.set(`${entry.kind}:${label.toLowerCase()}`, { kind: entry.kind, label });
  }
  return [...seen.values()].sort((a, b) => `${a.kind}:${a.label}`.localeCompare(`${b.kind}:${b.label}`));
}

export const isDismissed = (lens, kind, label) => (lens?.dismissed || []).some(entry => entry.kind === kind && entry.label.toLowerCase() === String(label).trim().toLowerCase());

export const lensHash = lens => snapshotHash(lens);
export const sameLens = (a, b) => canonicalJson(a) === canonicalJson(b);

// A model-drafted proposal from confirmed gifts. Every cited gift must exist; hints must be
// count-based observations, never inferred values. The proposal itself is never stored as the lens.
export function validateLensDraft(proposal, confirmedGiftIds) {
  keys(proposal, ['causes', 'hints'], 'draft');
  const known = new Set(confirmedGiftIds);
  const causes = proposal.causes ?? [];
  const hints = proposal.hints ?? [];
  if (!Array.isArray(causes) || causes.length > LENS_LIMITS.draftCauses) fail(`At most ${LENS_LIMITS.draftCauses} drafted causes`, 'causes');
  if (!Array.isArray(hints) || hints.length > LENS_LIMITS.draftHints) fail(`At most ${LENS_LIMITS.draftHints} hints`, 'hints');
  const cite = (ids, field) => {
    if (!Array.isArray(ids) || !ids.length) fail(`${field} must cite gifts`, field);
    for (const id of ids) if (!known.has(id)) fail(`${field} cites an unknown gift`, field);
    return [...new Set(ids)].sort();
  };
  return {
    causes: causes.map((cause, index) => {
      keys(cause, ['label', 'basis', 'gift_ids'], `causes[${index}]`);
      return {
        label: text(cause.label, LENS_LIMITS.label, `causes[${index}].label`, { required: true }),
        basis: text(cause.basis, 300, `causes[${index}].basis`, { required: true }),
        gift_ids: cite(cause.gift_ids, `causes[${index}].gift_ids`),
      };
    }),
    hints: hints.map((hint, index) => {
      keys(hint, ['label', 'count', 'of', 'gift_ids'], `hints[${index}]`);
      if (!Number.isInteger(hint.count) || !Number.isInteger(hint.of) || hint.count < 1 || hint.count > hint.of) {
        fail(`hints[${index}] needs a count basis (count of total)`, `hints[${index}]`);
      }
      return {
        label: text(hint.label, LENS_LIMITS.label, `hints[${index}].label`, { required: true }),
        count: hint.count,
        of: hint.of,
        gift_ids: cite(hint.gift_ids, `hints[${index}].gift_ids`),
      };
    }),
  };
}
