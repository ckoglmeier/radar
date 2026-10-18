import { randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import { validateInterests, validateBusinessPreferences, snapshotHash } from '../angel/personal-context.js';
import { validateLens } from '../giving/lens.js';
import { CommandError } from '../commands/errors.js';

const workspace = value => { if (typeof value !== 'string' || !value.trim()) throw new CommandError('WORKSPACE_REQUIRED', 'A workspace is required.'); return value; };
const categoryOf = value => { if (!['angel', 'giving'].includes(value)) throw new CommandError('PRECONDITION_FAILED', 'Choose Angel or Giving.'); return value; };
const row = value => value && ({ ...value, payload: typeof value.payload === 'string' ? JSON.parse(value.payload) : value.payload });
export function validateAnalysisLens(category, payload) {
  categoryOf(category);
  if (category === 'giving') return validateLens(payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['interests', 'business'].includes(key))) throw new CommandError('PRECONDITION_FAILED', 'An Angel lens contains interests and business preferences only, not deal facts.');
  return { interests: validateInterests(payload.interests ?? []), business: validateBusinessPreferences(payload.business ?? []) };
}
export async function listAnalysisLenses({ workspaceId, category }) {
  return (await query('SELECT * FROM analysis_lenses WHERE workspace_id = $1 AND category = $2 ORDER BY created_at, id', [workspace(workspaceId), categoryOf(category)])).map(row);
}
export async function getAnalysisLens({ workspaceId, category, lensId }) {
  return row((await query('SELECT * FROM analysis_lenses WHERE workspace_id = $1 AND category = $2 AND id = $3', [workspace(workspaceId), categoryOf(category), String(lensId)]))[0]);
}
export async function saveAnalysisLens({ workspaceId, category, name, payload, lensId = randomUUID() }) {
  const owner = workspace(workspaceId); categoryOf(category);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new CommandError('PRECONDITION_FAILED', 'Name this lens (up to 80 characters).');
  const normalized = validateAnalysisLens(category, payload);
  const sha256 = snapshotHash(normalized);
  const previous = await getAnalysisLens({ workspaceId: owner, category, lensId });
  if (previous) {
    if (previous.sha256 !== sha256 || previous.name !== name.trim()) throw new CommandError('PRECONDITION_FAILED', 'This saved lens has different contents. Choose a new name.');
    return previous;
  }
  if ((await query('SELECT id FROM analysis_lenses WHERE workspace_id=$1 AND category=$2 AND lower(name)=lower($3)', [owner, category, name.trim()])).length) throw new CommandError('PRECONDITION_FAILED', 'A lens with that name already exists. Choose a different name.');
  return row((await query('INSERT INTO analysis_lenses (id,workspace_id,category,name,payload,sha256) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *', [lensId, owner, category, name.trim(), JSON.stringify(normalized), sha256]))[0]);
}
