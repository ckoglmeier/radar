// Composed attention report for the Phase 8 Cockpit.
// Every signal here is derived from real engine state. Deferred signals, such
// as follow-on due dates, stay out until the engine has a real source.

import { query } from '../db/index.js';
import { evalReconcile } from './evaluations.js';

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function daysBetween(a, b) {
  const start = new Date(isoDate(a));
  const end = new Date(isoDate(b));
  return Math.floor((end - start) / (1000 * 60 * 60 * 24));
}

function addDays(date, days) {
  const d = new Date(isoDate(date));
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function addYears(date, years) {
  const d = new Date(isoDate(date));
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

export async function qsbsWindowItems({ today, windowDays }) {
  const rows = await query(`
    SELECT id, company_name, invest_date, invested, round, market
    FROM investments
    WHERE asset_class = 'direct'
      AND status = 'Live'
      AND qsbs_eligible = TRUE
      AND invest_date IS NOT NULL
    ORDER BY invest_date ASC, company_name ASC
  `);

  return rows
    .map(row => {
      const qsbsDate = addYears(row.invest_date, 5);
      const daysUntil = daysBetween(today, qsbsDate);
      return {
        type: 'qsbs_window',
        severity: daysUntil <= 0 ? 'ready' : 'soon',
        investment_id: row.id,
        company_name: row.company_name,
        invest_date: isoDate(row.invest_date),
        qsbs_5yr_date: qsbsDate,
        qsbs_5yr_met: daysUntil <= 0,
        days_until: daysUntil,
        invested: row.invested,
        round: row.round,
        market: row.market,
      };
    })
    .filter(item => item.qsbs_5yr_met || item.days_until <= windowDays)
    .sort((a, b) => a.days_until - b.days_until || a.company_name.localeCompare(b.company_name));
}

export async function quietFounderItems({ today, quietDays, limit }) {
  const rows = await query(`
    SELECT
      i.id AS investment_id,
      i.company_name,
      i.status,
      i.invest_date,
      i.invested,
      MAX(cu.update_date) AS latest_update_date
    FROM investments i
    LEFT JOIN company_updates cu
      ON cu.investment_id = i.id OR LOWER(cu.company_name) = LOWER(i.company_name)
    WHERE i.asset_class = 'direct' AND i.status = 'Live'
    GROUP BY i.id, i.company_name, i.status, i.invest_date, i.invested
    ORDER BY MAX(cu.update_date) ASC NULLS FIRST, i.company_name ASC
    LIMIT $1
  `, [limit]);

  return rows
    .map(row => {
      const latest = isoDate(row.latest_update_date);
      const daysSince = latest ? daysBetween(latest, today) : null;
      const fallbackDue = row.invest_date ? addDays(row.invest_date, quietDays) : null;
      return {
        type: 'quiet_founder',
        severity: !latest || daysSince >= quietDays * 2 ? 'stale' : 'quiet',
        investment_id: row.investment_id,
        company_name: row.company_name,
        latest_update_date: latest,
        days_since_update: daysSince,
        quiet_days_threshold: quietDays,
        next_expected_update: latest ? addDays(latest, quietDays) : fallbackDue,
        invested: row.invested,
      };
    })
    .filter(item => item.days_since_update == null || item.days_since_update >= quietDays);
}

export async function roomCapitalCallItems({ limit }) {
  const rows = await query(`
    SELECT
      rp.id,
      rp.room_id,
      r.name AS room_name,
      rp.pipeline_invite_id,
      rp.cells,
      pi.company_name AS pipeline_company,
      pi.status AS pipeline_status
    FROM room_pipeline rp
    JOIN rooms r ON r.id = rp.room_id
    LEFT JOIN pipeline_invites pi ON pi.id = rp.pipeline_invite_id
    WHERE LOWER(rp.cells::text) LIKE '%capital_call%'
       OR LOWER(rp.cells::text) LIKE '%capital call%'
       OR LOWER(rp.cells::text) LIKE '%capital-call%'
    ORDER BY rp.id DESC
    LIMIT $1
  `, [limit]);

  return rows.map(row => ({
    type: 'room_capital_call',
    severity: 'attention',
    room_id: row.room_id,
    room_name: row.room_name,
    room_pipeline_id: row.id,
    pipeline_invite_id: row.pipeline_invite_id,
    company_name: row.pipeline_company || row.cells?.company || row.cells?.name || null,
    pipeline_status: row.pipeline_status,
    cells: row.cells,
  }));
}

export async function clusterExposure({ thesis, market, limit = 20 } = {}) {
  const clauses = [];
  const params = [];

  if (market) {
    params.push(market);
    clauses.push(`LOWER(i.market) = LOWER($${params.length})`);
  }
  if (thesis) {
    params.push(thesis);
    clauses.push(`LOWER(t.name) = LOWER($${params.length})`);
  }

  clauses.unshift(`i.asset_class = 'direct'`);
  const where = `WHERE ${clauses.join(' AND ')}`;
  params.push(limit);

  const rows = await query(`
    SELECT
      i.id,
      i.company_name,
      i.market,
      i.round,
      i.status,
      i.invested,
      COALESCE(ie.best_total_value, i.net_value, i.invested) AS net_value,
      COALESCE(
        (SELECT string_agg(t2.name, ', ' ORDER BY t2.name)
         FROM investment_theses it2
         JOIN theses t2 ON t2.id = it2.thesis_id
         WHERE it2.investment_id = i.id),
        ''
      ) AS theses
    FROM investments i
    LEFT JOIN investments_effective ie ON ie.id = i.id
    LEFT JOIN investment_theses it ON it.investment_id = i.id
    LEFT JOIN theses t ON t.id = it.thesis_id
    ${where}
    GROUP BY i.id, i.company_name, i.market, i.round, i.status, i.invested, i.net_value, ie.best_total_value
    ORDER BY COALESCE(i.invested, 0) DESC, i.company_name ASC
    LIMIT $${params.length}
  `, params);

  return {
    filters: { thesis: thesis || null, market: market || null },
    count: rows.length,
    invested: rows.reduce((sum, row) => sum + Number(row.invested || 0), 0),
    net_value: rows.reduce((sum, row) => sum + Number(row.net_value || 0), 0),
    companies: rows,
  };
}

export async function relatedDeals({ companyName, market, thesis, limit = 8 } = {}) {
  const clauses = [];
  const params = [];

  if (companyName) {
    params.push(companyName);
    clauses.push(`LOWER(i.company_name) <> LOWER($${params.length})`);
  }
  if (market) {
    params.push(market);
    clauses.push(`LOWER(i.market) = LOWER($${params.length})`);
  }
  if (thesis) {
    params.push(thesis);
    clauses.push(`LOWER(t.name) = LOWER($${params.length})`);
  }

  clauses.unshift(`i.asset_class = 'direct'`);
  const where = `WHERE ${clauses.join(' AND ')}`;
  params.push(limit);

  return query(`
    SELECT DISTINCT
      i.id,
      i.company_name,
      i.market,
      i.round,
      i.status,
      i.invested,
      COALESCE(ie.best_multiple, i.multiple) AS multiple
    FROM investments i
    LEFT JOIN investments_effective ie ON ie.id = i.id
    LEFT JOIN investment_theses it ON it.investment_id = i.id
    LEFT JOIN theses t ON t.id = it.thesis_id
    ${where}
    ORDER BY i.company_name ASC
    LIMIT $${params.length}
  `, params);
}

export async function attentionReport(opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const thresholds = {
    qsbs_window_days: opts.qsbsWindowDays ?? 180,
    quiet_days: opts.quietDays ?? 120,
    reconcile_threshold: opts.reconcileThreshold ?? 39,
  };
  const limit = opts.limit ?? 10;

  const [qsbs, quietFounders, reconcile, roomCapitalCalls] = await Promise.all([
    qsbsWindowItems({ today, windowDays: thresholds.qsbs_window_days }),
    quietFounderItems({ today, quietDays: thresholds.quiet_days, limit }),
    evalReconcile({ threshold: thresholds.reconcile_threshold }),
    roomCapitalCallItems({ limit }),
  ]);

  return {
    generated_at: today,
    thresholds,
    queues: {
      qsbs,
      quiet_founders: quietFounders,
      eval_reconcile: reconcile,
      room_capital_calls: roomCapitalCalls,
    },
    counts: {
      qsbs: qsbs.length,
      quiet_founders: quietFounders.length,
      eval_reconcile: reconcile.total,
      room_capital_calls: roomCapitalCalls.length,
    },
  };
}
