// session-errors.js — Phase A3 (error handling + explicit-only fallback) and
// A4 (secret redaction) for the model-provider session path.
//
// A3: classify Agent-SDK failures (credit-exhaustion, rate-limit, auth, other),
//     surface a clear actionable message, and fall back subscription→api_key
//     ONLY when RADAR_FALLBACK_TO_API=true is explicitly set. Never silent.
// A4: redactSecrets() scrubs credential values from any string before it is
//     logged or attached to a surfaced error (SDK error text can echo a token).

export const FALLBACK_ENV = 'RADAR_FALLBACK_TO_API';

/**
 * Is subscription→api_key fallback explicitly enabled? Opt-in only: anything
 * other than the exact string "true" is off, so fallback never happens by
 * accident (the whole point is no silent switch to metered billing).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function resolveFallbackFlag(env = process.env) {
  return env[FALLBACK_ENV] === 'true';
}

/**
 * Redact known credential values (and common key shapes) from a string so it is
 * safe to log or surface. Scrubs the live env secrets by value, plus defensive
 * pattern matches in case a token appears that isn't in this process's env.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function redactSecrets(text, env = process.env) {
  if (text == null) return text;
  let out = String(text);
  const secrets = [
    env.ANTHROPIC_API_KEY,
    env.CLAUDE_CODE_OAUTH_TOKEN,
    env.ANTHROPIC_AUTH_TOKEN,
  ].filter(s => typeof s === 'string' && s.length >= 6);
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  // Defense in depth: mask common Anthropic key/token shapes by pattern.
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, 'sk-ant-[REDACTED]');
  out = out.replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-[REDACTED]');
  return out;
}

/**
 * Classify an error thrown by AgentSdkProvider.runSession / collectResult.
 * Reads the message + any `subtype` the provider attached.
 * @param {Error & { subtype?: string }} err
 * @returns {{ kind: 'credit'|'rate_limit'|'auth'|'other', retryable: boolean }}
 */
export function classifySessionError(err) {
  const msg = (err?.message || '').toLowerCase();
  const subtype = (err?.subtype || '').toLowerCase();
  const has = (...needles) => needles.some(n => msg.includes(n) || subtype.includes(n));

  // Auth first — "not logged in" etc. is not retryable and must never trigger a
  // credential fallback (a bad subscription token shouldn't silently bill the API).
  if (has('not logged in', 'unauthorized', 'authentication', 'invalid api key', 'invalid_api_key', 'forbidden')) {
    return { kind: 'auth', retryable: false };
  }
  if (has('rate limit', 'rate_limit', '429', 'too many requests')) {
    return { kind: 'rate_limit', retryable: true };
  }
  if (has('credit', 'quota', 'exhaust', 'usage limit', 'insufficient', 'billing', 'payment')) {
    return { kind: 'credit', retryable: true };
  }
  return { kind: 'other', retryable: false };
}

/**
 * Decide whether to fall back from subscription to api_key for this error.
 * True only when: the error is a credit/rate-limit condition, fallback is
 * explicitly enabled, AND we're on subscription (api_key has nowhere to fall
 * back to). Auth failures never fall back.
 * @param {{kind:string}} errorClass
 * @param {{ fallbackEnabled: boolean, currentMode: string }} ctx
 * @returns {boolean}
 */
export function shouldFallback(errorClass, { fallbackEnabled, currentMode }) {
  return Boolean(
    fallbackEnabled &&
      currentMode === 'subscription' &&
      (errorClass.kind === 'credit' || errorClass.kind === 'rate_limit')
  );
}

/**
 * A human-readable, actionable message per error class. Names the tunable
 * (RADAR_FALLBACK_TO_API) when fallback would have applied but wasn't enabled.
 * @param {{kind:string}} errorClass
 * @param {string} currentMode
 * @param {boolean} fallbackEnabled
 * @returns {string}
 */
export function describeSessionError(errorClass, currentMode, fallbackEnabled) {
  const canOfferFallback = currentMode === 'subscription' && !fallbackEnabled;
  switch (errorClass.kind) {
    case 'credit':
      return (
        `Agent SDK credit exhausted on the ${currentMode} credential.` +
        (canOfferFallback
          ? ` Set ${FALLBACK_ENV}=true to fall back to the API key, or wait for the credit to reset.`
          : '')
      );
    case 'rate_limit':
      return (
        `Agent SDK rate-limited on the ${currentMode} credential — retry shortly` +
        (canOfferFallback ? `, or set ${FALLBACK_ENV}=true to fall back to the API key.` : '.')
      );
    case 'auth':
      return (
        `Agent SDK authentication failed on the ${currentMode} credential — ` +
        `check it is present and valid (run \`claude setup-token\` for subscription mode, ` +
        `or set ANTHROPIC_API_KEY for api_key mode).`
      );
    default:
      return 'Agent SDK session failed.';
  }
}

/**
 * Run a session on the primary provider; on a fallback-eligible error with the
 * flag set, retry once on an api_key provider from buildFallback(). Never
 * silent: the return value flags whether the fallback path was used, and a
 * non-fallback failure throws a classified, secret-redacted error.
 *
 * @param {import('./model-provider.js').RunSessionRequest} req
 * @param {Object} opts
 * @param {import('./model-provider.js').ModelProvider} opts.primary
 * @param {string} opts.currentMode  the primary provider's auth mode
 * @param {() => import('./model-provider.js').ModelProvider} [opts.buildFallback]
 *   builds an api_key-mode provider (only called if a fallback is warranted)
 * @param {boolean} [opts.fallbackEnabled=false]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @returns {Promise<{ result: object, usedFallback: boolean, primaryErrorKind?: string }>}
 */
export async function runWithFallback(req, { primary, currentMode, buildFallback, fallbackEnabled = false, env = process.env }) {
  try {
    const result = await primary.runSession(req);
    return { result, usedFallback: false };
  } catch (err) {
    const cls = classifySessionError(err);
    if (shouldFallback(cls, { fallbackEnabled, currentMode }) && buildFallback) {
      const result = await buildFallback().runSession(req);
      return { result, usedFallback: true, primaryErrorKind: cls.kind };
    }
    const e = new Error(describeSessionError(cls, currentMode, fallbackEnabled));
    e.kind = cls.kind;
    // Redacted detail only — never attach the raw SDK error (it can echo a token).
    e.detail = redactSecrets(err?.message || '', env);
    throw e;
  }
}
