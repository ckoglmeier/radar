import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  appendCommandMessage,
  createCommandThread,
  getCommandThread,
  listCommandThreads,
  updateCommandThreadTitle,
} from './command-conversations.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-command-conversations-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const thread = await createCommandThread();
    await appendCommandMessage(thread.id, { role: 'user', content: 'Rank my positions.' });
    await appendCommandMessage(thread.id, {
      role: 'assistant', content: 'Three positions ranked.', resultKind: 'question',
      result: { kind: 'position_analysis' },
    });
    await updateCommandThreadTitle(thread.id, 'Position returns');
    const loaded = await getCommandThread(thread.id);
    assert.equal(loaded.title, 'Position returns');
    assert.deepEqual(loaded.messages.map(message => message.role), ['user', 'assistant']);
    const listed = await listCommandThreads();
    assert.equal(listed[0].id, thread.id);
    assert.equal(listed[0].latest_message, 'Three positions ranked.');
    assert.equal(listed[0].latest_result_kind, 'question');
  });
  console.log('command conversations: durable messages, titles, and recent threads passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
