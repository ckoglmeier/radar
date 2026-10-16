// Labeled sample batches for the ongoing-intake simulation (pure). Every organization is
// fictional and marked "(sample)"; message ids start with "sample-". Nothing here reads email.

const ORGS = [
  { name: 'Riverbend Food Pantry (sample)', ein: '00-0000001', purpose: 'Weekend meals' },
  { name: 'Northfield Reading Corps (sample)', ein: '00-0000002', purpose: 'Tutoring program' },
  { name: 'Cedar Valley Clinic (sample)', ein: '00-0000003', purpose: 'Where needed most' },
];

const pad = n => String(n).padStart(2, '0');
const money = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

export function sampleBatch({ now = new Date(), random = Math.random } = {}) {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const us = `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${String(now.getFullYear()).slice(2)}`;
  const id = () => `sample-${Math.floor(random() * 1e12).toString(36)}-${Math.floor(random() * 1e12).toString(36)}`;
  const org = ORGS[Math.floor(random() * ORGS.length)];
  const cents = (2 + Math.floor(random() * 8)) * 5000;
  const receiptText = `Your donation recommendation to ${org.name} has been approved.\nDonation date: ${us}\nNon-profit: ${org.name}\nTax-ID: ${org.ein}\nDonation amount: ${money(cents)}\nDonation use: ${org.purpose}`;
  const ask = ORGS.find(o => o !== org);
  const askCents = 100000;
  const askText = `This is a sample request. ${ask.name} asks whether you would consider ${money(askCents)} for ${ask.purpose.toLowerCase()} this season.`;
  const items = [
    {
      item_id: 's1',
      source_ref: { kind: 'gmail_message', message_id: id(), thread_id: null, received_at: now.toISOString(), from_name: 'Sample batch', from_domain: 'sample.invalid', subject: `Sample: donation receipt for ${org.name}` },
      excerpt: receiptText,
      proposed: { kind: 'daf_grant', organization: { name: org.name, ein: null, ein_literal: null }, amount: { cents, currency: 'USD', literal: money(cents) }, date: { value: day, basis: 'stated_in_excerpt', literal: us }, purpose: org.purpose, vehicle: 'daffy', confidence: 'high', notes: 'Sample data from the ongoing-intake simulation. Not from your email.' },
    },
    {
      item_id: 's2',
      source_ref: { kind: 'gmail_message', message_id: id(), thread_id: null, received_at: now.toISOString(), from_name: 'Sample batch', from_domain: 'sample.invalid', subject: `Sample: request from ${ask.name}` },
      excerpt: askText,
      proposed: { kind: 'solicitation', organization: { name: ask.name }, amount: { cents: null, currency: null, literal: null }, date: { value: day, basis: 'email_received', literal: null }, purpose: ask.purpose, vehicle: 'unknown', request: { requested_cents: askCents, requested_literal: money(askCents), deadline: null, deadline_literal: null }, confidence: 'high', notes: 'Sample data from the ongoing-intake simulation. Not from your email.' },
    },
  ];
  return {
    format: 'giving-import/v1',
    generated_at: now.toISOString(),
    generator: { kind: 'sample', model: null, notes: 'Ongoing-intake simulation. Fictional organizations.' },
    household_member: { display_name: 'Sample data' },
    scan: { provider: 'none', access: 'one_time', period: { from: day, to: day }, queries: [], messages_examined: 0, items_proposed: items.length, known_gaps: ['Simulation only: Radar did not read any email.'] },
    items,
  };
}
