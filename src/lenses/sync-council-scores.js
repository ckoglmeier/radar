/**
 * Reads all deal-log markdown files and updates council fields in deal_evaluations.
 * Matches rows by file_path. Only updates rows that already exist (no inserts).
 * Safe to re-run — idempotent.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { query } from '../db/index.js';

const DEAL_LOG_DIR = process.env.DEAL_LOG_DIR || null;

export function parseCouncil(content) {
  let council_bull = null, council_bear = null, council_calibrator = null;
  let council_cfo_verdict = null;

  const bullMatch = content.match(/\|\s*\*{0,2}Bull\*{0,2}\s*\|\s*\*{0,2}(\d+(?:\.\d+)?)\s*\/\s*50\*{0,2}/i);
  if (bullMatch) council_bull = parseFloat(bullMatch[1]);

  const bearMatch = content.match(/\|\s*\*{0,2}Bear\*{0,2}\s*\|\s*\*{0,2}(\d+(?:\.\d+)?)\s*\/\s*50\*{0,2}/i);
  if (bearMatch) council_bear = parseFloat(bearMatch[1]);

  const calMatch = content.match(/\|\s*\*{0,2}Calibrator\*{0,2}\s*\|\s*\*{0,2}(\d+(?:\.\d+)?)\s*\/\s*50\*{0,2}/i);
  if (calMatch) council_calibrator = parseFloat(calMatch[1]);

  const cfoTable = content.match(/\|\s*\*{0,2}CFO\*{0,2}\s*\|\s*[—\-]+\s*\|\s*\*{0,2}(Deploy|Defer|Pass)\*{0,2}/i);
  if (cfoTable) {
    council_cfo_verdict = cfoTable[1];
  } else {
    const cfoSection = content.match(/CFO\s*\(Portfolio Construction\)[\s\S]*?Verdict:\s*(Deploy|Defer|Pass)/i);
    if (cfoSection) council_cfo_verdict = cfoSection[1];
  }

  if (!council_bull && !council_bear && !council_calibrator && !council_cfo_verdict) return null;

  let council_spread = null, council_consensus = null, council_divergence = null;
  const scores = [council_bull, council_bear, council_calibrator].filter(s => s != null);
  if (scores.length >= 2) {
    council_spread = Math.max(...scores) - Math.min(...scores);
    council_consensus = scores.reduce((a, b) => a + b, 0) / scores.length;
    council_divergence = council_spread > 10 ? 'HIGH' : council_spread > 5 ? 'MODERATE' : 'LOW';
  }

  return { council_bull, council_bear, council_calibrator, council_spread, council_consensus, council_divergence, council_cfo_verdict };
}

export async function syncCouncilScores(dir = DEAL_LOG_DIR) {
  if (!dir) {
    throw new Error('DEAL_LOG_DIR is not set. Add it to .env (path to your deal-log markdown directory).');
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  let updated = 0, skipped = 0, noData = 0;

  for (const file of files) {
    const filePath = join(dir, file);
    const content = readFileSync(filePath, 'utf8');
    const council = parseCouncil(content);

    if (!council) { noData++; continue; }

    const rows = await query(
      `UPDATE deal_evaluations
       SET council_bull_score = $1, council_bear_score = $2, council_calibrator_score = $3,
           council_spread = $4, council_consensus = $5, council_divergence = $6, council_cfo_verdict = $7
       WHERE file_path = $8
       RETURNING id`,
      [council.council_bull, council.council_bear, council.council_calibrator,
       council.council_spread, council.council_consensus, council.council_divergence,
       council.council_cfo_verdict, filePath]
    );

    if (rows.length > 0) {
      updated++;
    } else {
      skipped++;
    }
  }

  return { updated, skipped, noData, total: files.length };
}
