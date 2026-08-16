import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { apiCommandMetadata, apiPreviewCommand, mcpCommandTools } from './adapters.js';
import { commandMetadata, previewCommand } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-command-adapters-'));
try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const [direct] = await query(`
      INSERT INTO investments (company_name, status, invested, source, asset_class)
      VALUES ('Adapter Fixture', 'Live', 100, 'manual', 'direct') RETURNING id
    `);
    assert.deepEqual(apiCommandMetadata(), commandMetadata());
    const tools = mcpCommandTools();
    assert.equal(tools.length, commandMetadata().commands.length);
    assert.deepEqual(tools.find(tool => tool.command.name === 'direct.record_valuation').inputSchema,
      commandMetadata().commands.find(command => command.name === 'direct.record_valuation').inputSchema);
    const candidate = {
      name: 'direct.record_valuation', version: 1,
      input: { investmentId: direct.id, date: '2026-06-30', unrealizedValue: 150, currency: 'USD' },
    };
    const engine = await previewCommand(candidate);
    const api = await apiPreviewCommand(candidate.name, candidate);
    assert.deepEqual(api.command.input, engine.command.input);
    assert.deepEqual(api.command.target, engine.command.target);
    assert.deepEqual(api.preview, engine.preview);
    assert.equal(api.command.precondition_hash, engine.command.precondition_hash);
  });
  console.log('Command adapter parity tests passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
