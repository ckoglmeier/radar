// Grading references: delivery medium is transport, not trust; unknown referral
// is not cold inbound; no invented floor/neutral/bonus; SPV sponsor ≠ round lead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = name => readFileSync(new URL(`../../skills/investment-grading/references/${name}.md`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
for (const name of ['bull', 'bear', 'calibrator']) {
  const text = read(name);
  assert.match(text, /DocSend, AngelList, email, a website, and a PDF are transport, not trust signals/, name);
  assert.match(text, /does not establish cold inbound/, name);
  assert.match(text, /do not invent a platform penalty, bonus, or neutral score|Do not invent a 1\/5 floor, a neutral default, or a platform bonus/, name);
  assert.match(text, /not thereby the round lead/, name);
  assert.match(text, /Source quality must not change other dimensions or their weights/, name);
}
assert.doesNotMatch(read('calibrator'), /cold inbound with no recorded relationship is 1/, 'old platform-based 1/5 floor removed');
assert.match(read('calibrator'), /explicitly established cold path can receive the rubric's cold-path rating/);
console.log('Source policy references: platform neutrality, unknown referral, rubric preservation and SPV/round-lead distinction passed');
