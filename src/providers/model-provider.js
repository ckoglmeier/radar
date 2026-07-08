// ModelProvider — the one provider interface (Phase A of the council plan).
//
// This is NOT a bare chat-completion interface. The council path runs the
// investment-grading *skill* via the Agent SDK: a system prompt / skill
// instructions + injected context (lens rubric/kill/gp/theses + deal facts +
// ck-professional-voice) + tools (web-search, file-write) + a model, run to
// completion, emitting an artifact and returning structured text/usage.
//
// So the interface is shaped around *agentic sessions*, with per-call model
// selection (the runtime model-tiering policy assigns different tiers — Haiku
// research, Sonnet grading, Opus calibration — to different council stages).
//
// `AgentSdkProvider` (agent-sdk-provider.js) is the local implementation. A
// plain-SDK / hosted-BYOK adapter is future work behind this same interface.
//
// JS has no interfaces; this file documents the contract via JSDoc typedefs and
// provides `assertModelProvider()` so implementations (and fakes in tests) can
// self-check the shape.

/**
 * A single agentic session request.
 *
 * @typedef {Object} RunSessionRequest
 * @property {string} prompt
 *   The task/user turn that kicks off the session (e.g. "Grade this deal:
 *   ...", or the headless skill trigger). Required.
 * @property {string} [model]
 *   Per-call model id (e.g. 'claude-opus-4-8', 'claude-sonnet-5',
 *   'claude-haiku-4-5'). Enables per-stage tiering. When omitted the provider
 *   falls back to its configured default model.
 * @property {string} [systemPrompt]
 *   Custom system prompt / skill framing injected for this session. Optional.
 * @property {string} [context]
 *   Additional injected context appended to the prompt (lens hydration, deal
 *   facts, voice). Kept separate from `prompt` so callers can assemble it from
 *   the lens accessors without string-mangling the task itself. Optional.
 * @property {string[]} [skills]
 *   Skill names to enable for the session (e.g. ['investment-grading',
 *   'ck-professional-voice']). Optional.
 * @property {string[]} [tools]
 *   Built-in tool names to allow (e.g. ['WebSearch', 'Write']). Empty array
 *   disables built-in tools. Optional.
 * @property {number} [maxTurns]
 *   Upper bound on assistant turns before the session is forced to stop.
 * @property {AbortSignal} [signal]
 *   Cancellation signal for the session.
 */

/**
 * Structured result of a completed agentic session.
 *
 * @typedef {Object} RunSessionResult
 * @property {string} text
 *   The final assistant text (the SDK's result string). For the council path
 *   this is the grade summary; the deal-log artifact is written to disk by the
 *   file-write tool during the run.
 * @property {ProviderUsage} usage
 *   Token/cost usage for the session, aggregated and per-model.
 * @property {string} model
 *   The primary model the session reported running under.
 * @property {string|null} [apiKeySource]
 *   Which credential the SDK actually authenticated with, from the init message
 *   ('oauth' = subscription token; 'user'|'project'|'org'|'temporary' = API key).
 *   A2's diagnostic checks this against the selected auth mode.
 * @property {number} numTurns
 *   Assistant turns taken.
 * @property {string} [sessionId]
 *   The SDK session id, for provenance/resume.
 */

/**
 * @typedef {Object} ProviderUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalCostUsd
 * @property {Object<string, {inputTokens: number, outputTokens: number, costUsd: number}>} [byModel]
 *   Per-model breakdown (the SDK reports `modelUsage`), so a run that fanned out
 *   across Haiku/Sonnet/Opus subagents can be attributed per tier.
 */

/**
 * The ModelProvider contract.
 *
 * @typedef {Object} ModelProvider
 * @property {(req: RunSessionRequest) => Promise<RunSessionResult>} runSession
 *   Run one agentic session to completion and return structured text/usage.
 */

/**
 * Assert a value satisfies the ModelProvider shape. Throws with a precise
 * message otherwise. Used by implementations to self-verify and by tests.
 *
 * @param {*} provider
 * @returns {ModelProvider}
 */
export function assertModelProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('ModelProvider must be an object');
  }
  if (typeof provider.runSession !== 'function') {
    throw new Error('ModelProvider must implement runSession(req): Promise<RunSessionResult>');
  }
  return provider;
}
