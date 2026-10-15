// @radar/earned-equity-core public API. Pure ESM, no runtime dependencies.
export { CALCULATOR_VERSION, calculateOffer, ownershipRetentionPct } from './src/scenario.mjs';
export { compareOffers } from './src/compare.mjs';
export { validateSelection } from './src/selection.mjs';
export { vestedUnitsAt } from './src/vesting.mjs';
export { addMonths } from './src/dates.mjs';
export { canonicalJson } from './src/canonical-json.mjs';
