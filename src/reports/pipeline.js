// Pure data fetchers for pipeline reports. Thin wrappers over the model layer
// so the CLI and future web GUI consume one stable shape.

import { listInvites, getInviteBySlug, getEventsForInvite } from '../models/pipeline.js';

export async function pipelineList({ status, limit } = {}) {
  return listInvites({ status, limit });
}

export async function pipelineDetail(slug) {
  return getInviteBySlug(slug);
}

export async function pipelineEvents(slug) {
  const invite = await getInviteBySlug(slug);
  if (!invite) return { invite: null, events: [] };
  const events = await getEventsForInvite(invite.id);
  return { invite, events };
}
