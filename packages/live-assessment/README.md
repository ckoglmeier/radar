# @radar/live-assessment

Shared, transport-independent contract for evidence-linked conversational assessment updates in Radar and First Read. No model selection or inference is performed by this package. Apps use their existing routes and pass validated replies to the shared update function.

A change preserves issue identity and a source snapshot reference; previous state is never mutated. Statement-only evidence cannot be promoted to `supported`. Original documents may still contain company claims: the prompt requires attribution and the validator does not claim semantic fact verification. Contradictions and mixed statements can change an interpretation without asserting independent truth.

`emptyAssessment`, `assessmentContext`, `UPDATE_SCHEMA`, `INSTRUCTIONS`, and `applyAssessmentUpdate` are the public API. Each completed turn advances the working revision; an empty change set preserves every tracked issue. App storage must atomically compare-and-swap the parent and save the reply plus returned assessment together.

The accompanying Radar engine migration 078 and backup list persist the Radar history. First Read persists assessments within its private immutable conversation turns using its own Supabase migration.

Test with `npm test` in this directory. Build the immutable package with `npm pack`; both apps consume the same archive and lockfile integrity.
