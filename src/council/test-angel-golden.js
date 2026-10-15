// Angel-unchanged guard for Earned Equity work. A fixed personalized dry run
// must keep byte-identical prompts, schemas and fingerprints, and the request
// key for existing review modes must not move. Update the constants only for
// a separately reviewed angel change, never as a side effect of a new lens.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { councilEvaluate } from './evaluate.js';
import { loadLens, withLens } from '../lenses/loader.js';
import { councilRequestKey } from '../models/council-runs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const GOLDEN = {
  requests: '9098de2d16d94d61bf71cea7f770f02db54d410968da52cfb02d1f20a517693c',
  instructionHash: '0e1d2e292341bdb62300adcedbda1008d9aa9da1bbb2248934f393b1b80d87bc',
  runKey: '55f564f4efae358b08f4f4d2e98fa08ad2357137712f0647ed56805661836b2b',
  personalizedRequestKey: 'cff50ee59c3dc3295de63245a1a9c4a043bbea6b0fcb67a9d1efbbad0c861dcd',
  adHocRequestKey: '234ce3ed0b51cc6f021a116ffc9d51c55776527750ae189023eff34bd978148e',
};

const deal = {
  company: 'Golden Fixture Robotics',
  stage: 'seed',
  round: 'seed',
  sector: 'industrial automation',
  description: 'Synthetic fixture for the angel-unchanged guard.',
  valuation_usd: 20000000,
  min_investment_usd: 5000,
};
const calibrationSnapshot = { maturity: 'cold_start', investLine: 70, sampleSize: 0 };

const out = await withLens(loadLens(join(root, 'lenses', '_template')), () => councilEvaluate(deal, {
  dryRun: true,
  env: {},
  calibrationSnapshot,
  executionId: 'golden-fixture',
  sourceManifest: [],
}));

const actual = {
  requests: sha(out.requests),
  instructionHash: out.provenance.instructionHash,
  runKey: out.provenance.runKey,
  personalizedRequestKey: councilRequestKey({ pipelineInviteId: 1, sourceHash: 'golden', modelPolicy: 'p', policyVersion: '9' }),
  adHocRequestKey: councilRequestKey({ pipelineInviteId: 1, sourceHash: 'golden', modelPolicy: 'p', policyVersion: '9', reviewMode: 'ad_hoc' }),
};

if (process.env.RADAR_RECORD_GOLDEN === '1') {
  console.log(JSON.stringify(actual, null, 2));
} else {
  assert.deepEqual(actual, GOLDEN);
  console.log('Angel golden guard: personalized prompts, fingerprints and request keys unchanged');
}
