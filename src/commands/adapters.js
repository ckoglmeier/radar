import { getCommandProposal } from '../models/command-proposals.js';
import {
  commandMetadata,
  planCommandProposal,
  previewCommand,
  proposalHistory,
  reviseCommandProposal,
} from './service.js';

export function apiCommandMetadata() {
  return commandMetadata();
}

export async function apiPreviewCommand(name, body, context = {}) {
  return previewCommand({ name, version: body.version || 1, input: body.input, provenance: body.provenance }, context);
}

export async function apiProposeCommands(body, context = {}) {
  return planCommandProposal(body.commands, body.proposal, context);
}

export async function apiGetProposal(id) {
  return getCommandProposal(id);
}

export async function apiReviseProposal(id, expectedHash, edits, fields, context = {}) {
  return reviseCommandProposal(id, expectedHash, edits, fields, context);
}

export async function apiProposalHistory(options) {
  return proposalHistory(options);
}

export function mcpCommandTools() {
  return commandMetadata().commands.map(command => ({
    name: `radar_propose_${command.name.replaceAll('.', '_')}_v${command.version}`,
    title: command.title,
    description: `${command.description} Creates a review proposal; never applies it.`,
    inputSchema: command.inputSchema,
    command: { name: command.name, version: command.version },
  }));
}

export async function mcpProposeCommand(command, input, fields, context = {}) {
  return planCommandProposal([{ name: command.name, version: command.version, input, provenance: fields.provenance }], {
    originSurface: 'mcp',
    actorType: 'mcp_client',
    actorId: fields.actorId || null,
    intentText: fields.intentText || null,
    idempotencyKey: fields.idempotencyKey,
  }, context);
}
