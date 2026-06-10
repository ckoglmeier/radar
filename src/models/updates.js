// Parser + importer for company_updates.
// Markdown files under updates/ are the source of truth. This module parses
// YAML frontmatter + section presence and upserts into company_updates.
//
// Upsert key: (company_name, quarter). Content lives in the file, not the DB.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join, basename, resolve } from 'path';
import { query } from '../db/index.js';
import { withSyncRun } from '../db/sync-runs.js';
import { loadInvestmentUniverse, matchCompanyToInvestment } from '../utils/match.js';

const DEFAULT_DIR = 'updates';

// --- Parser ---

// Parse simple `key: value` YAML frontmatter. No nesting, no arrays.
// Values are returned as strings; caller coerces types.
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (!key) continue;
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return { frontmatter: fm, body: m[2] };
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNumber(v);
  return n == null ? null : Math.trunc(n);
}

// Detect whether a named section has user-written content.
// A section is "empty" if every line between its `## ` heading and the next `## ` heading
// (or EOF) is one of: blank, a `###` subheading, or a `<...>` template placeholder.
function hasSectionContent(body, sectionHeading) {
  const re = new RegExp(`^##\\s+${sectionHeading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`, 'm');
  const m = body.match(re);
  if (!m) return false;
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.search(/\n##\s+/);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  for (const line of section.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('###')) continue;                     // subsection heading
    if (t.startsWith('<') && t.endsWith('>')) continue;    // template placeholder
    if (t === '-' || t === '- <' || /^-\s*<.*>\s*$/.test(t)) continue; // bullet placeholder
    return true;
  }
  return false;
}

export function parseUpdateFile(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(text);

  if (!frontmatter.company || !frontmatter.quarter || !frontmatter.date) {
    return null;
  }

  return {
    file_path: filePath,
    company_name: frontmatter.company,
    quarter: frontmatter.quarter,
    update_date: frontmatter.date,
    revenue_arr: toNumber(frontmatter.arr),
    burn_rate: toNumber(frontmatter.burn),
    runway_months: toNumber(frontmatter.runway_months),
    headcount: toInt(frontmatter.headcount),
    cash_on_hand: toNumber(frontmatter.cash_on_hand),
    source: frontmatter.source || 'email',
    attachment_ref: frontmatter.attachment || null,
    has_review: hasSectionContent(body, 'Review \\(Claude\\)') || hasSectionContent(body, 'Review'),
    has_feedback: hasSectionContent(body, 'Feedback \\(CK\\)') || hasSectionContent(body, 'Feedback'),
  };
}

// --- Import ---

function walkMarkdown(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.endsWith('.md') && entry.toLowerCase() !== 'readme.md') out.push(full);
  }
  return out;
}

// Upsert all updates/*.md into company_updates, keyed on (company, quarter).
export async function importUpdates(dir = DEFAULT_DIR) {
  return withSyncRun('updates:import', `import ${resolve(dir)}`, async () => {
    return runUpdatesImport(dir);
  });
}

