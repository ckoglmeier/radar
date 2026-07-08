// council-models.js — Phase B3: per-role model policy for the council.
//
// Least-powerful-per-action (see the plan's runtime tiering table). Values are
// SDK model *aliases* ('opus'|'sonnet'|'haiku'), which the Agent SDK resolves to
// the current model for that tier — so a model upgrade needs no change here (no
// version map to maintain). Each council persona runs as a subagent
// (AgentDefinition.model); the orchestrator is the top-level session model.

export const COUNCIL_ROLES = Object.freeze([
  'orchestrator', // sequences the stages, assembles the artifact
  'research',     // cheap web-retrieval legs
  'dossier',      // credibility synthesis over gathered facts
  'bull',         // argue upside + score /50
  'bear',         // argue downside + score /50
  'calibrator',   // reconcile -> canonical score (feeds bet-sizing)
  'cfo',          // Deploy/Defer/Pass over portfolio + GP tiers
]);

export const DEFAULT_COUNCIL_MODELS = Object.freeze({
  orchestrator: 'sonnet',
  research: 'haiku',
  dossier: 'sonnet',
  bull: 'sonnet',
  bear: 'sonnet',
  calibrator: 'opus', // the one leg that earns the strongest model
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
