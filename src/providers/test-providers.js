#!/usr/bin/env node

// Standalone test fixture for the model-provider layer — no DB, no real
// credentials required. Run: node src/providers/test-providers.js
//
// We CANNOT test a real credentialed round-trip here: subscription mode needs
// CK's OAuth token and api_key mode needs a real ANTHROPIC_API_KEY, neither of
// which is available in CI. So we test the logic that IS deterministic:
//   - subprocess env construction strips/preserves ANTHROPIC_API_KEY per mode
//   - the billing-shadow guard fails loud
//   - credential-mode selection + description
//   - the ModelProvider contract, exercised against AgentSdkProvider with an
//     injected fake `query` (a mock SDK message stream)

import {
  API_KEY_ENV,
  OAUTH_TOKEN_ENV,
  AUTH_MODES,
  assertAuthMode,
  shadowGuard,
  buildSubprocessEnv,
  describeCredentialSelection,
} from './credentials.js';
import { assertModelProvider } from './model-provider.js';
import { AgentSdkProvider } from './agent-sdk-provider.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
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
  if (actual === expected) return;
  throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}

function throws(fn, re, msg = '') {
  try {
    fn();
  } catch (e) {
    if (re && !re.test(e.message)) {
      throw new Error(`${msg}: threw but message ${JSON.stringify(e.message)} did not match ${re}`);
    }
    return;
  }
  throw new Error(`${msg || 'expected throw'}: did not throw`);
}

// A fake SDK `query` returning a scripted message stream. Captures the args it
// was called with so tests can assert on the env / options the provider built.
function makeFakeQuery(overrides = {}) {
  const calls = [];
  async function* stream(params) {
    calls.push(params);
    yield {
      type: 'system',
      subtype: 'init',
      apiKeySource: overrides.apiKeySource ?? 'oauth',
      model: params.options?.model ?? 'default-model',
      tools: [],
    };
    if (overrides.errorResult) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['boom'],
        num_turns: 1,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        session_id: 'sess-err',
      };
      return;
    }
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: overrides.text ?? 'PONG',
      num_turns: overrides.numTurns ?? 2,
      total_cost_usd: overrides.cost ?? 0.0123,
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: overrides.modelUsage ?? {
        'claude-haiku-4-5': { inputTokens: 60, outputTokens: 5, costUSD: 0.001 },
        'claude-opus-4-8': { inputTokens: 40, outputTokens: 15, costUSD: 0.0113 },
      },
      session_id: 'sess-ok',
    };
  }
  const fn = (params) => stream(params);
  fn.calls = calls;
  return fn;
}

