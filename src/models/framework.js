import { query } from '../db/index.js';

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function text(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function points(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }
  return parsed;
}

function validateRubric(value, label) {
  const rubric = object(value, label);
  const total = points(rubric.total_points, `${label}.total_points`);
  if (!Array.isArray(rubric.sections) || rubric.sections.length === 0) {
    throw new Error(`${label} must contain at least one section`);
  }

  let sectionTotal = 0;
  for (const [sectionIndex, section] of rubric.sections.entries()) {
    object(section, `${label}.sections[${sectionIndex}]`);
    text(section.name, `${label}.sections[${sectionIndex}].name`);
    const sectionMax = points(section.max_points, `${section.name}.max_points`);
    sectionTotal += sectionMax;
    if (!Array.isArray(section.dimensions) || section.dimensions.length === 0) {
      throw new Error(`${section.name} must contain at least one dimension`);
    }
    let dimensionTotal = 0;
    for (const [dimensionIndex, dimension] of section.dimensions.entries()) {
      object(dimension, `${section.name}.dimensions[${dimensionIndex}]`);
      text(dimension.name, `${section.name}.dimensions[${dimensionIndex}].name`);
      const max = dimension.max_points != null
        ? points(dimension.max_points, `${dimension.name}.max_points`)
        : points(Number(dimension.weight_pct) * total / 100, `${dimension.name}.weight_pct`);
      dimensionTotal += max;
      const anchors = object(dimension.anchors, `${dimension.name}.anchors`);
      for (const anchor of ['1', '3', '5']) text(anchors[anchor], `${dimension.name}.anchors.${anchor}`);
    }
    if (Math.abs(dimensionTotal - sectionMax) > 0.001) {
      throw new Error(`${section.name} dimension points must total ${sectionMax}; got ${dimensionTotal}`);
    }
  }
  if (Math.abs(sectionTotal - total) > 0.001) {
    throw new Error(`Rubric section points must total ${total}; got ${sectionTotal}`);
  }

  if (!Array.isArray(rubric.verdict_bands) || rubric.verdict_bands.length === 0) {
    throw new Error(`${label} must contain verdict bands`);
  }
  for (const [index, band] of rubric.verdict_bands.entries()) {
    if (!Array.isArray(band.range) || band.range.length !== 2) {
      throw new Error(`${label}.verdict_bands[${index}] needs a two-value range`);
    }
    text(band.verdict, `${label}.verdict_bands[${index}].verdict`);
  }
  return rubric;
}

function validateFramework(value) {
  const framework = object(value, 'framework');
  const manifest = object(framework.manifest, 'manifest');
  text(manifest.name, 'manifest.name');
  text(manifest.description, 'manifest.description');
  validateRubric(framework.rubric, 'rubric');
  if (framework.rubricSecondary) validateRubric(framework.rubricSecondary, 'rubricSecondary');

  const killCriteria = object(framework.killCriteria, 'killCriteria');
  for (const key of ['automatic_pass', 'structural_flags']) {
    if (!Array.isArray(killCriteria[key])) throw new Error(`killCriteria.${key} must be an array`);
    for (const [index, criterion] of killCriteria[key].entries()) {
      text(criterion?.label, `killCriteria.${key}[${index}].label`);
    }
  }

  const taggingRules = object(framework.taggingRules, 'taggingRules');
  if (!Array.isArray(taggingRules.rules)) throw new Error('taggingRules.rules must be an array');
  for (const [index, rule] of taggingRules.rules.entries()) {
    text(rule?.thesis_id, `taggingRules.rules[${index}].thesis_id`);
    if (!Array.isArray(rule.market_patterns) || !Array.isArray(rule.company_patterns)) {
      throw new Error(`taggingRules.rules[${index}] patterns must be arrays`);
    }
  }

  const gpTiers = object(framework.gpTiers, 'gpTiers');
  if (!Array.isArray(gpTiers.tiers)) throw new Error('gpTiers.tiers must be an array');
  for (const [index, tier] of gpTiers.tiers.entries()) {
    points(tier?.tier, `gpTiers.tiers[${index}].tier`);
    text(tier?.label, `gpTiers.tiers[${index}].label`);
    if (!Array.isArray(tier.gps)) throw new Error(`gpTiers.tiers[${index}].gps must be an array`);
    for (const [gpIndex, gp] of tier.gps.entries()) {
      text(gp?.name, `gpTiers.tiers[${index}].gps[${gpIndex}].name`);
    }
  }

  const roundParams = object(framework.roundParams, 'roundParams');
  object(roundParams.rounds, 'roundParams.rounds');
  object(roundParams.default, 'roundParams.default');
  return framework;
}

function nextPatch(version) {
  const match = String(version || '1.0.0').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return '1.0.1';
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function recordToFramework(record) {
  if (!record) return null;
  return {
    manifest: record.manifest,
    rubric: record.rubric,
    rubricSecondary: record.rubric_secondary,
    killCriteria: record.kill_criteria,
    taggingRules: record.tagging_rules,
    gpTiers: record.gp_tiers,
    roundParams: record.round_params,
  };
}

export function applyFrameworkVersion(lens, record) {
  if (!record) return lens;
  const framework = recordToFramework(record);
  return {
    ...lens,
    ...framework,
    manifest: framework.manifest,
  };
}

export async function getActiveFrameworkVersion() {
  const rows = await query(
    `SELECT *
       FROM lens_framework_versions
      ORDER BY id DESC
      LIMIT 1`
  );
  return rows[0] || null;
}

export async function listFrameworkVersions() {
  return query(
    `SELECT id, lens_name, version, change_note,
            id = (SELECT MAX(id) FROM lens_framework_versions) AS active,
            created_at
       FROM lens_framework_versions
      ORDER BY id DESC`
  );
}

export async function getFrameworkState(defaultLens) {
  const active = await getActiveFrameworkVersion();
  const lens = applyFrameworkVersion(defaultLens, active);
  return {
    framework: {
      manifest: lens.manifest,
      rubric: lens.rubric,
      rubricSecondary: lens.rubricSecondary,
      killCriteria: lens.killCriteria,
      taggingRules: lens.taggingRules,
      gpTiers: lens.gpTiers,
      roundParams: lens.roundParams,
    },
    activeVersion: active?.version || lens.manifest?.version || '1.0.0',
    versions: await listFrameworkVersions(),
  };
}

export async function saveFrameworkVersion({ framework, changeNote = null }) {
  const valid = validateFramework(framework);
  const active = await getActiveFrameworkVersion();
  const version = nextPatch(active?.version || valid.manifest.version);
  const manifest = {
    ...valid.manifest,
    version,
    updated: new Date().toISOString().slice(0, 10),
  };
  const lensName = text(manifest.name, 'manifest.name');
  const rows = await query(
    `INSERT INTO lens_framework_versions (
       lens_name, version, manifest, rubric, rubric_secondary,
       kill_criteria, tagging_rules, gp_tiers, round_params,
       change_note
     )
     VALUES (
       $1, $2, $3::jsonb, $4::jsonb, $5::jsonb,
       $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
       $10
     )
     RETURNING *`,
    [
      lensName,
      version,
      JSON.stringify(manifest),
      JSON.stringify(valid.rubric),
      valid.rubricSecondary ? JSON.stringify(valid.rubricSecondary) : null,
      JSON.stringify(valid.killCriteria),
      JSON.stringify(valid.taggingRules),
      JSON.stringify(valid.gpTiers),
      JSON.stringify(valid.roundParams),
      String(changeNote || '').trim() || null,
    ]
  );
  return { ...rows[0], active: true };
}
