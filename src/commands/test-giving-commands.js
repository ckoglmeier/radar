// Giving commands end to end on a scratch database, using the fictional Rivera fixture.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  currentLens, exportGiving, getSnapshot, givingPlan, givingReport, listActivity, listItems, listPledges, listRequests,
} from '../models/giving.js';
import { authorizeCommandProposal, planCommandProposal } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-giving-commands-'));
const fixture = JSON.parse(readFileSync(new URL('../giving/fixtures/example.rivera.json', import.meta.url), 'utf8'));
let counter = 0;

async function run(name, input) {
  counter += 1;
  const planned = await planCommandProposal([{ name, input: { requestId: `r${counter}`, ...input } }], {
    originSurface: 'manual_ui', actorType: 'user', actorId: 'test', intentText: name, idempotencyKey: `giving-test:${counter}`,
  });
  const outcome = await authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash, {
    authorizationKind: 'manual_ui', actorType: 'user', actorId: 'test', actorCapabilities: ['portfolio:apply:metadata'],
  });
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome).slice(0, 600));
  return outcome.receipt.commands[0].result;
}
const rejects = async (promise, code) => assert.rejects(promise, error => (error.code === code ? true : (console.error(error), false)));
const item = async externalKey => (await listItems({ workspaceId: 'local' })).find(row => row.external_key === externalKey);
const total = report => report.totals.find(row => row.currency === 'USD')?.net_cents ?? 0;

