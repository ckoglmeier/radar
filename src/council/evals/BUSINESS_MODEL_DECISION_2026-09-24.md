# Approved business-model anchor clarification

User approved: a credible but unproven model earns 3; 5 requires stronger evidence appropriate to the company's stage.

The default template now explicitly prevents a Seed credible thesis, LOIs, pilots or initial paying customers alone from implying 5. It preserves stage adjustment: Seed need not demonstrate mature-company unit economics. The actual confirming evidence must be identified rather than assumed. An explicitly commercially unproven model remains 3, not 5.

This decision resolves the Seed 3/5 ambiguity only. It does not authorize changing Series B missing-proof caps, anchor1, thresholds, model routing, other dimensions, or historical assessments.

Integration: the active rubric is database-backed and is not automatically changed by this template edit. Apply the approved clarification through the normal versioned framework update path, preserving customized rubric content and prior snapshots. Do not overwrite user rubrics wholesale or rescore stored assessments. Include the same semantics in any shipped fallback with the old `Seed = credible thesis` wording. The release coordinator owns that integration.

Verification: `node src/council/evals/test-business-model-anchors.js` checks the default text contract. This is not a live-model qualification. Existing benchmark plans/results remain immutable under the old rubric. Freeze a new plan with the clarified rubric for subsequent model testing; do not reinterpret old failures as passes. The experimental anchor-first calibration prompt remains unactivated pending that test.