async function run() {
  console.log('\n  credentials — auth mode validation\n');

  test('AUTH_MODES is exactly subscription + api_key', () => {
    eq(JSON.stringify(AUTH_MODES), JSON.stringify(['subscription', 'api_key']));
  });

  test('assertAuthMode accepts valid modes', () => {
    eq(assertAuthMode('subscription'), 'subscription');
    eq(assertAuthMode('api_key'), 'api_key');
  });

  test('assertAuthMode rejects unknown mode', () => {
    throws(() => assertAuthMode('sub'), /invalid auth mode/, 'unknown mode');
    throws(() => assertAuthMode(undefined), /invalid auth mode/, 'undefined mode');
  });

  console.log('\n  credentials — subprocess env construction\n');

  test('subscription strips ANTHROPIC_API_KEY from the child env', () => {
    const parent = { PATH: '/usr/bin', [API_KEY_ENV]: 'sk-ant-shadow', [OAUTH_TOKEN_ENV]: 'oauth-tok' };
    const env = buildSubprocessEnv('subscription', parent);
    ok(!(API_KEY_ENV in env), 'ANTHROPIC_API_KEY must be absent (not present-but-empty)');
    eq(env[OAUTH_TOKEN_ENV], 'oauth-tok', 'OAuth token preserved');
    eq(env.PATH, '/usr/bin', 'other env preserved');
  });

  test('subscription is a no-op when no ANTHROPIC_API_KEY present', () => {
    const parent = { PATH: '/usr/bin', [OAUTH_TOKEN_ENV]: 'oauth-tok' };
    const env = buildSubprocessEnv('subscription', parent);
    ok(!(API_KEY_ENV in env));
    eq(env[OAUTH_TOKEN_ENV], 'oauth-tok');
  });

  test('api_key preserves ANTHROPIC_API_KEY exactly', () => {
    const parent = { PATH: '/usr/bin', [API_KEY_ENV]: 'sk-ant-real' };
    const env = buildSubprocessEnv('api_key', parent);
    eq(env[API_KEY_ENV], 'sk-ant-real', 'API key preserved verbatim');
    eq(env.PATH, '/usr/bin');
  });

  test('buildSubprocessEnv never mutates the parent env', () => {
    const parent = { [API_KEY_ENV]: 'sk-ant-shadow' };
    buildSubprocessEnv('subscription', parent);
    eq(parent[API_KEY_ENV], 'sk-ant-shadow', 'parent env untouched');
  });

  test('buildSubprocessEnv rejects invalid mode', () => {
    throws(() => buildSubprocessEnv('nope', {}), /invalid auth mode/);
  });

  console.log('\n  credentials — billing-shadow guard (fail-loud)\n');

  test('shadowGuard throws for subscription + ANTHROPIC_API_KEY present', () => {
    throws(
      () => shadowGuard('subscription', { [API_KEY_ENV]: 'sk-ant-shadow' }),
      /refuses to start/,
      'shadow present'
    );
  });

  test('shadowGuard passes for subscription with no ANTHROPIC_API_KEY', () => {
    shadowGuard('subscription', { [OAUTH_TOKEN_ENV]: 'oauth-tok' });
  });

  test('shadowGuard is a no-op for api_key mode even with key present', () => {
    shadowGuard('api_key', { [API_KEY_ENV]: 'sk-ant-real' });
  });

  console.log('\n  credentials — selection description (redaction-safe)\n');

  test('describe: subscription reports OAuth env + stripped flag', () => {
    const d = describeCredentialSelection('subscription', { [API_KEY_ENV]: 'sk-ant' });
    eq(d.mode, 'subscription');
    eq(d.expectedCredentialEnv, OAUTH_TOKEN_ENV);
    eq(d.strippedApiKey, true);
    eq(d.apiKeyPresentInParent, true);
  });

  test('describe: api_key reports API key env, no strip', () => {
    const d = describeCredentialSelection('api_key', { [API_KEY_ENV]: 'sk-ant' });
    eq(d.expectedCredentialEnv, API_KEY_ENV);
    eq(d.strippedApiKey, false);
  });

  test('describe never leaks the secret value', () => {
    const d = describeCredentialSelection('api_key', { [API_KEY_ENV]: 'sk-ant-SECRET' });
    ok(!JSON.stringify(d).includes('SECRET'), 'no secret in description');
  });

  console.log('\n  model-provider — contract\n');

  test('assertModelProvider rejects non-providers', () => {
    throws(() => assertModelProvider(null), /must be an object/);
    throws(() => assertModelProvider({}), /must implement runSession/);
  });

  test('assertModelProvider accepts a valid fake', () => {
    const fake = { runSession: async () => ({ text: '', usage: {}, model: '', numTurns: 0 }) };
    eq(assertModelProvider(fake), fake);
  });

  console.log('\n  AgentSdkProvider — construction + env invariant\n');

  test('construction fails loud on billing shadow (subscription + key)', () => {
    throws(
      () => new AgentSdkProvider({ authMode: 'subscription', parentEnv: { [API_KEY_ENV]: 'sk-ant' } }),
      /refuses to start/,
      'shadow at construction'
    );
  });

  test('subscription provider satisfies the ModelProvider contract', () => {
    const p = new AgentSdkProvider({ authMode: 'subscription', parentEnv: {}, query: makeFakeQuery() });
    assertModelProvider(p);
  });

  console.log('\n  AgentSdkProvider — runSession (fake SDK stream)\n');

  await testAsync('runSession requires a string prompt', async () => {
    const p = new AgentSdkProvider({ authMode: 'api_key', parentEnv: {}, query: makeFakeQuery() });
    let threw = false;
    try { await p.runSession({}); } catch (e) { threw = /non-empty string/.test(e.message); }
    eq(threw, true);
  });

  await testAsync('subscription runSession passes an env WITHOUT ANTHROPIC_API_KEY to the SDK', async () => {
    const fake = makeFakeQuery();
    const p = new AgentSdkProvider({
      authMode: 'subscription',
      // No key in parent (else construction would fail loud). OAuth token present.
      parentEnv: { PATH: '/usr/bin', [OAUTH_TOKEN_ENV]: 'oauth-tok' },
      query: fake,
    });
    await p.runSession({ prompt: 'grade this' });
    const passedEnv = fake.calls[0].options.env;
    ok(!(API_KEY_ENV in passedEnv), 'SDK env must not carry ANTHROPIC_API_KEY');
    eq(passedEnv[OAUTH_TOKEN_ENV], 'oauth-tok');
  });

  await testAsync('api_key runSession passes ANTHROPIC_API_KEY through to the SDK', async () => {
    const fake = makeFakeQuery();
    const p = new AgentSdkProvider({
      authMode: 'api_key',
      parentEnv: { PATH: '/usr/bin', [API_KEY_ENV]: 'sk-ant-real' },
      query: fake,
    });
    await p.runSession({ prompt: 'grade this' });
    eq(fake.calls[0].options.env[API_KEY_ENV], 'sk-ant-real');
  });

  await testAsync('runSession forces headless permission mode', async () => {
    const fake = makeFakeQuery();
    const p = new AgentSdkProvider({ authMode: 'api_key', parentEnv: {}, query: fake });
    await p.runSession({ prompt: 'x' });
    eq(fake.calls[0].options.permissionMode, 'bypassPermissions');
    eq(fake.calls[0].options.allowDangerouslySkipPermissions, true);
  });

  await testAsync('per-call model overrides the default (tiering)', async () => {
    const fake = makeFakeQuery();
    const p = new AgentSdkProvider({ authMode: 'api_key', parentEnv: {}, defaultModel: 'claude-sonnet-5', query: fake });
    await p.runSession({ prompt: 'x', model: 'claude-opus-4-8' });
    eq(fake.calls[0].options.model, 'claude-opus-4-8');
  });

  await testAsync('default model is used when request omits model', async () => {
    const fake = makeFakeQuery();
    const p = new AgentSdkProvider({ authMode: 'api_key', parentEnv: {}, defaultModel: 'claude-sonnet-5', query: fake });
    await p.runSession({ prompt: 'x' });
    eq(fake.calls[0].options.model, 'claude-sonnet-5');
  });

  await testAsync('context is appended to the prompt; skills/tools forwarded', async () => {
    const fake = makeFakeQuery();
    const p = new AgentSdkProvider({ authMode: 'api_key', parentEnv: {}, query: fake });
    await p.runSession({
      prompt: 'grade this deal',
      context: 'LENS: rubric...',
      skills: ['investment-grading'],
      tools: ['WebSearch', 'Write'],
    });
    const c = fake.calls[0];
    ok(c.prompt.includes('grade this deal') && c.prompt.includes('LENS: rubric...'), 'context appended');
    eq(JSON.stringify(c.options.skills), JSON.stringify(['investment-grading']));
    eq(JSON.stringify(c.options.tools), JSON.stringify(['WebSearch', 'Write']));
  });

  await testAsync('runSession returns structured text + usage (incl. per-model)', async () => {
    const fake = makeFakeQuery();
    const p = new AgentSdkProvider({ authMode: 'api_key', parentEnv: {}, query: fake });
    const res = await p.runSession({ prompt: 'x' });
    eq(res.text, 'PONG');
    eq(res.numTurns, 2);
    eq(res.sessionId, 'sess-ok');
    eq(res.usage.inputTokens, 100);
    eq(res.usage.outputTokens, 20);
    eq(res.usage.totalCostUsd, 0.0123);
    ok(res.usage.byModel && res.usage.byModel['claude-opus-4-8'], 'per-model usage present');
    eq(res.usage.byModel['claude-opus-4-8'].costUsd, 0.0113, 'costUSD normalized to costUsd');
  });

  await testAsync('runSession surfaces SDK error results as thrown errors', async () => {
    const fake = makeFakeQuery({ errorResult: true });
    const p = new AgentSdkProvider({ authMode: 'api_key', parentEnv: {}, query: fake });
    let msg = '';
    try { await p.runSession({ prompt: 'x' }); } catch (e) { msg = e.message; }
    ok(/session failed/.test(msg) && /boom/.test(msg), `expected surfaced error, got ${JSON.stringify(msg)}`);
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
