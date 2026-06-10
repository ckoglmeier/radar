/**
 * analytics.js — JS bridge to the Python analytics sidecar.
 *
 * Generic interface: call any registered Python analytics module via
 * JSON-over-stdin/stdout. No temp files.
 *
 * Usage:
 *   import { runAnalytics } from '../utils/analytics.js';
 *   const result = runAnalytics('kelly', 'size_bet', { bet, portfolio });
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..');

/**
 * Call a Python analytics module method.
 *
 * @param {string} module   - Analytics module name (e.g., 'kelly')
 * @param {string} method   - Method name (e.g., 'size_bet')
 * @param {object} data     - Payload passed to the handler
 * @param {object} [opts]   - Options
 * @param {number} [opts.timeout=15000] - Timeout in ms
 * @returns {object} Parsed JSON result from Python
 * @throws {Error} On timeout, Python error, or invalid response
 */
export function runAnalytics(module, method, data, { timeout = 15000 } = {}) {
  const payload = JSON.stringify({ module, method, data });

  let raw;
  try {
    raw = execSync('python3 -m analytics', {
      input: payload,
      encoding: 'utf-8',
      timeout,
      cwd: SRC_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // execSync throws on non-zero exit or timeout
    if (err.killed) {
      throw new Error(`Analytics timed out after ${timeout}ms (module=${module}, method=${method})`);
    }
    // Try to extract structured error from stdout
    const stdout = err.stdout?.toString() || '';
    if (stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          throw new Error(`Analytics error [${parsed.type || 'Error'}]: ${parsed.error}`);
        }
      } catch (parseErr) {
        if (parseErr.message.startsWith('Analytics error')) throw parseErr;
      }
    }
    const stderr = err.stderr?.toString() || '';
    throw new Error(
      `Python analytics failed (module=${module}, method=${method}): ${stderr || err.message}`
    );
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Python analytics returned empty response (module=${module}, method=${method})`);
  }

  let result;
  try {
    result = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `Python analytics returned invalid JSON (module=${module}, method=${method}): ${trimmed.slice(0, 500)}`
    );
  }

  if (result.error) {
    throw new Error(`Analytics error [${result.type || 'Error'}]: ${result.error}`);
  }

  return result;
}
