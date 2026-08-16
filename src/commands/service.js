import { randomUUID } from 'node:crypto';
import { query, withAtomicWrite } from '../db/index.js';
import {
  createCommandProposal,
  getCommandProposal,
  markCommandProposalApplied,
  markCommandProposalFailed,
  markCommandProposalStale,
  supersedeCommandProposal,
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

export async function reviseCommandProposal(proposalId, expectedHash, edits, fields = {}, context = {}) {
  const proposal = await getCommandProposal(proposalId);
  if (!proposal) throw new CommandError('PROPOSAL_NOT_FOUND', `Proposal not found: ${proposalId}`);
  if (proposal.command_set_hash !== expectedHash) {
    throw new CommandError('PROPOSAL_HASH_MISMATCH', 'The reviewed proposal hash does not match.');
  }
  if (proposal.status !== 'proposed') {
    throw new CommandError('PROPOSAL_NOT_EDITABLE', `Proposal is ${proposal.status}.`);
  }
  if (proposal.registry_version !== commandRegistry.registryVersion()) {
    throw new CommandError('REGISTRY_VERSION_CHANGED', 'The command registry changed. Ask Radar to create a fresh proposal.');
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new CommandError('PROPOSAL_EDITS_REQUIRED', 'Change at least one proposed value before saving.');
  }

  const commands = jsonValue(proposal.commands);
  const byId = new Map(commands.map(command => [command.id, command]));
  const seen = new Set();
  const editedInputs = new Map();
  for (const edit of edits) {
    const command = byId.get(edit?.commandId);
    if (!command || seen.has(edit.commandId) || !edit.input || typeof edit.input !== 'object' || Array.isArray(edit.input)) {
      throw new CommandError('PROPOSAL_EDIT_INVALID', 'The proposal edit does not match one reviewed command.');
    }
    seen.add(edit.commandId);
    const definition = commandRegistry.get(command.name, command.version);
    const allowed = new Set(definition.editableInputKeys || []);
    for (const key of Object.keys(edit.input)) {
      if (!allowed.has(key)) {
        throw new CommandError('PROPOSAL_EDIT_NOT_ALLOWED', `${command.name}.${key} cannot be changed during review.`);
      }
    }
    editedInputs.set(command.id, { ...command.input, ...edit.input });
  }

  const hasChange = commands.some(command => editedInputs.has(command.id)
    && canonicalHash(editedInputs.get(command.id)) !== canonicalHash(command.input));
  if (!hasChange) {
    throw new CommandError('PROPOSAL_EDIT_UNCHANGED', 'Change at least one proposed value before saving.');
  }

  const planned = [];
  for (const command of commands) {
    planned.push(await previewCommand({
      id: command.id,
      name: command.name,
      version: command.version,
      input: editedInputs.get(command.id) || command.input,
      provenance: {
        ...(command.provenance || {}),
        review_edit: { reviewed_by: fields.reviewedBy || 'local_user' },
      },
    }, context));
  }
  const revisedCommands = planned.map(item => item.command);
  const registryVersion = commandRegistry.registryVersion();
  const setHash = commandSetHash({ registryVersion, commands: revisedCommands });
  const replacementFields = {
    originSurface: proposal.origin_surface,
    actorType: proposal.actor_type,
    actorId: proposal.actor_id,
    intentText: proposal.intent_text,
    sourceDocumentId: proposal.source_document_id,
    sourceUpdateId: proposal.source_update_id,
    plannerProvider: proposal.planner_provider,
    plannerModel: proposal.planner_model,
    plannerRunKey: proposal.planner_run_key,
    registryVersion,
    normalizerVersion: NORMALIZER_VERSION,
    commands: revisedCommands,
    previews: planned.map(item => item.preview),
    commandSetHash: setHash,
    idempotencyKey: `proposal-revision:${proposal.id}:${setHash}`,
  };
  const revised = await supersedeCommandProposal(proposal.id, expectedHash, replacementFields);
  if (!revised.replacement) {
    throw new CommandError('PROPOSAL_CONCURRENT_TRANSITION', 'Proposal changed while the edit was being saved.');
  }
  return revised;
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

function validateOverrideAuthorizations(commands, fields) {
  const overrides = commands.filter(command => command.risk === 'explicit_override');
  if (overrides.length === 0) return [];
  const supplied = Array.isArray(fields.overrideAuthorizations) ? fields.overrideAuthorizations : [];
  const byCommand = new Map();
  for (const authorization of supplied) {
    if (!authorization?.commandId || byCommand.has(authorization.commandId)) {
      throw new CommandError(
        'COMMAND_OVERRIDE_PERMISSION_REQUIRED',
        'Each generic write override needs its own one-time permission.',
        { required_command_ids: overrides.map(command => command.id) },
      );
    }
    byCommand.set(authorization.commandId, authorization);
  }
  if (byCommand.size !== overrides.length) {
    throw new CommandError(
      'COMMAND_OVERRIDE_PERMISSION_REQUIRED',
      'Each generic write override needs its own one-time permission.',
      { required_command_ids: overrides.map(command => command.id) },
    );
  }
  return overrides.map(command => {
    const authorization = byCommand.get(command.id);
    const grantedBy = String(authorization?.grantedBy || '').trim();
    const reason = String(authorization?.reason || '').trim();
    if (authorization?.permission !== 'single_use' || authorization?.commandHash !== command.command_hash || !grantedBy || grantedBy !== fields.reviewedBy || !reason) {
      throw new CommandError(
        'COMMAND_OVERRIDE_PERMISSION_REQUIRED',
        `Override permission for ${command.target?.label || command.id} is missing or does not match the reviewed change.`,
        { required_command_id: command.id },
      );
    }
    return {
      command_id: command.id,
      command_hash: command.command_hash,
      permission: 'single_use',
      granted_by: grantedBy,
      reason,
      granted_at: new Date().toISOString(),
    };
  });
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

      const overrideAuthorizations = validateOverrideAuthorizations(commands, fields);

      for (const command of commands) {
        const definition = commandRegistry.get(command.name, command.version);
        if (!hasCapabilities(definition.applyCapabilities, fields.actorCapabilities)) {
          throw new CommandError(
            'COMMAND_CAPABILITY_DENIED',
            `This change needs ${definition.applyCapabilities.join(', ')} permission. Nothing was applied.`,
            {
              command: command.name,
              required_capabilities: definition.applyCapabilities,
              held_capabilities: fields.actorCapabilities || [],
            },
          );
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
        override_authorizations: overrideAuthorizations,
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
    if (error.code && ![
      'PROPOSAL_NOT_FOUND',
      'PROPOSAL_HASH_MISMATCH',
      'PROPOSAL_NOT_APPLICABLE',
      'COMMAND_CAPABILITY_DENIED',
      'COMMAND_OVERRIDE_PERMISSION_REQUIRED',
    ].includes(error.code)) {
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
