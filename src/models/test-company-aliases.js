import assert from 'node:assert/strict';
import { closeDb, query } from '../db/index.js';
import {
  companyPositions,
  resolveCompanyAlias,
  saveCompanyAlias,
} from './company-aliases.js';

const suffix = Date.now();
const canonical = `ScienceIO Alias Test ${suffix}`;
const alias = `Cascade.Bio Alias Test ${suffix}`;

await query(`
  INSERT INTO investments
    (company_name, status, invest_date, invested, asset_class, source)
  VALUES
    ($1, 'Live', '2023-01-01', 2500, 'direct', 'test'),
    ($1, 'Live', '2024-01-01', 1000, 'direct', 'test')
`, [canonical]);

const saved = await saveCompanyAlias({
  alias,
  canonicalCompanyName: canonical,
  provenanceSource: 'test',
  provenanceNote: 'Legal-name confirmation',
});
assert.equal(saved.canonical_company_name, canonical);

const resolved = await resolveCompanyAlias(alias);
assert.equal(resolved.canonical_company_name, canonical);

const company = await companyPositions(alias);
assert.equal(company.positions.length, 2);
assert.ok(company.positions.every(position => position.company_name === canonical));

await assert.rejects(
  () => saveCompanyAlias({ alias: canonical, canonicalCompanyName: canonical }),
  /must differ/,
);

console.log('company aliases: 5/5 passed');
await closeDb();
