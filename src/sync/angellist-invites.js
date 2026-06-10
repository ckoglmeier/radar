// Orchestrator: takes raw Gmail messages, parses them, upserts pipeline_invites,
// and records sync_runs / pipeline_events along the way.
//
// Raw messages are plain objects with:
//   { messageId, subject, from, receivedAt, text, html }
// This module is I/O-agnostic — the caller is responsible for fetching from Gmail
// (via MCP, API, or a saved JSON file) and passing them in.

import { parseInviteEmail, htmlToText } from './parsers/angellist-invite.js';
import { upsertInvite } from '../models/pipeline.js';
import { withSyncRun } from '../db/sync-runs.js';
import { loadInvestmentUniverse } from '../utils/match.js';

export async function ingestInviteMessages(rawMessages) {
  return withSyncRun(
    'gmail:angellist-invites',
    `${rawMessages.length} messages in batch`,
    async () => runInviteIngest(rawMessages)
  );
}

async function runInviteIngest(rawMessages) {
  // Load the investments universe once per batch — avoids a SELECT per invite
  // when matching hundreds of HTML uploads.
  const universe = await loadInvestmentUniverse();

  const stats = {
    seen: 0,
    new: 0,
    changed: 0,
    unchanged: 0,
    errors: 0,
    errorDetails: [],
    inserted: [],
    updated: [],
  };

  for (const raw of rawMessages) {
    stats.seen++;
    try {
      const text = raw.text || (raw.html ? htmlToText(raw.html) : '');
      const parsed = parseInviteEmail({
        subject: raw.subject,
        from: raw.from,
        receivedAt: raw.receivedAt,
        text,
        html: raw.html,
        messageId: raw.messageId,
      });

      const result = await upsertInvite(parsed, { universe });
      if (result.isNew) {
        stats.new++;
        stats.inserted.push({
          id: result.id,
          company: parsed.company_name,
          lead: parsed.lead,
          match: result.match?.confidence || 'unmatched',
        });
      } else if (result.changes.length > 0) {
        stats.changed++;
        stats.updated.push({
          id: result.id,
          company: parsed.company_name,
          changes: result.changes.map(c => c.field),
        });
      } else {
        stats.unchanged++;
      }
    } catch (err) {
      stats.errors++;
      stats.errorDetails.push({
        messageId: raw.messageId,
        subject: raw.subject,
        error: err.message,
      });
    }
  }

  // sync_runs fields
  stats.records_seen = stats.seen;
  stats.records_new = stats.new;
  stats.records_changed = stats.changed;
  stats.error_details = stats.errorDetails.length > 0 ? stats.errorDetails : null;

  return stats;
}
