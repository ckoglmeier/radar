// Smoke test: parse the synthetic AngelList invite HTML and print/assert the result.
// Run: node src/sync/test-fixtures/test-parser.js
//
// Override fixture: INVITE_FIXTURE_PATH=<path> node src/sync/test-fixtures/test-parser.js
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseInviteEmail, htmlToText } from '../parsers/angellist-invite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixturePath = process.env.INVITE_FIXTURE_PATH ||
  join(__dirname, 'angellist-invite-sample.html');

const html = readFileSync(fixturePath, 'utf-8');

const text = htmlToText(html);

const parsed = parseInviteEmail({
  subject: 'Example Syndicate invited you to invest in Acme Autonomy (YC W24)',
  from: 'AngelList <portal@angellist.com>',
  receivedAt: '2026-01-15T10:00:00Z',
  text,
  html,
  messageId: 'msg-example-000000000001',
});

// --- Assertions ---
let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertIncludes(name, actual, substring) {
  if (typeof actual === 'string' && actual.includes(substring)) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}: expected string containing ${JSON.stringify(substring)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('\n  Parsed invite fields\n');

assert('company_name', parsed.company_name, 'Acme Autonomy (YC W24)');
assert('lead', parsed.lead, 'Example Syndicate');
assert('co_investors', parsed.co_investors, 'Sample Capital Partners, Prototype Ventures, Sandbox Fund');
assert('market', parsed.market, 'Robotics');
assert('round', parsed.round, 'Series A');
assert('allocation_usd', parsed.allocation_usd, 500000);
assert('min_investment_usd', parsed.min_investment_usd, 2500);
assert('carry_pct', parsed.carry_pct, 20);
assert('syndicate_investment_usd', parsed.syndicate_investment_usd, 5000);
assert('dataroom_url', parsed.dataroom_url,
  'https://portal.angellist.com/start/data-room-invite/00000000-0000-0000-0000-000000000001');
assert('status', parsed.status, 'invite');
assert('source', parsed.source, 'email');
assert('gmail_message_id', parsed.gmail_message_id, 'msg-example-000000000001');
assert('email_received_at', parsed.email_received_at, '2026-01-15T10:00:00Z');
assertIncludes('gp_message contains company name', parsed.gp_message, 'Acme Autonomy');
assertIncludes('deal_slug contains lead', parsed.deal_slug, 'example-syndicate');
assertIncludes('deal_slug contains company', parsed.deal_slug, 'acme-autonomy');

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (process.env.INVITE_FIXTURE_PATH) {
  // When using a custom fixture, just print and exit 0 (smoke test only)
  console.log(JSON.stringify(parsed, null, 2));
  process.exit(0);
}

process.exit(failed > 0 ? 1 : 0);
