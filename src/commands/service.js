import { randomUUID } from 'node:crypto';
import { query, withAtomicWrite } from '../db/index.js';
import {
  createCommandProposal,
  getCommandProposal,
  markCommandProposalApplied,
  markCommandProposalFailed,
  markCommandProposalStale,
} from '../models/command-proposals.js';
import { canonicalHash, commandHash, commandSetHash, NORMALIZER_VERSION } from './canonical.js';
import { CommandError } from './errors.js';
import { createCommandRegistry } from './registry.js';
import { tierACommandDefinitions } from './tier-a.js';
import { tierBCommandDefinitions } from './tier-b.js';

export const commandRegistry = createCommandRegistry([...tierACommandDefinitions, ...tierBCommandDefinitions]);

function jsonValue(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function targetEqual(left, right) {
  return canonicalHash(left) === canonicalHash(right);
}

function affectedTargets(target, current) {
  if (!Array.isArray(current?.effects)) return [target];
  return [
    target,
    ...current.effects.map(effect => ({ type: 'employment_equity_position', id: effect.investment_id })),
  ];
}

export function commandMetadata() {
  return {
    registry_version: commandRegistry.registryVersion(),
    normalizer_version: NORMALIZER_VERSION,
    commands: commandRegistry.metadata(),
  };
}

export async function previewCommand(candidate, context = {}) {
  const version = candidate.version || 1;
  const definition = commandRegistry.get(candidate.name, version);
  if (!(await definition.availability(context))) {
    throw new CommandError('COMMAND_WRITE_UNAVAILABLE', 'Recording changes requires Radar Desktop.');
  }
  const input = commandRegistry.validateInput(candidate.name, version, candidate.input);
  const target = await definition.resolve(input, context);
  const current = await definition.inspect(target, input, context);
  const preview = await definition.preview({ target, input, current }, context);
  const preconditions = await definition.preconditions({ target, input, current }, context);
  const provenance = candidate.provenance || { kind: 'user_attested' };
  const command = {
    id: candidate.id || randomUUID(),
    name: definition.name,
    version: definition.version,
    risk: definition.risk,
    target,
    affected_targets: affectedTargets(target, current),
    input,
    provenance,
    preconditions,
    precondition_hash: canonicalHash(preconditions),
  };
  command.command_hash = commandHash(command);
  return { command, preview: { ...preview, preconditions } };
}

export async function planCommandProposal(candidates, fields = {}, context = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new CommandError('COMMANDS_REQUIRED', 'At least one command is required.');
  }
  const planned = [];
  for (const candidate of candidates) planned.push(await previewCommand(candidate, context));
  const commands = planned.map(item => item.command);
  const registryVersion = commandRegistry.registryVersion();
  const setHash = commandSetHash({ registryVersion, commands });
  return createCommandProposal({
    ...fields,
    registryVersion,
    normalizerVersion: NORMALIZER_VERSION,
    commands,
    previews: planned.map(item => item.preview),
    commandSetHash: setHash,
    idempotencyKey: fields.idempotencyKey || `proposal:${setHash}`,
  });
}

async function assertCorrectionGucsOff() {
  const [row] = await query(`
    SELECT current_setting('radar.allow_fund_valuation_correction', TRUE) AS fund,
           current_setting('radar.allow_direct_valuation_correction', TRUE) AS direct
  `);
  if (row.fund === 'on' || row.direct === 'on') {
    throw new CommandError('CORRECTION_SCOPE_LEAK', 'A valuation correction scope remained enabled.');
  }
}

function hasCapabilities(required, held) {
  const capabilitySet = new Set(held || []);
  return required.every(capability => capabilitySet.has(capability));
}

