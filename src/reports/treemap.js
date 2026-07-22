// Treemap composition data for portfolio visualization.
// Returns D3-compatible hierarchical structure with sizing and color dimensions.

import { query } from '../db/index.js';

function colorBucket(tvpi) {
  if (tvpi == null) return 'gray';
  if (tvpi < 1) return 'red';
  if (tvpi <= 2) return 'yellow';
  return 'green';
}

function computeTvpi(currentValue, invested) {
  if (!invested || invested <= 0) return null;
  return Math.round(currentValue / invested * 1000) / 1000;
}

/**
 * Returns treemap-ready hierarchical data.
 * @param {Object} opts
 * @param {'invested'|'current_value'} opts.sizeBy - dimension for node sizing
 * @param {'thesis'|'stage'|'vintage'|'lead'} opts.groupBy - grouping dimension
 */
export async function treemapData(opts = {}) {
  const sizeBy = opts.sizeBy || 'current_value';
  const groupBy = opts.groupBy || 'thesis';

  // Fetch all investments with their primary thesis
  const rows = await query(`
    SELECT
      i.id,
      i.company_name,
      COALESCE(computed_net_invested, invested) AS invested,
      COALESCE(computed_total_value, COALESCE(unrealized_value,0) + COALESCE(realized_value,0)) AS current_value,
      i.multiple,
      i.stage_bucket,
      i.lead,
      EXTRACT(YEAR FROM i.invest_date)::int AS vintage_year,
      t.name AS primary_thesis
    FROM investments i
    LEFT JOIN investment_theses it ON it.investment_id = i.id AND it.is_primary = true
    LEFT JOIN theses t ON t.id = it.thesis_id
    WHERE i.asset_class = 'direct'
    ORDER BY i.company_name
  `);

  // Determine group key for each investment
  function groupKey(row) {
    switch (groupBy) {
      case 'thesis': return row.primary_thesis || 'Untagged';
      case 'stage': return row.stage_bucket || 'unknown';
      case 'vintage': return row.vintage_year ? String(row.vintage_year) : 'Unknown';
      case 'lead': return row.lead || 'Direct / Unknown';
      default: return 'All';
    }
  }

  // Build groups
  const groups = {};
  for (const row of rows) {
    const key = groupKey(row);
    if (!groups[key]) groups[key] = [];

    const invested = Number(row.invested || 0);
    const currentValue = Number(row.current_value || 0);
    const tvpi = computeTvpi(currentValue, invested);
    const size = sizeBy === 'invested' ? invested : currentValue;

    groups[key].push({
      name: row.company_name,
      size,
      invested,
      current_value: currentValue,
      tvpi,
      color_value: tvpi,
      color_bucket: colorBucket(tvpi),
      vintage_year: row.vintage_year,
      stage: row.stage_bucket,
      lead: row.lead,
    });
  }

  // Build hierarchy
  const children = Object.entries(groups)
    .map(([name, items]) => {
      const totalInvested = items.reduce((s, i) => s + i.invested, 0);
      const totalCurrent = items.reduce((s, i) => s + i.current_value, 0);
      const totalSize = items.reduce((s, i) => s + i.size, 0);
      const groupTvpi = computeTvpi(totalCurrent, totalInvested);

      return {
        name,
        size: totalSize,
        invested: totalInvested,
        current_value: totalCurrent,
        tvpi: groupTvpi,
        color_value: groupTvpi,
        color_bucket: colorBucket(groupTvpi),
        count: items.length,
        children: items.sort((a, b) => b.size - a.size),
      };
    })
    .sort((a, b) => b.size - a.size);

  return {
    name: 'Portfolio',
    sizeBy,
    groupBy,
    children,
  };
}
