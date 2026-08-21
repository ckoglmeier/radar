import { query, withAtomicWrite } from '../db/index.js';
import { createDocument } from './documents.js';

export const FILE_VAULT_CATEGORIES = new Set([
  'life_insurance',
  'home_insurance',
  'auto_insurance',
  'umbrella_insurance',
  'estate',
  'tax',
  'identity',
  'investments',
  'other',
]);

const RELATED_ENTITY_TYPES = new Set(['investment', 'portfolio_entity']);

function cleanOptional(value) {
  const cleaned = String(value || '').trim();
  return cleaned || null;
}

export async function createVaultFile({
  title,
  category,
  relatedEntityType,
  relatedEntityId,
  relatedLabel,
  ownerName,
  documentDate,
  notes,
  filename,
  mime,
  content,
  executionMode,
}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('A document title is required');
  if (!FILE_VAULT_CATEGORIES.has(category)) throw new Error('Choose a valid file-vault category');
  const cleanRelatedType = cleanOptional(relatedEntityType);
  const cleanRelatedId = cleanOptional(relatedEntityId);
  if (cleanRelatedType && !RELATED_ENTITY_TYPES.has(cleanRelatedType)) {
    throw new Error('Choose a valid related record type');
  }
  if (Boolean(cleanRelatedType) !== Boolean(cleanRelatedId)) {
    throw new Error('Related record type and ID must be supplied together');
  }

  return withAtomicWrite(async () => {
    if (cleanRelatedType === 'investment') {
      const [record] = await query(`SELECT id FROM investments WHERE id::text = $1`, [cleanRelatedId]);
      if (!record) throw new Error('Related investment was not found');
    } else if (cleanRelatedType === 'portfolio_entity') {
      const [record] = await query(`SELECT id FROM portfolio_entities WHERE id::text = $1`, [cleanRelatedId]);
      if (!record) throw new Error('Related portfolio entity was not found');
    }
    const rows = await query(`
      INSERT INTO file_vault_entries
        (title, category, related_entity_type, related_entity_id, related_label,
         owner_name, document_date, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)
      RETURNING id, title, category, related_entity_type, related_entity_id,
                related_label, owner_name, document_date, notes, created_at
    `, [
      cleanTitle,
      category,
      cleanRelatedType,
      cleanRelatedId,
      cleanOptional(relatedLabel),
      cleanOptional(ownerName),
      cleanOptional(documentDate),
      cleanOptional(notes),
    ]);
    const entry = rows[0];
    const document = await createDocument({
      entity_type: 'file_vault_entry',
      entity_id: entry.id,
      filename,
      mime,
      content,
      source: 'manual-upload',
      confidentiality: 'personal_sensitive',
      processing_policy: 'local_only',
      sync_policy: 'encrypted_backup_allowed',
      executionMode,
    });
    return { ...entry, document };
  });
}

export async function listVaultFiles({ category, relatedEntityType, relatedEntityId } = {}) {
  if (category && !FILE_VAULT_CATEGORIES.has(category)) {
    throw new Error('Choose a valid file-vault category');
  }
  const cleanRelatedType = cleanOptional(relatedEntityType);
  const cleanRelatedId = cleanOptional(relatedEntityId);
  if (cleanRelatedType && !RELATED_ENTITY_TYPES.has(cleanRelatedType)) {
    throw new Error('Choose a valid related record type');
  }
  if (Boolean(cleanRelatedType) !== Boolean(cleanRelatedId)) {
    throw new Error('Related record type and ID must be supplied together');
  }
  return query(`
    SELECT e.id, e.title, e.category, e.related_entity_type,
           e.related_entity_id, e.related_label, e.owner_name,
           e.document_date, e.notes, e.created_at, d.id AS document_id,
           d.filename, d.mime, d.sha256, d.size_bytes, d.processing_policy,
           d.sync_policy
      FROM file_vault_entries e
      JOIN documents d
        ON d.entity_type = 'file_vault_entry'
       AND d.entity_id = e.id::text
     WHERE ($1::text IS NULL OR e.category = $1)
       AND ($2::text IS NULL OR (e.related_entity_type = $2 AND e.related_entity_id = $3))
     ORDER BY COALESCE(e.document_date, e.created_at::date) DESC, e.created_at DESC
  `, [category || null, cleanRelatedType, cleanRelatedId]);
}