try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();

    // Import, then re-import: the second adds nothing.
    const first = await run('giving.import_file', { file: fixture });
    assert.equal(first.added, 7);
    const again = await run('giving.import_file', { file: fixture });
    assert.equal(again.added, 0);
    assert.equal(again.skipped, 7);
    assert.equal(again.source, null, 'no empty source for a repeat import');
    await rejects(run('giving.import_file', { file: { ...fixture, format: 'nope' } }), 'PRECONDITION_FAILED');

    // Uploaded file proposals: same review path; re-uploading the same file adds nothing.
    const upload = { fileName: 'gifts.csv', fileSha256: 'b'.repeat(64), fileKind: 'csv', candidates: [{
      excerpt: 'Charity: Hillside Library Friends\nAmount: $2,500.00\nDate: 2026-03-04',
      proposed: { kind: 'receipt', organization: { name: 'Hillside Library Friends' }, amount: { cents: 250000, currency: 'USD', literal: '$2,500.00' }, date: { value: '2026-03-04', basis: 'stated_in_excerpt', literal: '2026-03-04' }, vehicle: 'direct', confidence: 'high' },
      source: { subject: 'gifts.csv' },
    }] };
    assert.equal((await run('giving.import_upload', upload)).added, 1);
    assert.equal((await run('giving.import_upload', upload)).added, 0);
    await rejects(run('giving.import_upload', { ...upload, fileSha256: 'c'.repeat(64), candidates: [{ excerpt: 'x', proposed: { kind: 'bogus' } }] }), 'PRECONDITION_FAILED');
    await run('giving.confirm_item', { itemId: (await item(`upload:${'b'.repeat(64)}:0`)).id, decision: { action: 'reject' } });

    // Daffy contribution: recorded, never recipient giving.
    await run('giving.confirm_item', { itemId: (await item('gmail:18c1f0a0e1')).id, decision: { action: 'daf_contribution', provider: 'Daffy', amount_cents: 1000000, contributed_on: '2026-01-05' } });

    // Daffy grant → gift; the org's own receipt is the same gift (evidence, not a second gift).
    const grant = await run('giving.confirm_item', {
      itemId: (await item('gmail:18c3a2b4f2')).id,
      decision: { action: 'gift', organization: { name: 'Northside Food Bank', ein: '12-3456789' }, gift: { amount_cents: 250000, paid_on: '2026-02-01', vehicle: 'daf_grant' } },
    });
    const receipt = await item('gmail:18c3d9c011');
    assert.ok(receipt.suggested_gifts.some(s => s.gift_id === grant.gift_id && s.reasons.includes('daf_grant_receipt_pair')), 'receipt suggested as a match, not merged');
    assert.equal(receipt.status, 'proposed');
    await run('giving.confirm_item', { itemId: receipt.id, decision: { action: 'evidence_of_gift', gift_id: grant.gift_id } });
    await rejects(run('giving.confirm_item', { itemId: receipt.id, decision: { action: 'reject' } }), 'PRECONDITION_FAILED');

    // Same organization by EIN reuses one identity.
    const northsideAgain = await run('giving.save_organization', { name: 'Northside Food Bank Inc', ein: '123456789' });
    const maple = await run('giving.save_organization', { name: 'Maple Literacy' });
    const harbor = await run('giving.save_organization', { name: 'Harbor Arts' });
    const coastal = await run('giving.save_organization', { name: 'Coastal Clinic' });
    const sam = await run('giving.add_member', { displayName: 'Sam Rivera' });

    // Two purposes at one organization; window boundaries; household member.
    await run('giving.add_gift', { organization: { id: northsideAgain.id }, gift: { amount_cents: 75000, paid_on: '2025-10-16', vehicle: 'direct' } });
    await run('giving.add_gift', { organization: { id: maple.id }, gift: { amount_cents: 100000, paid_on: '2025-12-10', purpose: 'General operating', vehicle: 'direct' } });
    await run('giving.add_gift', { organization: { id: maple.id }, gift: { amount_cents: 50000, paid_on: '2026-06-01', purpose: 'Summer reading', restriction: 'Summer reading only', vehicle: 'direct' } });
    await run('giving.add_gift', { organization: { id: maple.id }, gift: { amount_cents: 100000, paid_on: '2025-03-10', vehicle: 'direct' } });
    await run('giving.add_gift', { organization: { id: harbor.id }, gift: { amount_cents: 60000, paid_on: '2025-02-14', vehicle: 'direct' } });
    const harborGift = await run('giving.add_gift', { organization: { id: harbor.id }, gift: { amount_cents: 60000, paid_on: '2026-03-01', vehicle: 'direct' } });
    await run('giving.add_gift', { organization: { id: coastal.id }, gift: { amount_cents: 40000, paid_on: '2026-10-16', vehicle: 'direct', member_id: sam.id } });

    // Refund via its proposal; refunds cannot exceed the gift.
    await run('giving.confirm_item', { itemId: (await item('gmail:18c55e7a90')).id, decision: { action: 'refund', gift_id: harborGift.id, amount_cents: 10000, refunded_on: '2026-03-20' } });
    await rejects(run('giving.add_refund', { giftId: harborGift.id, amountCents: 60000 }), 'PRECONDITION_FAILED');

    // Unknown date goes to the queue.
    const river = await run('giving.confirm_item', { itemId: (await item('gmail:18c7b10c33')).id, decision: { action: 'gift', organization: { name: 'River Trust' }, gift: { amount_cents: 25000, paid_on: null, vehicle: 'unknown' } } });

    // Pledge with a partial payment.
    const capital = await run('giving.create_request', { organization: { id: maple.id }, request: { purpose: 'Capital campaign', requested_cents: 300000 } });
    await run('giving.decide_request', { giftRequestId: capital.id, status: 'pledged', decidedCents: 300000, rationale: 'Multi-year commitment' });
    await run('giving.record_payment', { giftRequestId: capital.id, gift: { amount_cents: 100000, paid_on: '2026-09-01', purpose: 'Capital campaign', vehicle: 'direct' } });
    const [pledge] = await listPledges({ workspaceId: 'local' });
    assert.equal(pledge.outstanding_cents, 200000);
    assert.equal(pledge.paid_cents, 100000);

    // Solicitation → request, coexisting with completed gifts to the same org.
    const ask = await run('giving.confirm_item', { itemId: (await item('gmail:18c9e0f777')).id, decision: { action: 'request', organization: { id: harbor.id }, request: { purpose: 'Youth Studio build-out', requested_cents: 500000, deadline: '2026-11-30' } } });
    await run('giving.confirm_item', { itemId: (await item('gmail:18c9f12a01')).id, decision: { action: 'reject' } });

    // Report as of 2026-10-16 matches the worked example.
    const report = await givingReport({ workspaceId: 'local', asOf: '2026-10-16' });
    assert.deepEqual(report.totals, [{ currency: 'USD', gross_cents: 600000, refunds_cents: 10000, net_cents: 590000 }]);
    assert.equal(report.prior_totals[0].net_cents, 235000);
    assert.equal(report.unknown_date_queue.length, 1);
    assert.equal(report.unknown_date_queue[0], river.gift_id);
    assert.equal(report.by_organization.find(org => org.organization_id === maple.id).purposes.length, 3);

    // Snapshot is immutable and survives later corrections.
    const snapshot = await run('giving.save_snapshot', { kind: 'report', asOf: '2026-10-16', payload: report, label: 'Initial review' });
    await assert.rejects(query(`UPDATE giving_snapshots SET label = 'x' WHERE id = $1`, [snapshot.id]), /immutable/);
    await run('giving.correct_gift', { giftId: harborGift.id, changes: { amount_cents: 70000 } });
    assert.equal(total(await givingReport({ workspaceId: 'local', asOf: '2026-10-16' })), 600000);
    assert.equal((await getSnapshot({ workspaceId: 'local', snapshotId: snapshot.id })).payload.totals[0].net_cents, 590000);
    await run('giving.correct_gift', { giftId: harborGift.id, changes: { amount_cents: 60000 } });

    // Lens: drafted causes must cite confirmed gifts; versions append.
    const lens = { causes: [{ id: 'c-lit', label: 'Childhood literacy', origin: { kind: 'drafted_from_gifts', gift_ids: [harborGift.id], basis: 'test' } }], priorities: [] };
    const saved = await run('giving.save_lens', { lens });
    assert.equal(saved.version, 1);
    await rejects(run('giving.save_lens', { lens: { causes: [{ id: 'c', label: 'x', origin: { kind: 'drafted_from_gifts', gift_ids: ['not-a-gift'] } }] } }), 'PRECONDITION_FAILED');
    await run('giving.save_lens', { lens: { ...lens, causes: [{ ...lens.causes[0], label: 'Creative programs for teens' }] } });
    // Linking an organization counts all its gifts toward the cause; unknown organizations are refused.
    await run('giving.save_lens', { lens: { causes: [{ id: 'c-lit', label: 'Childhood literacy', organization_ids: [maple.id] }] } });
    const byCause = (await givingReport({ workspaceId: 'local', asOf: '2026-10-16' })).by_cause[0];
    assert.equal(byCause.totals[0].net_cents, 250000, 'all three Maple gifts in the window');
    await rejects(run('giving.save_lens', { lens: { causes: [{ id: 'c', label: 'x', organization_ids: ['nope'] }] } }), 'PRECONDITION_FAILED');
    assert.equal((await currentLens({ workspaceId: 'local' })).version, 3);
    assert.equal((await getSnapshot({ workspaceId: 'local', snapshotId: snapshot.id })).payload.lens_version, null, 'old snapshot keeps its lens');

    // Budget: custom, zero, skipped; planned + commitments; trailing total not subtracted.
    await run('giving.save_budget', { budget: { starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'custom', amount_cents: 800000, planned: [{ organization_id: maple.id, amount_cents: 100000 }, { organization_id: northsideAgain.id, amount_cents: 250000 }] } });
    let plan = await givingPlan({ workspaceId: 'local' });
    assert.equal(plan.committed_cents, 200000);
    assert.equal(plan.unallocated_cents, 250000);
    await run('giving.save_budget', { budget: { starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'custom', amount_cents: 0 } });
    assert.equal((await givingPlan({ workspaceId: 'local' })).unallocated_cents, -200000, 'zero is a real budget');
    await run('giving.save_budget', { budget: { starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'skipped' } });
    assert.equal((await givingPlan({ workspaceId: 'local' })).unallocated_cents, null);
    await rejects(run('giving.save_budget', { budget: { starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'skipped', amount_cents: 5 } }), 'PRECONDITION_FAILED');

    // Request lifecycle: no paid status; payment only through a confirmed gift; deferred/passed stay distinct.
    await rejects(run('giving.decide_request', { giftRequestId: ask.request_id, status: 'paid' }), 'COMMAND_VALIDATION_FAILED');
    await rejects(run('giving.record_payment', { giftRequestId: ask.request_id, gift: { amount_cents: 250000, paid_on: '2026-11-20', vehicle: 'direct' } }), 'PRECONDITION_FAILED');
    await rejects(run('giving.decide_request', { giftRequestId: ask.request_id, status: 'approved' }), 'PRECONDITION_FAILED');
    await run('giving.decide_request', { giftRequestId: ask.request_id, status: 'evaluating' });
    await run('giving.decide_request', { giftRequestId: ask.request_id, status: 'approved', decidedCents: 250000, rationale: 'Fund half; ask about outcomes' });
    let requests = await listRequests({ workspaceId: 'local' });
    assert.equal(requests.find(r => r.id === ask.request_id).payment.state, 'unpaid', 'approval is not payment');
    const before = total(await givingReport({ workspaceId: 'local', asOf: '2026-11-20' }));
    await run('giving.record_payment', { giftRequestId: ask.request_id, gift: { amount_cents: 250000, paid_on: '2026-11-20', vehicle: 'direct' } });
    requests = await listRequests({ workspaceId: 'local' });
    assert.equal(requests.find(r => r.id === ask.request_id).payment.state, 'paid_in_full');
    assert.equal(total(await givingReport({ workspaceId: 'local', asOf: '2026-11-20' })), before + 250000);
    const deferred = await run('giving.create_request', { organization: { id: northsideAgain.id }, request: { purpose: 'Mobile pantry', requested_cents: 100000 } });
    await run('giving.decide_request', { giftRequestId: deferred.id, status: 'deferred' });
    const passed = await run('giving.create_request', { organization: { id: coastal.id }, request: {} });
    await run('giving.decide_request', { giftRequestId: passed.id, status: 'passed' });
    requests = await listRequests({ workspaceId: 'local' });
    assert.equal(requests.find(r => r.id === deferred.id).status, 'deferred');
    assert.equal(requests.find(r => r.id === passed.id).status, 'passed');

    // Source removal keeps confirmed records and reports what needs review.
    const removed = await run('giving.remove_source', { sourceId: first.source.id });
    assert.equal(removed.withdrawn, 0);
    assert.ok(removed.gifts_needing_review.includes(grant.gift_id));
    assert.equal(total(await givingReport({ workspaceId: 'local', asOf: '2026-10-16' })), 590000, 'nothing deleted silently');

    // Ongoing intake: off by default; the one-time import never turns it on; samples need the opt-in.
    const { givingSettings } = await import('../models/giving.js');
    assert.equal((await givingSettings({ workspaceId: 'local' })).ongoing_intake.enabled, false, 'one-time imports never enable ongoing intake');
    await rejects(run('giving.add_sample_batch', {}), 'PRECONDITION_FAILED');
    await run('giving.set_ongoing_intake', { enabled: true });
    const sample = await run('giving.add_sample_batch', {});
    assert.equal(sample.added, 2);
    assert.equal(sample.source.kind, 'sample');
    const sampleItems = await listItems({ workspaceId: 'local', sourceId: sample.source.id });
    assert.ok(sampleItems.every(i => /\(sample\)/.test(i.proposed.organization.name) && i.external_key.startsWith('gmail:sample-')));
    await run('giving.set_ongoing_intake', { enabled: false });
    await rejects(run('giving.add_sample_batch', {}), 'PRECONDITION_FAILED');

    // Workspace isolation; activity log; reset requires the typed phrase and spares other data.
    assert.equal((await givingReport({ workspaceId: 'someone-else', asOf: '2026-10-16' })).totals.length, 0);
    assert.ok((await listActivity({ workspaceId: 'local' })).length > 20);
    await assert.rejects(query(`UPDATE giving_transitions SET action = 'x'`), /immutable/);
    assert.ok((await exportGiving({ workspaceId: 'local' })).tables.giving_gifts.length >= 10);
    await rejects(run('giving.reset', { confirmText: 'yes' }), 'COMMAND_VALIDATION_FAILED');
    const cleared = await run('giving.reset', { confirmText: 'delete giving data' });
    assert.ok(cleared.giving_gifts >= 10);
    assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM giving_organizations'))[0].n), 0);
  });
  console.log('giving commands: ok');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
