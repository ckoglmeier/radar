// auth-mode.js — Phase A2: RADAR_AUTH_MODE resolution + startup diagnostic.
//
// Builds on credentials.js. Four responsibilities, all secret-free (this module
// never reads or logs a token/key value):
//   1. Resolve RADAR_AUTH_MODE (default api_key).
//   2. Fail loud before start on a billing shadow (shadowGuard, from A1).
//   3. Single-user gate: the subscription OAuth path is licensed for
//      single-user/local use only — refuse it under a hosted/multi-user
//      RADAR_MODE.
//   4. Report the credential that ACTUALLY won: compare the SDK init message's
//      apiKeySource against the selected mode (a live probe) and refuse on a
//      mismatch, so there is never a silent billing surprise.

import {
  assertAuthMode,
  shadowGuard,
  describeCredentialSelection,
} from './credentials.js';

export const AUTH_MODE_ENV = 'RADAR_AUTH_MODE';
export const RADAR_MODE_ENV = 'RADAR_MODE';
export const DEFAULT_AUTH_MODE = 'api_key';

/**
 * Resolve the configured auth mode. Unset/empty → the safe default (api_key).
 * Throws on an unrecognized value rather than silently defaulting, so a typo
 * (RADAR_AUTH_MODE=subscribe) fails loud instead of quietly billing the API.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {'subscription'|'api_key'}
 */
export function resolveAuthMode(env = process.env) {
  const raw = env[AUTH_MODE_ENV];
  if (raw == null || raw === '') return DEFAULT_AUTH_MODE;
  return assertAuthMode(raw);
}

/**
 * Single-user gate. Subscription/OAuth is licensed for single-user/local use
 * only, so it is refused under any explicit non-local RADAR_MODE (a hosted or
 * multi-user deployment must use api_key). Local/CLI/desktop — RADAR_MODE unset
 * or 'local' — is allowed; that is the intended (and only licensed) way to bill
 * a personal subscription. No-op for api_key mode.
 * @param {'subscription'|'api_key'} mode
 * @param {NodeJS.ProcessEnv} [env=process.env]
 */
export function assertSubscriptionAllowed(mode, env = process.env) {
  if (mode !== 'subscription') return;
  const radarMode = env[RADAR_MODE_ENV];
  if (radarMode && radarMode !== 'local') {
    throw new Error(
      `subscription auth mode is not permitted with ${RADAR_MODE_ENV}=${radarMode}: ` +
        `the subscription OAuth path is licensed for single-user/local use only. ` +
        `Use RADAR_AUTH_MODE=api_key for hosted or multi-user deployments.`
    );
  }
}

/**
 * Validate auth configuration at startup: resolve the mode and run the two
 * fail-loud guards (billing shadow + single-user). Returns the resolved mode and
 * a secret-free selection descriptor. Does NOT touch the network — the live
 * credential probe is separate (probeActiveCredential / verifyActualCredential).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ mode: 'subscription'|'api_key', selection: object }}
 */
export function validateAuthStartup(env = process.env) {
  const mode = resolveAuthMode(env);
  shadowGuard(mode, env);
  assertSubscriptionAllowed(mode, env);
  return { mode, selection: describeCredentialSelection(mode, env) };
}

/**
 * Is the SDK's reported apiKeySource consistent with the selected mode?
 * 'oauth' is the subscription token; anything else is an API key.
 * @param {'subscription'|'api_key'} mode
 * @param {string} apiKeySource
 * @returns {boolean}
 */
// The init `apiKeySource` values that mean an ANTHROPIC_API_KEY was actually used
// (billed to the API account). Anything else — `none` (verified via live e2e:
// the subscription OAuth token bills with no API key, so the source is 'none')
// or `oauth` — means the API key was NOT used.
export const API_KEY_SOURCES = Object.freeze(['user', 'project', 'org', 'temporary']);

/** Did the SDK actually authenticate with an ANTHROPIC_API_KEY? */
export function usedApiKey(apiKeySource) {
  return API_KEY_SOURCES.includes(apiKeySource);
}

export function isApiKeySourceConsistent(mode, apiKeySource) {
  // subscription: the API key must NOT have been used (any non-key source is fine).
  // api_key: an API key MUST have been used.
  return mode === 'subscription' ? !usedApiKey(apiKeySource) : usedApiKey(apiKeySource);
}

/**
 * Verify the credential that ACTUALLY won (from a live SDK init apiKeySource)
 * matches the selected mode. Throws on a mismatch — the "no silent billing
 * surprise" acceptance criterion (e.g. subscription selected but the SDK
 * authenticated with an API key anyway). Returns a verdict on success.
 * @param {'subscription'|'api_key'} mode
 * @param {string} apiKeySource
 * @returns {{ mode: string, apiKeySource: string, ok: true }}
 */
export function verifyActualCredential(mode, apiKeySource) {
  assertAuthMode(mode);
  if (!isApiKeySourceConsistent(mode, apiKeySource)) {
    const detail =
      mode === 'subscription'
        ? `selected subscription mode but the SDK authenticated with an API key (apiKeySource='${apiKeySource}') — this bills the API account`
        : `selected api_key mode but the SDK did not use an API key (apiKeySource='${apiKeySource}')`;
    throw new Error(`credential mismatch: ${detail}. Refusing to proceed.`);
  }
  return { mode, apiKeySource, ok: true };
}

/**
 * Probe the actually-winning credential by running a trivial SDK session and
 * reading the init message's apiKeySource. Requires a real credential + the
 * `claude` CLI — a RUNTIME diagnostic, not a unit test.
 * @param {import('./model-provider.js').ModelProvider} provider
 * @returns {Promise<string|null>} e.g. 'oauth', 'user'
 */
export async function probeActiveCredential(provider) {
  const res = await provider.runSession({ prompt: 'Reply with OK.', maxTurns: 1, tools: [] });
  return res.apiKeySource ?? null;
}

/**
 * One-line, secret-free status string for CLI/status output. Never renders a
 * token or key value — only the mode, which credential is expected, whether the
 * shadowing key was stripped, and (if probed) the verified active credential.
 * @param {'subscription'|'api_key'} mode
 * @param {object} selection describeCredentialSelection() output
 * @param {string|null} [apiKeySource] a probed init apiKeySource, if available
 * @returns {string}
 */
export function formatAuthStatus(mode, selection, apiKeySource = null) {
  const cred = mode === 'subscription' ? 'OAuth subscription token' : 'ANTHROPIC_API_KEY';
  const shadow = selection?.strippedApiKey ? '; ANTHROPIC_API_KEY stripped from subprocess' : '';
  // Render the probed source as a human label, not the raw enum ('none' reads as
  // a failure but is the correct subscription result — no API key was used).
  let verified = ' — not yet probed';
  if (apiKeySource != null) {
    verified = usedApiKey(apiKeySource)
      ? ` — verified: billing an API key (source: ${apiKeySource})`
      : ' — verified: billing your subscription (no API key used)';
  }
  return `auth: ${mode} (${cred}${shadow})${verified}`;
}
