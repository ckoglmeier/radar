import { query } from '../db/index.js';

const DEFAULT_USER_ID = 'default';
const SETTINGS_FIELDS = [
  'onboarded',
  'onboarding_track',
  'beta_setup_version',
  'beta_setup_completed_at',
  'beta_setup_dismissed_version',
  'beta_setup_dismissed_at',
  'provider_egress_disclosure_version',
  'provider_egress_disclosure_acknowledged_at',
  'update_disclosure_version',
  'update_disclosure_acknowledged_at',
];

const VERSION_FIELDS = new Set([
  'beta_setup_version',
  'beta_setup_dismissed_version',
  'provider_egress_disclosure_version',
  'update_disclosure_version',
]);

const TIMESTAMP_FIELDS = new Set([
  'beta_setup_completed_at',
  'beta_setup_dismissed_at',
  'provider_egress_disclosure_acknowledged_at',
  'update_disclosure_acknowledged_at',
]);

function normalizeUserId(userId) {
  return userId || DEFAULT_USER_ID;
}

function buildAssignments(fields, startIndex = 2) {
  const clauses = [];
  const params = [];
  let nextIndex = startIndex;

  for (const field of SETTINGS_FIELDS) {
    if (!(field in fields)) continue;
    if (VERSION_FIELDS.has(field) && fields[field] != null
        && (!Number.isSafeInteger(fields[field]) || fields[field] < 0)) {
      throw new TypeError(`${field} must be a non-negative integer or null`);
    }
    if (TIMESTAMP_FIELDS.has(field) && fields[field] != null
        && !Number.isFinite(Date.parse(fields[field]))) {
      throw new TypeError(`${field} must be an ISO timestamp or null`);
    }
    clauses.push(`${field} = $${nextIndex++}`);
    params.push(fields[field] ?? null);
  }

  return { clauses, params, nextIndex };
}

export async function getUserSettings(userId = DEFAULT_USER_ID) {
  const id = normalizeUserId(userId);
  const rows = await query(
    `SELECT * FROM user_settings WHERE user_id = $1 LIMIT 1`,
    [id]
  );

  if (rows.length > 0) return rows[0];

  const inserted = await query(
    `INSERT INTO user_settings (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [id]
  );
  return inserted[0];
}

export async function updateUserSettings(userId = DEFAULT_USER_ID, fields = {}) {
  const id = normalizeUserId(userId);
  const { clauses, params, nextIndex } = buildAssignments(fields);
  if (clauses.length === 0) throw new Error('no user settings fields to update');

  const rows = await query(`
    INSERT INTO user_settings (user_id)
    VALUES ($1)
    ON CONFLICT (user_id) DO UPDATE SET
      ${clauses.join(', ')},
      updated_at = NOW()
    RETURNING *
  `, [id, ...params]);

  return rows[0];
}

export async function setOnboarded(userId = DEFAULT_USER_ID, onboarded = true, onboardingTrack = null) {
  return updateUserSettings(userId, {
    onboarded,
    onboarding_track: onboardingTrack,
  });
}