async function runUpdatesImport(dir) {
  const files = walkMarkdown(resolve(dir));
  const results = { total: files.length, imported: 0, updated: 0, skipped: 0, errors: 0, details: [] };
  const universe = await loadInvestmentUniverse();

  for (const filePath of files) {
    try {
      const parsed = parseUpdateFile(filePath);
      if (!parsed) {
        results.errors++;
        results.details.push({ file: basename(filePath), status: 'parse_error', error: 'missing required frontmatter (company/quarter/date)' });
        continue;
      }

      // Resolve investment_id (best-effort, company level)
      let investment_id = null;
      const match = await matchCompanyToInvestment(parsed.company_name, { universe });
      if (match.confidence === 'exact' || match.confidence === 'token') {
        investment_id = match.investment_id;
      }

      const existing = await query(
        `SELECT id, has_review, has_feedback FROM company_updates
         WHERE company_name = $1 AND quarter = $2 LIMIT 1`,
        [parsed.company_name, parsed.quarter]
      );

      if (existing.length > 0) {
        await query(
          `UPDATE company_updates SET
             investment_id = $1, update_date = $2,
             revenue_arr = $3, burn_rate = $4, runway_months = $5,
             headcount = $6, cash_on_hand = $7,
             source = $8, attachment_ref = $9, file_path = $10,
             has_review = $11, has_feedback = $12,
             updated_at = NOW()
           WHERE id = $13`,
          [
            investment_id, parsed.update_date,
            parsed.revenue_arr, parsed.burn_rate, parsed.runway_months,
            parsed.headcount, parsed.cash_on_hand,
            parsed.source, parsed.attachment_ref, parsed.file_path,
            parsed.has_review, parsed.has_feedback,
            existing[0].id,
          ]
        );
        results.updated++;
        results.details.push({ file: basename(filePath), company: parsed.company_name, quarter: parsed.quarter, status: 'updated' });
      } else {
        await query(
          `INSERT INTO company_updates
             (company_name, investment_id, update_date, quarter,
              revenue_arr, burn_rate, runway_months, headcount, cash_on_hand,
              source, attachment_ref, file_path, has_review, has_feedback)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            parsed.company_name, investment_id, parsed.update_date, parsed.quarter,
            parsed.revenue_arr, parsed.burn_rate, parsed.runway_months,
            parsed.headcount, parsed.cash_on_hand,
            parsed.source, parsed.attachment_ref, parsed.file_path,
            parsed.has_review, parsed.has_feedback,
          ]
        );
        results.imported++;
        results.details.push({ file: basename(filePath), company: parsed.company_name, quarter: parsed.quarter, status: 'imported' });
      }
    } catch (err) {
      results.errors++;
      results.details.push({ file: basename(filePath), status: 'error', error: err.message });
    }
  }

  // sync_runs fields
  results.records_seen = results.total;
  results.records_new = results.imported;
  results.records_changed = results.updated;
  results.error_details = results.errors > 0
    ? results.details.filter(d => d.status === 'error' || d.status === 'parse_error')
    : null;

  return results;
}

// --- Queries ---

export async function listUpdates({ companyName, limit = 100, missingReview = false, missingFeedback = false } = {}) {
  const clauses = [];
  const params = [];
  if (companyName) {
    params.push(`%${companyName}%`);
    clauses.push(`LOWER(cu.company_name) ILIKE LOWER($${params.length})`);
  }
  if (missingReview) clauses.push(`cu.has_review = false`);
  if (missingFeedback) clauses.push(`cu.has_feedback = false`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  return query(
    `SELECT cu.*, i.invested AS inv_invested, i.status AS inv_status, i.round AS inv_round
     FROM company_updates cu
     LEFT JOIN investments i ON cu.investment_id = i.id
     ${where}
     ORDER BY cu.update_date DESC, cu.id DESC
     LIMIT $${params.length}`,
    params
  );
}

export async function getUpdateById(id) {
  const rows = await query(
    `SELECT cu.*, i.invested AS inv_invested, i.status AS inv_status, i.round AS inv_round
     FROM company_updates cu
     LEFT JOIN investments i ON cu.investment_id = i.id
     WHERE cu.id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function getUpdateTimeline(companyName) {
  return query(
    `SELECT * FROM company_updates
     WHERE LOWER(company_name) = LOWER($1)
     ORDER BY update_date ASC`,
    [companyName]
  );
}

// --- Scaffolder ---

function slugify(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Create a new update file from a template. Returns { path, created }.
export function scaffoldUpdate({ company, quarter, date, dir = DEFAULT_DIR }) {
  if (!company || !quarter) throw new Error('company and quarter are required');
  const slug = slugify(company);
  // Convert "Q1 2026" → "2026-Q1"
  const qMatch = quarter.match(/^\s*Q([1-4])\s+(\d{4})\s*$/);
  if (!qMatch) throw new Error(`quarter must be formatted as "Q1 2026", got: ${quarter}`);
  const filename = `${qMatch[2]}-Q${qMatch[1]}.md`;
  const companyDir = resolve(dir, slug);
  mkdirSync(companyDir, { recursive: true });
  const path = join(companyDir, filename);
  if (existsSync(path)) return { path, created: false };

  const today = date || new Date().toISOString().slice(0, 10);
  const content = `---
company: ${company}
quarter: ${quarter}
date: ${today}
arr:
burn:
runway_months:
headcount:
cash_on_hand:
source: email
attachment:
---

# ${company} — ${quarter} Update

## From the Founders

<paste the update content here>

## Review (Claude)

### Flags / interesting threads
<surprising metrics, trend changes, notable mentions>

### Bull read
<what's accelerating; upside case if this trajectory holds>

### Bear read
<what's slipping; what this could look like in 2 quarters>

### Net read
<one-line synthesis: the single thing to watch next quarter>

### Suggested followups
<specific questions CK should ask the founder>

## Feedback (CK)

<CK's notes, questions for the founder, action items>
`;
  writeFileSync(path, content, 'utf-8');
  return { path, created: true };
}
