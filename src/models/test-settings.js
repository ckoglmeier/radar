#!/usr/bin/env node

import {
  getUserSettings,
  updateUserSettings,
  setOnboarded,
} from './settings.js';
import { query } from '../db/index.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function cleanup(userId) {
  await query(`DELETE FROM user_settings WHERE user_id = $1`, [userId]);
}

async function run() {
  const userId = `test-user-${Date.now()}`;

  try {
    await test('getUserSettings creates a default row lazily', async () => {
      const settings = await getUserSettings(userId);
      eq(settings.user_id, userId);
      eq(settings.onboarded, false);
      eq(settings.onboarding_track, null);
    });

    await test('setOnboarded persists durable onboarding state', async () => {
      const updated = await setOnboarded(userId, true, 'portfolio');
      eq(updated.onboarded, true);
      eq(updated.onboarding_track, 'portfolio');

      const settings = await getUserSettings(userId);
      eq(settings.onboarded, true);
      eq(settings.onboarding_track, 'portfolio');
    });

    await test('updateUserSettings can change the onboarding track only', async () => {
      const updated = await updateUserSettings(userId, {
        onboarding_track: 'theses',
      });
      eq(updated.onboarded, true);
      eq(updated.onboarding_track, 'theses');
    });

    await test('Private Beta acknowledgements are versioned and durable', async () => {
      const updated = await updateUserSettings(userId, {
        beta_setup_version: 1,
        beta_setup_completed_at: '2026-08-27T22:00:00Z',
        provider_egress_disclosure_version: 1,
        provider_egress_disclosure_acknowledged_at: '2026-08-27T22:01:00Z',
        update_disclosure_version: 1,
        update_disclosure_acknowledged_at: '2026-08-27T22:02:00Z',
      });
      eq(updated.beta_setup_version, 1);
      eq(updated.provider_egress_disclosure_version, 1);
      eq(updated.update_disclosure_version, 1);
      eq(updated.beta_setup_completed_at instanceof Date, true);

      const reloaded = await getUserSettings(userId);
      eq(reloaded.provider_egress_disclosure_version, 1);
    });

    await test('Private Beta acknowledgement fields fail closed', async () => {
      let invalidVersion = false;
      try {
        await updateUserSettings(userId, { beta_setup_version: -1 });
      } catch (error) {
        invalidVersion = /non-negative integer/.test(error.message);
      }
      eq(invalidVersion, true);

      let invalidTime = false;
      try {
        await updateUserSettings(userId, { update_disclosure_acknowledged_at: 'not-a-date' });
      } catch (error) {
        invalidTime = /ISO timestamp/.test(error.message);
      }
      eq(invalidTime, true);
    });

    await test('updateUserSettings rejects empty updates', async () => {
      let rejected = false;
      try {
        await updateUserSettings(userId, {});
      } catch (err) {
        rejected = /no user settings fields/.test(err.message);
      }
      eq(rejected, true);
    });
  } finally {
    await cleanup(userId);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
