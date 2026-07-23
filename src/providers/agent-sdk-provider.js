// AgentSdkProvider — local ModelProvider backed by the Claude Agent SDK.
//
// Verified against @anthropic-ai/claude-agent-sdk@0.3.204 (sdk.d.ts). The SDK's
// single entrypoint is `query({ prompt, options }) -> AsyncGenerator<SDKMessage>`.
// We drive it to completion and reduce the message stream to a RunSessionResult.
//
// Options we rely on (all confirmed in sdk.d.ts):
//   - model:      per-call model id (per-stage tiering)
//   - env:        REPLACES the subprocess env wholesale — this is where the
//                 credential invariant is enforced (see buildSubprocessEnv)
//   - tools:      string[] of built-in tools, or [] to disable
//   - skills:     string[] | 'all' — enable the investment-grading skill etc.
//   - systemPrompt / append: session framing
//   - permissionMode 'bypassPermissions' (+ allowDangerouslySkipPermissions):
//                 headless, no interactive permission prompts
//   - abortController: cancellation
// The terminal `{ type: 'result' }` message carries `result` (final text),
// `usage`, `modelUsage`, `total_cost_usd`, `num_turns`, `session_id`.
//
// Credential handling lives in ./credentials.js so A2's startup diagnostic can
// reuse the exact same selection logic.

import {
  assertAuthMode,
  shadowGuard,
  buildSubprocessEnv,
} from './credentials.js';
import { assertModelProvider } from './model-provider.js';

/**
 * @typedef {import('./model-provider.js').RunSessionRequest} RunSessionRequest
 * @typedef {import('./model-provider.js').RunSessionResult} RunSessionResult
 */

/**
 * Lazily import the real SDK `query`. Kept behind a function so the module
 * loads without the SDK present (e.g. unit tests inject a fake) — the import
 * only happens on an actual run against the real SDK.
 * @returns {Promise<Function>}
 */
async function defaultQuery() {
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  return mod.query;
}

/**
 * Reduce the SDK message stream to a RunSessionResult.
 *
 * @param {AsyncIterable<any>} stream
 * @returns {Promise<RunSessionResult>}
 */
async function collectResult(stream) {
  let initModel;
  let initApiKeySource;
  for await (const msg of stream) {
    if (msg?.type === 'system' && msg.subtype === 'init') {
      initModel = msg.model;
      // Which credential actually won — 'oauth' means the subscription token.
      // A2's startup diagnostic reads this to confirm the winning credential
      // matches the selected auth mode (no silent billing surprise).
      initApiKeySource = msg.apiKeySource;
      continue;
    }
    if (msg?.type === 'result') {
      if (msg.is_error || msg.subtype !== 'success') {
        const detail =
          (Array.isArray(msg.errors) && msg.errors.join('; ')) ||
          msg.result ||
          msg.subtype ||
          'unknown error';
        const err = new Error(`Agent SDK session failed: ${detail}`);
        err.subtype = msg.subtype;
        throw err;
      }
      return {
        text: msg.result ?? '',
        structuredOutput: msg.structured_output,
        usage: normalizeUsage(msg),
        model: initModel ?? '',
        apiKeySource: initApiKeySource ?? null,
        numTurns: msg.num_turns ?? 0,
        sessionId: msg.session_id,
      };
    }
  }
  throw new Error('Agent SDK session ended without a result message');
}

/**
 * @param {any} resultMsg SDKResultSuccess
 * @returns {import('./model-provider.js').ProviderUsage}
 */
function normalizeUsage(resultMsg) {
  const usage = resultMsg.usage ?? {};
  const byModel = {};
  for (const [model, mu] of Object.entries(resultMsg.modelUsage ?? {})) {
    byModel[model] = {
      inputTokens: mu.inputTokens ?? 0,
      outputTokens: mu.outputTokens ?? 0,
      costUsd: mu.costUSD ?? mu.costUsd ?? 0,
    };
  }
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalCostUsd: resultMsg.total_cost_usd ?? 0,
    byModel: Object.keys(byModel).length ? byModel : undefined,
  };
}

export class AgentSdkProvider {
  /**
   * @param {Object} opts
   * @param {'subscription'|'api_key'} opts.authMode
   *   Explicit credential mode (A2 drives this from RADAR_AUTH_MODE).
   * @param {string} [opts.defaultModel]
   *   Model used when a request omits `model`.
   * @param {NodeJS.ProcessEnv} [opts.parentEnv=process.env]
   *   Parent env to derive the subprocess env from.
   * @param {Function} [opts.query]
   *   Injectable SDK `query` (tests pass a fake). Defaults to the real SDK.
   * @param {string} [opts.cwd]
   *   Working directory for the session (deal-log output root).
   */
  constructor({ authMode, defaultModel, parentEnv = process.env, query, cwd } = {}) {
    this.authMode = assertAuthMode(authMode);
    this.defaultModel = defaultModel;
    this.parentEnv = parentEnv;
    this.cwd = cwd;
    this._query = query || null;

    // Fail loud at construction if the parent env would shadow the
    // subscription token. A2's startup diagnostic also calls shadowGuard, but
    // guarding here means no AgentSdkProvider can even be built in a
    // billing-shadow state.
    shadowGuard(this.authMode, this.parentEnv);

    assertModelProvider(this);
  }

  /**
   * @param {RunSessionRequest} req
   * @returns {Promise<RunSessionResult>}
   */
  async runSession(req = {}) {
    if (!req.prompt || typeof req.prompt !== 'string') {
      throw new Error('runSession requires a non-empty string `prompt`');
    }

    const query = this._query || (await defaultQuery());
    const env = buildSubprocessEnv(this.authMode, this.parentEnv);

    const prompt = req.context
      ? `${req.prompt}\n\n${req.context}`
      : req.prompt;

    /** @type {Record<string, any>} */
    const options = {
      env,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };

    const model = req.model || this.defaultModel;
    if (model) options.model = model;
    if (req.systemPrompt) options.systemPrompt = req.systemPrompt;
    if (req.skills) options.skills = req.skills;
    if (req.tools) options.tools = req.tools;
    if (req.outputFormat) options.outputFormat = req.outputFormat;
    if (req.agents) options.agents = req.agents; // subagent defs (per-persona models)
    if (typeof req.maxTurns === 'number') options.maxTurns = req.maxTurns;
    if (this.cwd) options.cwd = this.cwd;

    if (req.signal) {
      const ac = new AbortController();
      if (req.signal.aborted) ac.abort();
      else req.signal.addEventListener('abort', () => ac.abort(), { once: true });
      options.abortController = ac;
    }

    const stream = query({ prompt, options });
    return collectResult(stream);
  }
}