export async function applyCommandProposal(proposalId, expectedHash, fields = {}, context = {}) {
  let completed;
  try {
    completed = await withAtomicWrite(async () => {
      const proposal = await getCommandProposal(proposalId, { lock: true });
      if (!proposal) throw new CommandError('PROPOSAL_NOT_FOUND', `Proposal not found: ${proposalId}`);
      if (proposal.command_set_hash !== expectedHash) {
        throw new CommandError('PROPOSAL_HASH_MISMATCH', 'The reviewed proposal hash does not match.');
      }
      if (proposal.status === 'applied') return { proposal, receipt: jsonValue(proposal.result), idempotent_replay: true };
      if (proposal.status !== 'proposed') {
        throw new CommandError('PROPOSAL_NOT_APPLICABLE', `Proposal is ${proposal.status}.`);
      }
      if (proposal.registry_version !== commandRegistry.registryVersion()) {
        const stale = await markCommandProposalStale(proposal.id, expectedHash, {
          errorCode: 'REGISTRY_VERSION_CHANGED', errorMessage: 'The command registry changed. Review a new proposal.',
        });
        return { proposal: stale, receipt: null, stale: true };
      }

      const commands = jsonValue(proposal.commands);
      const calculatedSetHash = commandSetHash({ registryVersion: proposal.registry_version, commands });
      if (calculatedSetHash !== proposal.command_set_hash) {
        throw new CommandError('PROPOSAL_PAYLOAD_INVALID', 'Stored proposal hashes do not verify.');
      }

      for (const command of commands) {
        const definition = commandRegistry.get(command.name, command.version);
        if (!hasCapabilities(definition.applyCapabilities, fields.actorCapabilities)) {
          throw new CommandError('COMMAND_CAPABILITY_DENIED', `Missing capability for ${command.name}.`);
        }
        commandRegistry.validateInput(command.name, command.version, command.input);
        if (commandHash(command) !== command.command_hash) {
          throw new CommandError('COMMAND_HASH_MISMATCH', `Stored command hash failed for ${command.name}.`);
        }
        const target = await definition.resolve(command.input, context);
        if (!targetEqual(target, command.target)) {
          const stale = await markCommandProposalStale(proposal.id, expectedHash, {
            errorMessage: `${command.name} target changed.`,
          });
          return { proposal: stale, receipt: null, stale: true };
        }
        const current = await definition.inspect(target, command.input, context);
        const preconditions = await definition.preconditions({ target, input: command.input, current }, context);
        if (canonicalHash(preconditions) !== command.precondition_hash) {
          const stale = await markCommandProposalStale(proposal.id, expectedHash, {
            errorMessage: `${command.name} inputs or target state changed.`,
          });
          return { proposal: stale, receipt: null, stale: true };
        }
      }

      const results = [];
      await assertCorrectionGucsOff();
      for (const command of commands) {
        const definition = commandRegistry.get(command.name, command.version);
        const result = await definition.apply({
          target: command.target,
          input: command.input,
          provenance: { ...command.provenance, proposal_id: proposal.id },
          idempotencyKey: `proposal:${proposal.id}:${command.id}`,
        }, context);
        await assertCorrectionGucsOff();
        const normalizedResult = commandRegistry.validateResult(command.name, command.version, result);
        results.push({
          command_id: command.id,
          name: command.name,
          version: command.version,
          result: normalizedResult,
          affected_resources: await definition.affectedResources({ target: command.target, result: normalizedResult }),
        });
      }
      const receipt = {
        proposal_id: proposal.id,
        command_set_hash: proposal.command_set_hash,
        registry_version: proposal.registry_version,
        applied_at: new Date().toISOString(),
        commands: results,
      };
      const applied = await markCommandProposalApplied(proposal.id, expectedHash, {
        result: receipt,
        reviewedBy: fields.reviewedBy || 'local_user',
      });
      if (!applied) throw new CommandError('PROPOSAL_CONCURRENT_TRANSITION', 'Proposal changed during apply.');
      return { proposal: applied, receipt, idempotent_replay: false };
    });
    return completed;
  } catch (error) {
    if (error.code && !['PROPOSAL_NOT_FOUND', 'PROPOSAL_HASH_MISMATCH', 'PROPOSAL_NOT_APPLICABLE'].includes(error.code)) {
      try {
        await markCommandProposalFailed(proposalId, expectedHash, {
          errorCode: error.code || 'COMMAND_APPLY_FAILED',
          errorMessage: error.message,
        });
      } catch {
        // A concurrent terminal transition wins; preserve the original failure.
      }
    } else if (!error.code) {
      try {
        await markCommandProposalFailed(proposalId, expectedHash, {
          errorCode: 'COMMAND_APPLY_FAILED', errorMessage: error.message,
        });
      } catch {
        // A concurrent terminal transition wins; preserve the original failure.
      }
    }
    throw error;
  }
}

export async function proposalHistory(options) {
  const { listCommandProposals } = await import('../models/command-proposals.js');
  return listCommandProposals(options);
}
