import { query } from '../db/index.js';

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

export async function createCommandThread({ title = 'Command' } = {}) {
  const [row] = await query(`
    INSERT INTO command_threads (title) VALUES ($1) RETURNING *
  `, [requiredText(title, 'Thread title')]);
  return row;
}

export async function getCommandThread(threadId) {
  const [thread] = await query('SELECT * FROM command_threads WHERE id = $1', [threadId]);
  if (!thread) return null;
  const messages = await query(`
    SELECT * FROM command_messages
     WHERE thread_id = $1
     ORDER BY created_at, id
  `, [threadId]);
  return { ...thread, messages };
}

export async function listCommandThreads({ limit = 50 } = {}) {
  return query(`
    SELECT t.*,
           (SELECT content FROM command_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS latest_message
      FROM command_threads t
     ORDER BY updated_at DESC, id DESC
     LIMIT $1
  `, [Math.max(1, Math.min(200, Number(limit) || 50))]);
}

export async function appendCommandMessage(threadId, fields = {}) {
  const role = requiredText(fields.role, 'Message role');
  if (!['user', 'assistant', 'system'].includes(role)) throw new TypeError(`invalid message role: ${role}`);
  const [message] = await query(`
    INSERT INTO command_messages
      (thread_id, role, content, result_kind, result, proposal_id, receipt_id)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
    RETURNING *
  `, [
    threadId,
    role,
    requiredText(fields.content, 'Message content'),
    fields.resultKind || null,
    fields.result == null ? null : JSON.stringify(fields.result),
    fields.proposalId || null,
    fields.receiptId || null,
  ]);
  await query('UPDATE command_threads SET updated_at = NOW() WHERE id = $1', [threadId]);
  return message;
}

export async function createCommandConfirmation(fields = {}) {
  const [row] = await query(`
    INSERT INTO command_confirmations
      (thread_id, proposal_id, command_set_hash, required_policy, expires_at)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (proposal_id, command_set_hash) DO UPDATE
      SET thread_id = COALESCE(command_confirmations.thread_id, EXCLUDED.thread_id)
    RETURNING *
  `, [
    fields.threadId || null,
    fields.proposalId,
    requiredText(fields.commandSetHash, 'Command-set hash'),
    requiredText(fields.requiredPolicy, 'Required policy'),
    fields.expiresAt || null,
  ]);
  return row;
}

export async function resolveCommandConfirmation(proposalId, commandSetHash, status) {
  if (!['confirmed', 'rejected', 'expired'].includes(status)) throw new TypeError(`invalid confirmation status: ${status}`);
  const [row] = await query(`
    UPDATE command_confirmations
       SET status = $3, resolved_at = NOW()
     WHERE proposal_id = $1 AND command_set_hash = $2 AND status = 'pending'
     RETURNING *
  `, [proposalId, commandSetHash, status]);
  return row || null;
}
