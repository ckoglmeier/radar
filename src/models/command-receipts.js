import { query } from '../db/index.js';

function json(value) {
  return JSON.stringify(value);
}

export async function createCommandReceipt({ id, proposalId = null, parentReceiptId = null, receipt, undoState }) {
  const [row] = await query(`
    INSERT INTO command_receipts (id, proposal_id, parent_receipt_id, receipt, undo_state)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
    RETURNING *
  `, [id, proposalId, parentReceiptId, json(receipt), json(undoState)]);
  return row;
}

export async function getCommandReceipt(receiptId, { lock = false } = {}) {
  const [row] = await query(`
    SELECT * FROM command_receipts WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}
  `, [receiptId]);
  return row || null;
}

export async function markCommandReceiptUndone(receiptId, undoReceiptId) {
  const [row] = await query(`
    UPDATE command_receipts
       SET undone_at = NOW(), undo_receipt_id = $2
     WHERE id = $1 AND undone_at IS NULL
     RETURNING *
  `, [receiptId, undoReceiptId]);
  return row || null;
}
