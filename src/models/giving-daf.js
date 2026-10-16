import { randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import { CommandError } from '../commands/errors.js';
import { dateOnly } from '../utils/date-only.js';
import { validateDafBalance, projectDafPlan } from '../giving/daf.js';
const workspace = value => {
  if (typeof value !== 'string' || !value.trim()) throw new CommandError('WORKSPACE_REQUIRED', 'A workspace is required.');
  return value;
};
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const balanceRow = row => row && ({ ...row, as_of: dateOnly(row.as_of), seq: Number(row.seq), ...Object.fromEntries(['total_cents', 'available_cents', 'pending_cents', 'invested_cents'].map(key => [key, row[key] == null ? null : Number(row[key])])) });
const planRow = row => row && ({ ...row, assumptions: json(row.assumptions), projection: json(row.projection), seq: Number(row.seq) });
async function transition(workspaceId, subjectType, id) {
  await query('INSERT INTO giving_transitions(id,workspace_id,subject_type,subject_id,action) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), workspaceId, subjectType, id, 'saved']);
}
export async function recordDafBalance({ workspaceId, balance }) {
  const ws = workspace(workspaceId);
  const b = validateDafBalance(balance);
  const [row] = await query(`INSERT INTO giving_daf_balances
    (id,workspace_id,account_ref,account_name,source,as_of,total_cents,available_cents,invested_cents,pending_cents)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
  [randomUUID(), ws, b.account_ref, b.account_name, b.source, b.as_of, b.total_cents, b.available_cents, b.invested_cents, b.pending_cents]);
  await transition(ws, 'daf_balance', row.id);
  return balanceRow(row);
}
export async function getDafBalance({ workspaceId, balanceId }) {
  const [row] = await query('SELECT * FROM giving_daf_balances WHERE workspace_id=$1 AND id=$2', [workspace(workspaceId), balanceId]);
  return balanceRow(row);
}
export async function listDafAccounts({ workspaceId }) {
  return (await query(`SELECT DISTINCT ON (account_ref) * FROM giving_daf_balances
    WHERE workspace_id=$1 ORDER BY account_ref,as_of DESC,seq DESC`, [workspace(workspaceId)])).map(balanceRow);
}
export async function listDafBalanceHistory({ workspaceId, accountRef }) {
  return (await query(`SELECT * FROM giving_daf_balances WHERE workspace_id=$1 AND account_ref=$2
    ORDER BY as_of DESC,seq DESC LIMIT 20`, [workspace(workspaceId), accountRef])).map(balanceRow);
}
export async function saveDafPlan({ workspaceId, balanceId, assumptions }) {
  const ws = workspace(workspaceId);
  const balance = await getDafBalance({ workspaceId: ws, balanceId });
  if (!balance) throw new CommandError('TARGET_NOT_FOUND', 'This Daffy balance was not found.');
  const projection = projectDafPlan(balance, assumptions);
  const [row] = await query(`INSERT INTO giving_daf_plans (id,workspace_id,balance_id,assumptions,projection)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING *`,
  [randomUUID(), ws, balanceId, JSON.stringify(projection.assumptions), JSON.stringify(projection)]);
  await transition(ws, 'daf_plan', row.id);
  return planRow(row);
}
export async function latestDafPlan({ workspaceId, accountRef }) {
  const [row] = await query(`SELECT p.* FROM giving_daf_plans p JOIN giving_daf_balances b ON b.id=p.balance_id AND b.workspace_id=p.workspace_id
    WHERE p.workspace_id=$1 AND b.account_ref=$2 ORDER BY p.seq DESC LIMIT 1`, [workspace(workspaceId), accountRef]);
  return planRow(row);
}
