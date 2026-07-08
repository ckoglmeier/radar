// Credential-mode selection + subprocess-env construction for the Agent SDK.
//
// This is the load-bearing security unit of Phase A. It is deliberately a
// pure, side-effect-free module: given an auth mode and a parent environment,
// it decides which credential the SDK subprocess should use and builds the
// exact `env` object handed to `query({ options: { env } })`.
//
// The Agent SDK's `env` option REPLACES the subprocess environment wholesale
// (it is not merged with process.env — verified in sdk.d.ts). So whatever we
// return here is the *complete* environment the `claude` CLI subprocess sees.
//
// A2 (auth_mode config + startup diagnostic) builds on top of these helpers:
// it reads RADAR_AUTH_MODE, calls `shadowGuard()` to fail loud before start,
// and reports the actually-winning credential (the SDK's init message exposes
// `apiKeySource`, which the diagnostic compares against the mode we selected).

// Credential env var names the `claude` CLI reads, in the CLI's own precedence
// order. ANTHROPIC_API_KEY wins over CLAUDE_CODE_OAUTH_TOKEN when both are
// present — which is exactly the billing-shadow risk this module defends
// against: a stray ANTHROPIC_API_KEY in the parent env would silently bill the
// API account instead of the subscription.
export const API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

export const AUTH_MODES = Object.freeze(['subscription', 'api_key']);

/**
 * Validate an auth mode, throwing on anything unrecognized.
 * @param {string} mode
 * @returns {'subscription'|'api_key'}
 */
export function assertAuthMode(mode) {
  if (!AUTH_MODES.includes(mode)) {
    throw new Error(
      `invalid auth mode: ${JSON.stringify(mode)} (expected one of: ${AUTH_MODES.join(', ')})`
    );
  }
  return mode;
}

/**
 * Fail-loud billing-shadow guard for subscription mode.
 *
 * Subscription mode MUST refuse to start if ANTHROPIC_API_KEY is present in the
 * parent env, because the CLI would prefer it over the OAuth token and silently
 * bill the wrong account. Stripping it from the child env (below) is necessary
 * but this guard is the *loud* half: it surfaces the misconfiguration instead of
 * quietly papering over it, so an operator who thinks they're on the
 * subscription learns their env is dirty.
 *
 * A2 calls this at startup for the shadow fail-loud acceptance criterion. It is
 * a no-op for api_key mode.
 *
 * @param {'subscription'|'api_key'} mode
 * @param {NodeJS.ProcessEnv} [parentEnv=process.env]
 * @throws if subscription mode and ANTHROPIC_API_KEY is set in parentEnv
 */
export function shadowGuard(mode, parentEnv = process.env) {
  assertAuthMode(mode);
  if (mode === 'subscription' && parentEnv[API_KEY_ENV]) {
    throw new Error(
      `subscription auth mode refuses to start: ${API_KEY_ENV} is present in the ` +
        `environment and would shadow the subscription OAuth token (silent ` +
        `billing to the API account). Unset ${API_KEY_ENV} to use the ` +
        `subscription, or set RADAR_AUTH_MODE=api_key to use the key.`
    );
  }
}

/**
 * Build the exact environment object for the SDK subprocess.
 *
 * Because the SDK `env` option replaces (not merges) the subprocess env, we
 * start from the parent env and then apply the credential invariant:
 *
 *  - subscription: DELETE ANTHROPIC_API_KEY so it cannot shadow the OAuth
 *    token. This is the whole point of the feature. The OAuth token itself
 *    lives in the local credential store / CLAUDE_CODE_OAUTH_TOKEN and is left
 *    untouched.
 *  - api_key: PRESERVE ANTHROPIC_API_KEY exactly as inherited.
 *
 * The returned object is a shallow copy — the caller's parentEnv is never
 * mutated.
 *
 * @param {'subscription'|'api_key'} mode
 * @param {NodeJS.ProcessEnv} [parentEnv=process.env]
 * @returns {Record<string, string|undefined>} env for `query` options
 */
export function buildSubprocessEnv(mode, parentEnv = process.env) {
  assertAuthMode(mode);
  const env = { ...parentEnv };

  if (mode === 'subscription') {
    // Strip the shadowing key. `delete` (not `= undefined`) so the var is
    // genuinely absent from the child env, matching the "must NOT be present"
    // invariant rather than being present-but-empty.
    delete env[API_KEY_ENV];
  }
  // api_key mode: leave ANTHROPIC_API_KEY as-is.

  return env;
}

/**
 * Describe the credential selection for diagnostics/logging.
 *
 * Never includes the secret value itself — only which env var is expected to
 * carry the credential and whether the shadowing key was stripped. A2's
 * startup diagnostic renders this alongside the SDK's reported `apiKeySource`.
 *
 * @param {'subscription'|'api_key'} mode
 * @param {NodeJS.ProcessEnv} [parentEnv=process.env]
 * @returns {{ mode: string, expectedCredentialEnv: string, strippedApiKey: boolean, apiKeyPresentInParent: boolean }}
 */
export function describeCredentialSelection(mode, parentEnv = process.env) {
  assertAuthMode(mode);
  const apiKeyPresentInParent = Boolean(parentEnv[API_KEY_ENV]);
  return {
    mode,
    expectedCredentialEnv: mode === 'subscription' ? OAUTH_TOKEN_ENV : API_KEY_ENV,
    strippedApiKey: mode === 'subscription' && apiKeyPresentInParent,
    apiKeyPresentInParent,
  };
}
