import { query, writeCapabilities } from '../db/index.js';
import {
  recordDirectLifecycleEvent,
  resolveDirectReturnTiming,
  voidDirectLifecycleEvent,
} from '../models/direct-lifecycle-events.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const nullableId = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] };
const nullableUuid = { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] };
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] };

function schema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

function dateOnly(value) {
  return value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

async function directTarget(investmentId) {
  const [row] = await query(`
    SELECT id, company_name, asset_class, status, updated_at
      FROM investments WHERE id = $1
  `, [investmentId]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Direct position not found: ${investmentId}`);
  if (row.asset_class !== 'direct') {
    throw new CommandError('WRONG_TARGET_TYPE', 'Lifecycle event requires a Direct position.');
  }
  return { type: 'direct_position', id: Number(row.id), label: row.company_name };
}

async function eventTarget(eventId) {
  const [row] = await query(`
    SELECT e.id, e.investment_id, i.company_name
      FROM direct_position_lifecycle_events e
      JOIN investments i ON i.id = e.investment_id
     WHERE e.id = $1
  `, [eventId]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Direct lifecycle event not found: ${eventId}`);
  return {
    type: 'direct_lifecycle_event', id: row.id, label: row.company_name,
    investmentId: Number(row.investment_id),
  };
}

async function inspectPosition(target) {
  const [row] = await query(`
    SELECT id, company_name, asset_class, status, updated_at
      FROM investments WHERE id = $1
  `, [target.id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Direct position not found: ${target.id}`);
  return row;
}

async function inspectReturnResolution(target) {
  const [row] = await query(`
    SELECT i.id, i.company_name, i.asset_class, i.status, i.updated_at,
           COALESCE(i.computed_realized, latest.realized_value, i.realized_value, 0) AS realized_value,
           COALESCE((
             SELECT SUM(cf.amount) FROM cash_flows cf
              WHERE cf.investment_id = i.id
                AND cf.type = 'distribution'
                AND cf.amount > 0
           ), 0) AS dated_distributions
      FROM investments i
      LEFT JOIN LATERAL (
        SELECT v.realized_value
          FROM valuations v
         WHERE v.investment_id = i.id
         ORDER BY v.snapshot_date DESC, v.id DESC
         LIMIT 1
      ) latest ON TRUE
     WHERE i.id = $1
  `, [target.id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Direct position not found: ${target.id}`);
  return row;
}

async function inspectEvent(target) {
  const [row] = await query(`
    SELECT * FROM direct_position_lifecycle_events WHERE id = $1
  `, [target.id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Direct lifecycle event not found: ${target.id}`);
  return { ...row, event_date: dateOnly(row.event_date) };
}

function base(definition) {
  return {
    version: 1,
    tier: 'A',
    domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: ['portfolio:apply:lifecycle'],
    availability: available,
    resultSchema: objectResult,
    plannerExposure: true,
    interactionPolicy: 'confirm_inline',
    undoPolicy: 'unavailable',
    ...definition,
  };
}

export const directLifecycleCommandDefinitions = [
  base({
    name: 'direct.record_lifecycle_event',
    title: 'Record Direct lifecycle event',
    description: 'Record a dated Direct disposition fact while leaving proceeds in the cash-flow ledger.',
    risk: 'lifecycle',
    editableInputKeys: [
      'date', 'eventType', 'remainingInterest', 'cashFlowId',
      'sourceDocumentId', 'evidenceNote',
    ],
    inputSchema: schema({
      investmentId: { type: 'integer', minimum: 1 },
      date: { type: 'string', format: 'date' },
      eventType: {
        type: 'string',
        enum: ['partial_liquidity', 'full_exit', 'dissolution', 'write_off', 'abandonment'],
      },
      remainingInterest: { type: 'string', enum: ['yes', 'no', 'unknown'] },
      cashFlowId: nullableId,
      sourceDocumentId: nullableId,
      evidenceNote: nullableText,
    }, ['investmentId', 'date', 'eventType', 'remainingInterest']),
    resolve: input => directTarget(input.investmentId),
    inspect: inspectPosition,
    preview: ({ target, input, current }) => ({
      summary: `Record ${input.eventType.replaceAll('_', ' ')} for ${target.label} on ${input.date}.`,
      target,
      before: [{ field: 'status', value: current.status }],
      after: [
        { field: 'event_date', value: input.date },
        { field: 'event_type', value: input.eventType },
        { field: 'remaining_interest', value: input.remainingInterest },
        { field: 'cash_flow_id', value: input.cashFlowId || null },
        { field: 'source_document_id', value: input.sourceDocumentId || null },
        { field: 'evidence_note', value: input.evidenceNote || null },
      ],
      derivedEffects: [{
        field: 'realization_report_classification',
        value: input.remainingInterest === 'unknown'
          ? 'candidate'
          : input.remainingInterest === 'no' && input.eventType !== 'partial_liquidity'
            ? 'confirmed'
            : 'partial',
      }],
      warnings: [
        'This records disposition state only. Linked cash-flow proceeds remain unchanged.',
        ...(input.remainingInterest === 'unknown' ? ['The event will remain a candidate until remaining interest is known.'] : []),
      ],
      requiredReason: false,
    }),
    preconditions: ({ current }) => ({ updated_at: current.updated_at, asset_class: current.asset_class }),
    apply: ({ target, input, idempotencyKey }) => recordDirectLifecycleEvent(
      target.id,
      { ...input, idempotencyKey },
    ),
    inspectAfter: ({ result }) => query(
      `SELECT * FROM direct_position_lifecycle_events WHERE id = $1`,
      [result.event.id],
    ).then(rows => rows[0]),
    affectedResources: ({ target, result }) => [
      target,
      ...(result?.event?.id ? [{ type: 'direct_lifecycle_event', id: result.event.id, label: target.label }] : []),
    ],
  }),
  base({
    name: 'direct.resolve_return_timing',
    title: 'Resolve Direct return timing',
    description: 'Record dated proceeds and their Direct lifecycle event to complete IRR evidence.',
    risk: 'lifecycle',
    editableInputKeys: [
      'date', 'amount', 'eventType', 'remainingInterest', 'sourceDocumentId', 'evidenceNote',
    ],
    inputSchema: schema({
      investmentId: { type: 'integer', minimum: 1 },
      date: { type: 'string', format: 'date' },
      amount: { type: 'number', exclusiveMinimum: 0 },
      eventType: {
        type: 'string',
        enum: ['partial_liquidity', 'full_exit', 'dissolution'],
      },
      remainingInterest: { type: 'string', enum: ['yes', 'no'] },
      sourceDocumentId: nullableId,
      evidenceNote: nullableText,
    }, ['investmentId', 'date', 'amount', 'eventType', 'remainingInterest']),
    resolve: input => directTarget(input.investmentId),
    inspect: inspectReturnResolution,
    preview: ({ target, input, current }) => {
      const unresolvedAmount = Math.max(
        0,
        Number(current.realized_value || 0) - Number(current.dated_distributions || 0),
      );
      return {
        summary: `Record ${input.amount} of return proceeds for ${target.label} on ${input.date}.`,
        target,
        before: [
          { field: 'recorded_realized_value', value: Number(current.realized_value || 0) },
          { field: 'dated_distributions', value: Number(current.dated_distributions || 0) },
          { field: 'unresolved_return_amount', value: unresolvedAmount },
        ],
        after: [
          { field: 'dated_distribution', value: input.amount },
          { field: 'event_date', value: input.date },
          { field: 'event_type', value: input.eventType },
          { field: 'remaining_interest', value: input.remainingInterest },
        ],
        derivedEffects: [{ field: 'irr_evidence', value: 'dated return recorded' }],
        warnings: [
          ...(Math.abs(unresolvedAmount - Number(input.amount)) > 0.01
            ? [`The entered proceeds differ from the unresolved recorded amount of ${unresolvedAmount}.`]
            : []),
          'Confirm the actual cash-settlement date; a valuation date is not sufficient.',
        ],
        requiredReason: false,
      };
    },
    preconditions: ({ current }) => ({
      updated_at: current.updated_at,
      realized_value: Number(current.realized_value || 0),
      dated_distributions: Number(current.dated_distributions || 0),
    }),
    apply: ({ target, input, idempotencyKey }) => resolveDirectReturnTiming(
      target.id,
      { ...input, idempotencyKey },
    ),
    inspectAfter: ({ result }) => ({
      cash_flow_id: Number(result.cash_flow.id),
      lifecycle_event_id: result.event.id,
      flow_date: dateOnly(result.cash_flow.flow_date),
      amount: Number(result.cash_flow.amount),
    }),
    affectedResources: ({ target, result }) => [
      target,
      ...(result?.cash_flow?.id ? [{ type: 'cash_flow', id: Number(result.cash_flow.id), label: target.label }] : []),
      ...(result?.event?.id ? [{ type: 'direct_lifecycle_event', id: result.event.id, label: target.label }] : []),
    ],
  }),
  base({
    name: 'direct.void_lifecycle_event',
    title: 'Void Direct lifecycle event',
    description: 'Void an exact Direct lifecycle fact without deleting its audit history.',
    risk: 'corrective',
    editableInputKeys: ['reason', 'replacementEventId'],
    inputSchema: schema({
      eventId: { type: 'string', format: 'uuid' },
      reason: { type: 'string', minLength: 1 },
      replacementEventId: nullableUuid,
    }, ['eventId', 'reason']),
    resolve: input => eventTarget(input.eventId),
    inspect: inspectEvent,
    preview: ({ target, input, current }) => ({
      summary: `Void the ${current.event_type.replaceAll('_', ' ')} event for ${target.label}.`,
      target,
      before: [{ field: 'voided_at', value: current.voided_at }],
      after: [
        { field: 'voided', value: true },
        { field: 'reason', value: input.reason },
        { field: 'replacement_event_id', value: input.replacementEventId || null },
      ],
      derivedEffects: [],
      warnings: ['The event remains in audit history and stops contributing to lifecycle reports.'],
      requiredReason: true,
    }),
    preconditions: ({ current }) => ({ voided_at: current.voided_at, replacement_event_id: current.replacement_event_id }),
    apply: ({ target, input }) => voidDirectLifecycleEvent(target.id, input),
    inspectAfter: ({ target }) => inspectEvent(target),
    affectedResources: ({ target }) => [
      target,
      { type: 'direct_position', id: target.investmentId, label: target.label },
    ],
  }),
];
