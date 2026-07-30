// council-models.js — Phase B3: per-role model policy for the council.
//
// Least-powerful-per-action (see the plan's runtime tiering table).
// councilEvaluate executes each active persona as its own session;
// orchestrator/dossier remain for policy compatibility.

export const COUNCIL_ROLES = Object.freeze([
  'orchestrator', // sequences the stages, assembles the artifact
  'research',     // seeded planning + web research in one session
  'dossier',      // credibility synthesis over gathered facts
  'bull',         // argue upside + score /50
  'bear',         // argue downside + score /50
  'calibrator',   // reconcile -> canonical score (feeds bet-sizing)
  'cfo',          // Deploy/Defer/Pass over portfolio + GP tiers
]);

export const DEFAULT_COUNCIL_MODELS = Object.freeze({
  orchestrator: 'sonnet',
  research: 'claude-sonnet-4-6',
  dossier: 'sonnet',
  bull: 'sonnet',
  bear: 'sonnet',
  calibrator: 'claude-opus-4-6',
  cfo: 'sonnet',
});

/**
 * Resolve the council model policy: defaults, with any known-role overrides
 * applied on top (from lens/config). Unknown roles in the override are ignored
 * (a typo can't silently drop a role to an undefined model). Returns a frozen,
 * complete map covering every COUNCIL_ROLE.
 * @param {Record<string,string>} [override={}]
 * @returns {Readonly<Record<string,string>>}
 */
export function resolveCouncilModels(override = {}) {
  const out = { ...DEFAULT_COUNCIL_MODELS };
  for (const role of COUNCIL_ROLES) {
    const v = override[role];
    if (typeof v === 'string' && v.trim()) out[role] = v.trim();
  }
  return Object.freeze(out);
}
