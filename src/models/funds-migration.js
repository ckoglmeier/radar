import { createHash } from 'node:crypto';
import { isPgliteActive, query } from '../db/index.js';
import { normalize } from '../utils/company-names.js';

const MANIFEST_VERSION = 1;

function stableValue(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function candidateHash(candidate) {
  const { candidate_hash, decision, ...audited } = candidate;
  return hash(audited);
}

function activityType(flow) {
  const amount = Number(flow.amount);
  if (flow.type === 'investment' && amount < 0) return 'contribution';
  if (['distribution', 'refund'].includes(flow.type) && amount > 0) return 'distribution';
  if (flow.type === 'fee' && amount < 0) return 'fee';
  return null;
}

function fundStatusFromLegacy(status) {
  if (status === 'Realized') return 'realized';
  if (status === 'Written Off') return 'written_off';
  return 'active';
}

function profileSource(position) {
  return stableValue({
    id: Number(position.id),
    position_key: position.position_key,
    company_name: position.company_name,
    asset_class: position.asset_class,
    portfolio_entity_id: position.portfolio_entity_id,
    entity_type: position.entity_type,
    status: position.status,
    investment_entity: position.investment_entity,
  });
}

function flowSource(flow) {
  return stableValue({
    id: Number(flow.id),
    investment_id: flow.investment_id == null ? null : Number(flow.investment_id),
    flow_date: flow.flow_date,
    type: flow.type,
    amount: flow.amount,
    description: flow.description,
    company_raw: flow.company_raw,
    spv_raw: flow.spv_raw,
    source: flow.source,
    external_hash: flow.external_hash,
    reconciliation_status: flow.reconciliation_status,
    reconciliation_note: flow.reconciliation_note,
  });
}

export async function buildFundsMigrationManifest() {
  const positions = await query(`
    SELECT i.id, i.position_key, i.company_name, i.asset_class,
           i.portfolio_entity_id, i.status, i.investment_entity,
           pe.legal_name, pe.entity_type
      FROM investments i
      JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
     WHERE i.asset_class = 'fund'
     ORDER BY i.id
  `);
  const validPositions = positions.filter(position => position.entity_type === 'fund_vehicle');
  const fundIds = validPositions.map(position => Number(position.id));
  const flows = fundIds.length === 0 ? [] : await query(`
    SELECT id, investment_id, flow_date, type, amount, description,
           company_raw, spv_raw, source, external_hash,
           reconciliation_status, reconciliation_note
      FROM cash_flows
     WHERE investment_id = ANY($1::int[])
        OR reconciliation_status IN ('fund', 'ignored')
     ORDER BY id
  `, [fundIds]);
  const fundNames = validPositions.map(position => ({
    investment_id: Number(position.id),
    names: new Set([normalize(position.company_name), normalize(position.legal_name)].filter(Boolean)),
  }));

  const profileCandidates = validPositions.map(position => {
    const source = profileSource(position);
    const candidate = {
      investment_id: Number(position.id),
      position_key: position.position_key,
      legal_name: position.legal_name,
      fund_status: fundStatusFromLegacy(position.status),
      migration_key: `investment-backfill:${position.id}`,
      source,
      source_hash: hash(source),
      decision: null,
    };
    candidate.candidate_hash = candidateHash(candidate);
    return candidate;
  });

  const flowCandidates = flows.map(flow => {
    const linkedId = flow.investment_id == null ? null : Number(flow.investment_id);
    const normalizedReferences = new Set([
      normalize(flow.spv_raw || ''),
      normalize(flow.company_raw || ''),
    ].filter(Boolean));
    const matchingIds = linkedId && fundIds.includes(linkedId)
      ? [linkedId]
      : fundNames
        .filter(fund => [...normalizedReferences].some(reference => fund.names.has(reference)))
        .map(fund => fund.investment_id);
    const source = flowSource(flow);
    const candidate = {
      cash_flow_id: Number(flow.id),
      source,
      source_hash: hash(source),
      eligible_activity_type: activityType(flow),
      candidate_investment_ids: [...new Set(matchingIds)].sort((a, b) => a - b),
      decision: null,
    };
    candidate.candidate_hash = candidateHash(candidate);
    return candidate;
  }).filter(candidate =>
    (candidate.source.investment_id != null && fundIds.includes(candidate.source.investment_id)) ||
    candidate.source.reconciliation_status === 'fund' ||
    candidate.candidate_investment_ids.length > 0
  );

  const conflicts = positions
    .filter(position => position.entity_type !== 'fund_vehicle')
    .map(position => ({
      type: 'invalid_fund_entity_link',
      investment_id: Number(position.id),
      entity_type: position.entity_type,
    }));
  const manifest = {
    manifest_version: MANIFEST_VERSION,
    profile_candidates: profileCandidates,
    flow_candidates: flowCandidates,
    conflicts,
  };
  manifest.manifest_hash = hash(manifest);
  return manifest;
}

function verifyCandidate(candidate, kind) {
  const actual = candidateHash(candidate);
  if (candidate.candidate_hash !== actual) {
    throw new Error(`${kind} candidate was modified after audit`);
  }
}

async function begin() {
  await query('BEGIN');
}

async function rollback() {
  try {
    await query('ROLLBACK');
  } catch {
    // Preserve the operation error.
  }
}

export async function applyFundsMigrationManifest(manifest) {
  if (!(await isPgliteActive())) {
    throw new Error('Fund migration apply requires local PGlite transaction support');
  }
  if (!manifest || manifest.manifest_version !== MANIFEST_VERSION) {
    throw new Error('unsupported Fund migration manifest');
  }
  if (manifest.conflicts?.length) throw new Error('Fund migration manifest has unresolved conflicts');
  for (const candidate of manifest.profile_candidates || []) {
    verifyCandidate(candidate, 'Fund profile');
    if (!['migrate', 'leave_untyped'].includes(candidate.decision?.action)) {
      throw new Error(`Fund profile ${candidate.investment_id} needs an explicit decision`);
    }
  }
  for (const candidate of manifest.flow_candidates || []) {
    verifyCandidate(candidate, 'Fund cash flow');
    if (!['attach', 'leave_unresolved'].includes(candidate.decision?.action)) {
      throw new Error(`Fund cash flow ${candidate.cash_flow_id} needs an explicit decision`);
    }
    if (candidate.decision.action === 'attach') {
      if (!candidate.eligible_activity_type) {
        throw new Error(`Fund cash flow ${candidate.cash_flow_id} has an ineligible type or sign`);
      }
      const targetId = Number(candidate.decision.investment_id);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        throw new Error(`Fund cash flow ${candidate.cash_flow_id} needs a valid target position`);
      }
    }
  }

  const selectedProfiles = (manifest.profile_candidates || [])
    .filter(candidate => candidate.decision.action === 'migrate');
  const selectedTargetIds = new Set(selectedProfiles.map(candidate => Number(candidate.investment_id)));
  const orphanedSelections = (manifest.flow_candidates || []).filter(candidate =>
    candidate.decision.action === 'attach' &&
    !selectedTargetIds.has(Number(candidate.decision.investment_id))
  );
  if (orphanedSelections.length) {
    throw new Error('an attached Fund cash flow targets a profile not approved for migration');
  }

  const reports = [];
  for (const candidate of selectedProfiles) {
    const investmentId = Number(candidate.investment_id);
    const selectedFlows = (manifest.flow_candidates || []).filter(flow =>
      flow.decision.action === 'attach' && Number(flow.decision.investment_id) === investmentId
    );
    await begin();
    try {
      const [position] = await query(`
        SELECT i.id, i.position_key, i.company_name, i.asset_class,
               i.portfolio_entity_id, i.status, i.investment_entity,
               pe.legal_name, pe.entity_type
          FROM investments i
          JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
         WHERE i.id = $1
         FOR UPDATE OF i
      `, [investmentId]);
      if (!position || position.asset_class !== 'fund' || position.entity_type !== 'fund_vehicle') {
        throw new Error(`Fund migration target is no longer valid: ${investmentId}`);
      }
      const [existingProfile] = await query(`
        SELECT * FROM fund_profiles WHERE investment_id = $1 FOR UPDATE
      `, [investmentId]);
      if (!existingProfile && hash(profileSource(position)) !== candidate.source_hash) {
        throw new Error(`Fund profile source is stale: ${investmentId}`);
      }
      let profileCreated = 0;
      if (!existingProfile) {
        await query(`
          INSERT INTO fund_profiles (investment_id, fund_status, migration_key)
          VALUES ($1, $2, $3)
        `, [investmentId, candidate.fund_status, candidate.migration_key]);
        profileCreated = 1;
      } else if (existingProfile.migration_key && existingProfile.migration_key !== candidate.migration_key) {
        throw new Error(`Fund profile ${investmentId} has a different migration origin`);
      }

      let flowsAttached = 0;
      let flowsUnchanged = 0;
      for (const flowCandidate of selectedFlows) {
        const [existingTransaction] = await query(`
          SELECT * FROM fund_transactions WHERE cash_flow_id = $1
        `, [flowCandidate.cash_flow_id]);
        if (existingTransaction) {
          if (
            Number(existingTransaction.investment_id) !== investmentId ||
            existingTransaction.activity_type !== flowCandidate.eligible_activity_type ||
            existingTransaction.voided_at
          ) {
            throw new Error(`Fund cash flow ${flowCandidate.cash_flow_id} has conflicting metadata`);
          }
          flowsUnchanged += 1;
          continue;
        }
        const [flow] = await query(`
          SELECT id, investment_id, flow_date, type, amount, description,
                 company_raw, spv_raw, source, external_hash,
                 reconciliation_status, reconciliation_note
            FROM cash_flows WHERE id = $1 FOR UPDATE
        `, [flowCandidate.cash_flow_id]);
        if (!flow || hash(flowSource(flow)) !== flowCandidate.source_hash) {
          throw new Error(`Fund cash flow source is stale: ${flowCandidate.cash_flow_id}`);
        }
        if (flow.investment_id != null && Number(flow.investment_id) !== investmentId) {
          throw new Error(`Fund cash flow ${flow.id} is linked to another position`);
        }
        await query(`
          UPDATE cash_flows
             SET investment_id = $1,
                 reconciliation_status = 'matched',
                 reconciliation_note = $2,
                 reconciled_at = NOW()
           WHERE id = $3
        `, [investmentId, `Reviewed Fund migration to ${position.company_name}`, flow.id]);
        await query(`
          INSERT INTO fund_transactions
            (investment_id, cash_flow_id, activity_type, external_hash)
          VALUES ($1, $2, $3, $4)
        `, [
          investmentId,
          flow.id,
          flowCandidate.eligible_activity_type,
          `legacy-cash-flow:${flow.id}`,
        ]);
        flowsAttached += 1;
      }
      await query('COMMIT');
      reports.push({
        investment_id: investmentId,
        status: 'committed',
        profile_created: profileCreated,
        flows_attached: flowsAttached,
        flows_unchanged: flowsUnchanged,
      });
    } catch (error) {
      await rollback();
      reports.push({ investment_id: investmentId, status: 'failed', error: error.message });
    }
  }

  return {
    reports,
    unresolved_flows: (manifest.flow_candidates || [])
      .filter(candidate => candidate.decision.action === 'leave_unresolved')
      .map(candidate => candidate.cash_flow_id),
    failed: reports.filter(report => report.status === 'failed').length,
  };
}
