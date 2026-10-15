# Earned Equity intelligence contract (wave 2, frozen)

Coordinator-owned. This file is the spec for builders C (documents) and D (lens). Builder E reads it for UI states.

## Attachment decision

Phase 0 inspection found:
- `council_runs.pipeline_invite_id` is NOT NULL.
- Angel results land in `deal_evaluations`, which drives `getCalibration`, `eval validate/discover` and pipeline status.

Rules:
- The earned-equity flow never writes to these tables: `pipeline_invites`, `council_runs`, `deal_evaluations`, `ad_hoc_reviews` or `council_followups`.
- Angel calibration therefore never sees earned-equity reviews, and earned-equity prospects never appear in the angel Pipeline counts.
- Shared code is reused at the function level: stage execution, evidence policy, retrieval, model policy and provider. It is not reused at the run-record level.
- The angel golden guard (`src/council/test-angel-golden.js`) must pass byte-identically after every change.

### Two review records

1. **Company review.** This is company-scoped and reusable across offers. It is keyed by `portfolio_entity_id`.
   - **Stages:** research → bull → bear → calibrator. There is no CFO stage, no sizing, no check size, no gpTiers and no portfolio-fit questions.
   - **Output:** a business-gate proposal (`supported | failed | unresolved`) plus rubric findings.
   - **Input:** company-level evidence only. Personal terms are never included: no salary, units, strike, offer documents or personal notes. A test asserts this.
   - **Run key:** sha256 of the company entity id, the lens id and version, the evidence policy version, the instruction hash, the source manifest hash, the model policy, and the review kind. On desktop the tenant is the workspace DB. A completed review with the same run key is reused, not rerun.
2. **Offer review.** This is personal and keyed by `offer_revision_id`.
   - **Inputs:** the company review (its id), the analysis snapshot (its id), confirmed document findings, and an optional user learning note.
   - **Process:** one bounded synthesis call (stage `memo`), validated against a schema.
   - **Output:** the memo sections from plan §7. These are the two gates, material clauses, trade-offs, crossover conditions taken from calculator outputs (the model never computes numbers), and unanswered questions.
   - **Gate 2 proposal:**
     - The memo may only propose `financially_attractive`, `not_attractive` or `unresolved`, based on calculator outputs against the baseline.
     - `learning_led_user_choice` is only ever set by the user, in the decision record.
     - With no user learning note, the memo must say that learning cannot satisfy gate 2.
   - **Calibrator check:** every numeric claim in the memo must equal a calculator output string, or the memo is rejected. This is a deterministic check.

### Follow-up

Employer answers create a new company review (`review_kind='followup'`, `parent_review_id`) or a new offer review. Prior rows are never modified, and earlier decisions keep their snapshot references.

## Migrations and ownership

| # | Owner | Tables |
| --- | --- | --- |
| 085 | C | `earned_equity_document_reviews`: id, opportunity_id FK, document_id FK documents, document_sha256, doc_class, extraction_version, status (`proposed`/`confirmed`/`rejected`/`failed`), proposal JSONB (assertions + findings), confirmed_offer_revision_id FK nullable, created_at, seq. Proposal content is append-only. A status change happens by inserting a new row that references the prior one, or through a narrowly guarded status update. C chooses and documents which. |
| 086 | D | `earned_equity_company_reviews` (id, portfolio_entity_id FK NOT NULL, parent_review_id, review_kind, lens_id, lens_version, policy_version, instruction_hash, source_manifest_hash, run_key UNIQUE, status, stage, artifact JSONB, error_code, usage JSONB, created_at, completed_at, seq; one running per entity). `earned_equity_offer_reviews` (id, offer_revision_id FK, company_review_id FK nullable, snapshot_id FK nullable, run_key UNIQUE, status, artifact JSONB, error_code, created_at, completed_at, seq). Completed artifacts are immutable. |
| 087 | H | `earned_equity_grant_links` (seq, id, decision_id FK, offer_revision_id FK, grant_component_id, investment_id FK investments, grant_id UUID FK employment_equity_grants, confirmed_terms JSONB incl. vesting schedule, created_at; UNIQUE (offer_revision_id, grant_component_id) and UNIQUE (grant_id)). Append-only under the maintenance flag. Written only by the explicit, confirmed `earned_equity.link_confirmed_grant` (ISO/NSO, board-approved, latest decision selects the revision; vested units are user-confirmed, default 0, never computed). Opportunity or group purge deletes link rows but never the ledger position, grants, lots or events. |

