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
