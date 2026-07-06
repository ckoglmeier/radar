import { query } from '../db/index.js';

const ROOM_FIELDS = ['name', 'cols'];
const HOLDING_FIELDS = ['investment_id', 'cells'];
const PIPELINE_FIELDS = ['pipeline_invite_id', 'cells'];
const VIEW_FIELDS = ['name', 'cols', 'cells'];

function normalizeField(field, value) {
  if (value === undefined) return undefined;
  if (field === 'cols' || field === 'cells') {
    return value == null ? null : JSON.stringify(value);
  }
  return value ?? null;
}

function buildAssignments(fields, allowed, startIndex = 1) {
  const clauses = [];
  const params = [];
  let nextIndex = startIndex;

  for (const field of allowed) {
    if (!(field in fields)) continue;
    const value = normalizeField(field, fields[field]);
    if (value === undefined) continue;
    const cast = field === 'cols' || field === 'cells' ? '::jsonb' : '';
    clauses.push(`${field} = $${nextIndex++}${cast}`);
    params.push(value);
  }

  return { clauses, params, nextIndex };
}

function assertHasFields(clauses, message) {
  if (clauses.length === 0) throw new Error(message);
}

async function getExistingRoom(id) {
  const rows = await query(`SELECT id FROM rooms WHERE id = $1 LIMIT 1`, [id]);
  if (rows.length === 0) {
    throw new Error(`room not found: ${id}`);
  }
}

export async function createRoom(fields = {}) {
  const { clauses, params } = buildAssignments(fields, ROOM_FIELDS);
  assertHasFields(clauses, 'no room fields to create');

  const columns = clauses.map(clause => clause.split(' = ')[0]);
  const placeholders = columns.map((column, index) => (
    column === 'cols' ? `$${index + 1}::jsonb` : `$${index + 1}`
  ));

  const rows = await query(`
    INSERT INTO rooms (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `, params);
  return rows[0];
}

export async function addHolding(roomId, fields = {}) {
  await getExistingRoom(roomId);
  const { clauses, params } = buildAssignments(fields, HOLDING_FIELDS, 2);
  const columns = ['room_id'];
  const placeholders = ['$1'];
  const values = [roomId];

  for (let i = 0; i < clauses.length; i++) {
    const column = clauses[i].split(' = ')[0];
    columns.push(column);
    placeholders.push(column === 'cells' ? `$${i + 2}::jsonb` : `$${i + 2}`);
    values.push(params[i]);
  }

  const rows = await query(`
    INSERT INTO room_holdings (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `, values);
  return rows[0];
}

export async function addPipelineItem(roomId, fields = {}) {
  await getExistingRoom(roomId);
  const { clauses, params } = buildAssignments(fields, PIPELINE_FIELDS, 2);
  const columns = ['room_id'];
  const placeholders = ['$1'];
  const values = [roomId];

  for (let i = 0; i < clauses.length; i++) {
    const column = clauses[i].split(' = ')[0];
    columns.push(column);
    placeholders.push(column === 'cells' ? `$${i + 2}::jsonb` : `$${i + 2}`);
    values.push(params[i]);
  }

  const rows = await query(`
    INSERT INTO room_pipeline (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `, values);
  return rows[0];
}

export async function addView(roomId, fields = {}) {
  await getExistingRoom(roomId);
  const { clauses, params } = buildAssignments(fields, VIEW_FIELDS, 2);
  assertHasFields(clauses, 'no room view fields to create');

  const columns = ['room_id'];
  const placeholders = ['$1'];
  const values = [roomId];

  for (let i = 0; i < clauses.length; i++) {
    const column = clauses[i].split(' = ')[0];
    columns.push(column);
    placeholders.push(column === 'cols' || column === 'cells' ? `$${i + 2}::jsonb` : `$${i + 2}`);
    values.push(params[i]);
  }

  const rows = await query(`
    INSERT INTO room_views (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `, values);
  return rows[0];
}

export async function updateView(id, fields = {}) {
  const { clauses, params, nextIndex } = buildAssignments(fields, VIEW_FIELDS);
  assertHasFields(clauses, 'no room view fields to update');
  clauses.push('updated_at = NOW()');
  params.push(id);

  const rows = await query(`
    UPDATE room_views
    SET ${clauses.join(', ')}
    WHERE id = $${nextIndex}
    RETURNING *
  `, params);
  if (rows.length === 0) {
    throw new Error(`room view not found: ${id}`);
  }
  return rows[0];
}

export async function deleteView(id) {
  const rows = await query(
    `DELETE FROM room_views WHERE id = $1 RETURNING id`,
    [id]
  );
  return rows.length > 0;
}

export async function listRooms() {
  return query(`
    SELECT *
    FROM rooms
    ORDER BY updated_at DESC, id DESC
  `);
}

export async function getRoom(id) {
  const rooms = await query(
    `SELECT * FROM rooms WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (rooms.length === 0) return null;

  const [holdings, pipeline, views] = await Promise.all([
    query(`
      SELECT *
      FROM room_holdings
      WHERE room_id = $1
      ORDER BY id ASC
    `, [id]),
    query(`
      SELECT *
      FROM room_pipeline
      WHERE room_id = $1
      ORDER BY id ASC
    `, [id]),
    query(`
      SELECT *
      FROM room_views
      WHERE room_id = $1
      ORDER BY id ASC
    `, [id]),
  ]);

  return {
    ...rooms[0],
    holdings,
    pipeline,
    views,
  };
}