Also applies to every new table:
- Each one is added to `INSERT_ORDER` in `src/db/backup.js`.
- Each is covered by the purge of an opportunity or group. Company reviews are not personal, so they are purged only by an explicit company-review purge.
- The coordinator updates `src/db/test-migration-identity.js` and `src/commands/test-service.js` counts during integration. Builders must NOT edit those two lines, and should expect only those assertions to fail locally.

## Document rules (C)

**Classification**
- Each document is classified before extraction as one of: `cover_letter`, `offer_letter`, `grant_notice`, `equity_plan`, `service_agreement`, `ciia`, `amendment`, `cap_disclosure`, `education`, `benefits_overview`, `other`.
- `education` and `benefits_overview` never yield personal grant terms. A cover letter is not a signed offer.

**Proposals**
- An extraction produces a proposal only. Every assertion carries `{ field, value, units, locator, quote ≤300 chars, documentSha256, state }`, using the core `VALUE_STATES`.
- Numbers, dates and instrument names are validated: units are integers, dates are ISO, and the instrument is in the core enum.
- Contradictions between documents are preserved as `conflicting`. The newest document does not win.

**Findings**
- Findings use the plan §6 categories.
- Each one carries `{ category, severity, confidence, evidenceRef, reason, economicConsequence, question, resolution:null }`.
- "Unusual" is used only against a cited dated baseline. Otherwise the finding says `material term`, `unclear` or `requires review`.

**Failure handling**
- Referenced documents that are missing become checklist items.
- OCR or parse failures are surfaced as `failed`, never as empty success.

**Safety**
- Documents are untrusted. Embedded instructions are ignored.
- A test includes a prompt-injection fixture that tries to set strike to 0 and claim board approval. The proposal must not reflect it.

**Confirmation**
- Converting a confirmed proposal into an `OfferRevision` payload is a pure function. The user's approval happens in the UI, and the record is saved through `earned_equity.add_offer_revision`.
- Extraction never creates positions, grants or revisions by itself.

**Deterministic first**
- Deterministic parsing and rules run first: regexes for share counts, strike, percentages and vesting phrases; plan-reference detection; and term-review rules.
- The AI extraction pass runs through the existing provider abstraction under stage `extraction`, and tests inject a fake provider.

## Lens rules (D)

**Lens assets**
- Lens assets live in `skills/earned-equity-review/` (role references) and `packages/earned-equity-core/rubric.v1.json`. D creates that file and its test under the core `test/` directory.
- The rubric rows come from plan §7. There is no probability field.
- Each finding records:
  - evidenceIds
  - stage/businessModel applicability
  - direction
  - affectedAssumption
  - proposedSensitivity
  - uncertainty
  - counterevidence
  - confirmationState

**Code changes**
- `evaluate.js` may be parameterized so stage tables (roles, prompts, schemas, research seed questions, included stages) are injectable. The default is today's angel tables, unchanged.
- No other change to angel behavior is allowed.
- Stage caps are keyed on company stage, and `capsForStage` is reused where the company stage is known.

**App adapter** (`lib/earned-equity-council.js`, `lib/earned-equity-memo.js`)
- It builds the provider with `createRadarModelProvider` and maps calls to the existing `MODEL_STAGE_ROLES`. The production model policy is unchanged.
- It persists through engine model functions.
- No live calls in tests.

## UI states (E)

**Value states and gates**
- Every value shows its state (confirmed, document-supported, user-reported, illustrative, conflicting, missing).
- Each gate shows `supported`, `failed` or `unresolved`. Unresolved is presented as "investigate", not as failure.

**Equity figures**
- Figures with limitations show the limitation text.
- `null` is shown as "Unknown", never as $0.
- A no-liquidity scenario shows the illiquid residual separately.

**Comparison and decisions**
- There is no composite winner. The comparison shows rows and crossovers only.
- An accepted decision never displays as vested holdings.
