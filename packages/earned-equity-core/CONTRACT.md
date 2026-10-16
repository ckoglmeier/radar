# @radar/earned-equity-core — v1 contract (frozen)

Coordinator-owned. Spec: `RADAR_EARNED_EQUITY_IMPLEMENTATION_PLAN.md` §5, §9–10. Builders implement this contract. Changes to it are proposed to the coordinator, not edited in place.

## Boundary

- Plain ESM with JSDoc and no runtime dependencies.
- The package must not import `node:*`, the database, Electron, providers, `fetch` or any timer.
- It must work unchanged in a browser.
- No AI. The calculation is deterministic, and the same input always gives byte-identical output.
- Schemas live in `schema.mjs` as plain JSON Schema. Callers validate structure with their own AJV. `calculate()` performs the semantic checks that a schema cannot express.

## Numbers and dates

**Decimals**
- Wire format: decimal strings.
- Internal format: BigInt fixed-point.
  - Money and prices are scaled at 10⁻⁶.
  - Ratios and percentages are scaled at 10⁻¹².
- Units: integer-string BigInt.

**Rounding**
- Rounding is half-even and happens only when formatting outputs.
- Precision by output type:

  | Output | Decimal places |
  | --- | --- |
  | Money | 2 |
  | Per-share values | 6 |
  | Percentages | 4 |

**Discounting**
- The NPV discount factor is the only float. The monthly rate is `(1+r)^(1/12) − 1`, computed in IEEE double.
- The factor is converted to 10⁻¹² fixed-point before it multiplies money.

**Validity rules**
- A currency mismatch between the group, the offer and the scenario set is an error.
- Unknown is `null` with a limitation code, never `0`.

**Dates**
- ISO calendar dates only, with no time or zone.
- Month arithmetic: `addMonths(d, n)` keeps d's day-of-month, clamped to the target month's end.
- It is always computed from the original date, never chained. Example: 2024-01-31 → 02-29, 03-31, 04-30.

## Vesting

Inputs:
- the commencement date `C`;
- `totalMonths T`, `cliffMonths K`, and the cadence (monthly 1, quarterly 3, annual 12);
- units `U`.

Rules:
1. Vest events fall at `addMonths(C, m)` for each `m` that is a multiple of the cadence with `K ≤ m ≤ T`.
2. Cumulative vested at month m is `floor(U × m / T)`, which means the final event vests any remainder. With `T = 0`, all units vest at `C`.
3. The service end date `E` is the last day of service. A vest event dated on `E` counts.
4. Example: 4-year monthly vesting with a 1-year cliff and C = 2026-01-15.
   - On 2027-01-14, 0 units are vested.
   - On 2027-01-15, `floor(U × 12/48)` units are vested.
5. Cadences `performance` and `other` are not modeled: vested units are `null` and the limitation is `vesting_unsupported`.
6. Acceleration `none` is modeled.
   - `single_trigger` and `double_trigger` are not applied; they produce the limitation `acceleration_unmodeled`.
   - `unknown` produces the limitation `acceleration_unknown`.
7. Vesting and liquidity are independent.

## Scenario economics

These calculations apply per scenario and per grant component. Let:
- `S` = the offer's `serviceStartDate`. A `null` value is an error for calculation.
- `E` = `addMonths(S, serviceMonths)`. Service runs through the N-month anniversary, so 12 months of service meets a 12-month cliff and 48 months completes a 48-month vest. `serviceMonths: 0` means no service: `E` = S and nothing vests unless `T = 0`.
- `L` = `addMonths(S, liquidity.monthsFromStart)`.
- `H` = the group's `addMonths(startDate, horizonMonths)`.

### Cash

**Offer cash**
- The offer pays `annualBase/12` monthly for each service month inside the horizon.
- Target bonus is reported separately as `annualTargetBonus/12` per month, with the limitation `bonus_uncertain` whenever it is non-zero.
- Signing bonus is paid at S. Repayment is a negative flow at E if `serviceMonths < signingRepaymentMonths`.

**Baseline cash**
- `baseline.annualBase/12` (and the bonus) over the same service months.
- After E and inside the horizon:
  - The offer contributes `postServiceAnnualCash/12` when it is provided.
  - Otherwise post-service months are excluded from both sides, with the limitation `post_service_cash_unmodeled`.

**Output differences**
- `baseDifference` = baseline base − offer base.
- `totalCashDifference` = baseline (base + bonus) − offer (base + bonus).
- Signing flows are excluded from both and appear as their own flows.
- Negative values are preserved (they mean the offer pays more).
- A `null` baseline base gives `null` differences and the limitation `baseline_missing`.

### Instruments

- `iso` and `nso` are modeled.
- Every other instrument gives `null` equity results and the limitation `instrument_unsupported:<type>`.
- Units, strike or commencement whose state is `missing` or `conflicting` gives `null` dependent outputs and a limitation naming the field.
- `illustrative` values are never used. They are treated as missing, with the limitation `illustrative_value_ignored:<field>`.

### Per-share common proceeds `P`

| Method | P |
| --- | --- |
| `common_per_share` | `commonProceedsPerShare` |
| `pro_rata_shares` | `equityExitValue / fullyDilutedExitShares`, with the limitation `excludes_preferences` |
| `pro_rata_ownership` | Unit-free (see below), with the limitation `excludes_preferences` |
| `none` | No equity proceeds |

Under `pro_rata_ownership`:
- Gross value is `quotedOwnershipPct/100 × Π(1 − dᵢ) × equityExitValue × vestedFraction`.
- Exercise cost needs units and strike. If either is missing, net is `null` and the limitation is `exercise_cost_unknown`.

Dilution is accepted only in `pro_rata_ownership`. Share-based methods carry no dilution field, which prevents double dilution.

### Eligibility

- Eligible units are the units vested at `min(E, L)`.
- If `E < L`:
  - An expired post-termination window (`addMonths(E, ptw) < L`) makes the units ineligible (0 units).
  - A missing window makes the result `null`, with the limitation `exercise_window_unknown`.
  - Expiration of the grant (`grantDate + expirationYears`) before L also makes units ineligible.

### Exercise paths

**`at_liquidity`** (exercise and sell together)
- At L: `units × max(P − strike, 0)`.

**`at_date`** (exercise at month X before liquidity)
- At `addMonths(S, X)`: the units vested at that date (minus ones already ineligible) pay `units × strike` as a negative flow. Unvested early exercise is not modeled.
- At L: those units receive `units × P`. That proceed is not floored, so prior exercise funding can be lost.

### Liquidity within the horizon

If `liquidity.occurs` is false, or `L > H`:
- Realized equity is 0 within the horizon.
- `illiquidResidual = { units, note }` is reported separately.
- The limitation is `no_liquidity_in_horizon`.

### Funding and net

- `maxCumulativeFundingNeed` is the maximum running negative sum of the equity flows.
- `netPreTax = −totalCashDifference + realized equity flows + signing flows`.
  - Annualized equity, if shown, is labeled as a comparison measure only.
- Every result carries the limitation `pre_tax_only`.

### Present value and break-even

- NPV is computed only when `discountRateAnnual` is non-null. Dated flows are discounted from the group's `startDate` by month.
- `breakEvenCommonPrice` is the P at which `netPreTax = 0` under that scenario's service, liquidity and exercise path, ignoring the scenario's own price.
  - With cash forgone F ≤ 0, it is `"0"` with the code `offer_pays_more`.
  - With no eligible units, it is `null` with the code `no_solution`.

### Weighting

- `weighted` is computed only if every scenario has a non-null `weightPct`, the weights sum to exactly 100, and every scenario's `netPreTax` is non-null.
- Otherwise it is `null` with the limitation `weights_incomplete`, `weights_not_100` or `expected_value_unavailable`.
- Zero outcomes are included in the expectation.

## API (`index.mjs`)

```
calculateOffer({ group, offerRevision, scenarioSet })
  → { ok: true, result: CalculationResult } | { ok: false, errors: [{ path, code, message }] }
compareOffers({ group, entries: [{ opportunity, offerRevision, result }] })
  → { ok, comparison }
validateSelection({ group, opportunities, offerRevisions, selectedOfferRevisionIds })
  → { ok, errors, warnings }
vestedUnitsAt(grant, isoDate) → { units: string|null, limitations }
addMonths(isoDate, n) → isoDate
canonicalJson(value) → string
CALCULATOR_VERSION = 'earned-equity-core/1.0.0'
```

The package does not hash. Callers hash `canonicalJson({ calculatorVersion, group, offerRevision, scenarioSet })` with their platform's SHA-256 to get the snapshot `inputHash`.

### `CalculationResult`

```
{ calculatorVersion, schemaVersion: 1, currency,
  scenarios: [{ scenarioId, label, kind,
    cash: { offerBase, offerBonus, baselineBase, baselineBonus, baseDifference, totalCashDifference },
    grants: [{ componentId, vestedUnits, eligibleUnits, exerciseCost, realizedProceeds, illiquidResidual, limitations }],
    cashFlows: [{ date, amount, kind }],
    maxCumulativeFundingNeed, netPreTax, npv, breakEvenCommonPrice, limitations }],
  weighted: { expectedNetPreTax } | null,
  limitations }
```

Field types:
- Amounts are decimal strings or `null`.
- `cashFlows` entries are sorted by date, then kind.
- Cash-flow `kind` is one of `base`, `bonus`, `signing`, `signing_repayment`, `exercise`, `proceeds`.
- `limitations` is a sorted, de-duplicated array of codes.

### `compareOffers`

Requirements:
- Every entry shares the same currency, `startDate`, `horizonMonths` and `discountRateAnnual`. A mismatch fails with `comparison_basis_mismatch`.

It returns per-scenario-kind rows of known values for each offer:
- cash sacrifice
- `netPreTax`
- `maxCumulativeFundingNeed`
- break-even price
- limitations

It also returns `crossovers`, the pairwise break-even comparisons where both are known.

It does **not** return a composite score, a rank or a winner. Missing material inputs are listed in `unresolved`.

### `validateSelection`

Errors:
- `employment_multiple_primary`: an employment group selects more than one opportunity.
- `same_opportunity_revisions`: two revisions of one opportunity are both selected.
- `superseded_revision`: a selected revision has been superseded.
- `opportunity_not_selectable`: the opportunity's lifecycle is `declined`, `expired` or `withdrawn`.

Warnings:
- `capacity_hours_exceeded`
- `capacity_selection_exceeded`
- `exercise_funding_capacity_exceeded`
- `correlated_concentration`: more than one selection is made.

No optimization.

## Rubric (`rubric.v1.json`, Phase 4)

This file is reserved for later work. It has no probability fields.

## v1.1 amendments (independent review, 2026-10-15)

Each amendment below answers a finding (F1–F10) from the independent review.

**A1. Exact accumulation (F1, F2).**
- Money and prices are held at 10⁻¹². This is now the same scale as ratios, and it matches the schema's 12 decimals, so no input is truncated on parse.
- Totals are computed exactly from annual amounts × months / 12 and rounded once at output. This covers offer and baseline cash, differences, net, NPV, weighted values and proceeds.
- `cashFlows[].amount` is display-rounded per entry. The sum of displayed flows may differ from `netPreTax` by rounding; `netPreTax` is authoritative.

**A2. Basis on results (F3).**
- `CalculationResult` carries `basis: { currency, startDate, horizonMonths, discountRateAnnual }`.
- `compareOffers` fails with `comparison_basis_mismatch` when any result's basis differs from the group.

**A3. Grant expiration (F4).**
- If `expirationYears` is unknown and liquidity lies within the horizon, equity is `null` with `grant_expiration_unknown`.
- If `grantDate` is unknown, the earliest possible grant date is the offer revision's `asOfDate`.
  - Liquidity on or before `asOfDate + expirationYears` is certainly before expiry.
  - Otherwise equity is `null` with `grant_expiration_unknown`.

**A4. Ownership versus units (F5).**
- Under `pro_rata_ownership`, when units are known, the vested fraction is `eligibleUnits / units`, and known zero units give zero proceeds.
- When units are unknown, the fraction comes from the schedule, as before.

**A5. `not_applicable` (F6).**
- For cash terms (target bonus, signing bonus, baseline bonus), `not_applicable` means the term does not exist and counts as zero, with no limitation.
- For any other required field, `not_applicable` is a structured error (`not_applicable_not_allowed:<field>`).

**A6. Selection never assumes zero (F7).**
- Unknown hours give a `capacity_hours_unknown` warning.
- An unknown or missing funding result gives `exercise_funding_unknown` when a funding capacity is set.

**A7. Residual respects expiry (F8).**
- With no liquidity in the horizon, the illiquid residual is the units still exercisable at H, after the post-termination window and grant expiration.
- An unknown window or expiration gives a `null` residual with the matching limitation.

**A8. Vesting validity (F9).**
- `cliffMonths > totalMonths` (when `T > 0`) is a structured error, `vesting_cliff_exceeds_term`.
- When T is not a multiple of the cadence, a final event at T is kept (rule 2 governs) and the limitation `vesting_final_event_off_cadence` is added.

**A9. Robustness (F10).**
- Every date input, including `vestedUnitsAt`'s query date and impossible calendar dates, is validated and returns structured errors that name the field path.
- `compareOffers` and `validateSelection` return structured errors on malformed input; they never throw.

`CALCULATOR_VERSION` becomes `earned-equity-core/1.1.0`.

## v1.1.1 amendments (independent re-verification)

**A3a.** The `asOfDate` lower bound for an unknown grant date applies only to offer revisions with status `proposed`. For `signed` or `user_reported` revisions, the grant may predate the entry, so an unknown grant date gives `null` with `grant_expiration_unknown` whenever expiry could fall before liquidity.

**A4a.** Known zero units give zero proceeds under every payout method, before any ownership percentage is read.

**A9a.**
- Every date field, including `ownershipDenominator.asOfDate`, is validated.
- Each invalid field is reported once.

**A10.**
- An `illiquidResidual` reports units still held at H, with a note that says whether they are exercisable options or already-exercised shares.

`CALCULATOR_VERSION` becomes `earned-equity-core/1.1.1`.

## v1.2 amendments: relative position, sensitivity grid, valuation context (2026-10-15, CK direction)

CK direction: no accept/decline verdicts. Radar shows where an offer stands relative to the alternatives, how its outcome moves with exit value and timing, and the valuation context.

### V1. Valuation context (schema, additive)

`OfferRevision.valuationContext` is optional. Every field in it is a fact.

| Field | Meaning |
| --- | --- |
| `preferredPricePerShare` | Price per share of the latest preferred round |
| `postMoneyValuation` | Post-money valuation of that round |
| `fullyDilutedShares` | Fully diluted share count |
| `fmv409APerShare` | 409A fair market value per common share |
| `fmv409AAsOf` | Date of that 409A (a date) |
| `lastRoundDate` | Date of the latest round (a date) |
| `seniorClaimsAmount` | Total liquidation preferences plus debt ahead of common |
| `preferenceTerms` | Text, at most 500 characters |

**Value state.** `VALUE_STATES` gains `researched_unconfirmed`. It marks a value proposed from public research that the user has not confirmed. The calculator may use it in relative metrics, but always adds the limitation `researched_value:<field>`. It is never used for payout, units or strike.

### V2. `relativePosition({ group, offerRevision, scenarioSet, result })`

All results are exact rationals and deterministic. There is no verdict field.

**Cash given up**
- `cashGivenUpTotal` is the base scenario's `totalCashDifference`.
- `cashGivenUpPerYear` is that total divided by the base scenario's service years.

**Break-even multiples**
- `breakEvenCommonPrice` is the base scenario's break-even common price.
- `breakEvenMultipleOfPreferred` is the break-even price divided by `preferredPricePerShare`.
- `breakEvenMultipleOf409A` is the break-even price divided by `fmv409APerShare`.
- Each multiple is `null` when its reference is unknown.

**Break-even equity value**
- `breakEvenEquityValue` is the break-even price × `fullyDilutedShares`, when known.
- `breakEvenMultipleOfPostMoney` is that value divided by `postMoneyValuation`.
- A senior-claims-adjusted figure is shown only when `seniorClaimsAmount` is known: `(breakEvenEquityValue + seniorClaimsAmount) / postMoneyValuation`. It is labelled as a simplified as-converted figure that excludes participation and seniority detail.

**Strike context**
- `strikeVs409A` is the strike divided by the 409A FMV, when both are known.

**Limitations** are carried through from the calculation and the valuation states.

### V3. `sensitivityGrid({ group, offerRevision, scenarioSet, baseScenarioId, prices?, years? })`

The grid is one two-way table of `netPreTax` by exit common price per share × years to liquidity.

**How each cell is calculated**
- Start from the base scenario: its service months, exercise path and cash.
- Replace its payout with `common_per_share` at the price on the price axis.
- Replace its liquidity with the year on the year axis.
- Set the horizon to `max(group.horizonMonths, liquidityMonths)` so that the liquidity always falls inside it.
- Each cell reports `netPreTax`, plus `npv` when a discount rate is set.

**Axes**
- Default years: `[2, 3, 4, 5, 7, 10]`.
- Default prices: the reference price × `[0.5, 1, 2, 3, 5, 10]`.
  - The reference price is the first known of: `preferredPricePerShare`, then `fmv409APerShare`, then the base break-even price.
  - The reference used is reported.
- Callers may pass explicit axes, up to 8 × 8.

**Per-column break-even.** For each year, the grid also reports the exact break-even common price for that timing.

Cells that cannot be computed are `null` with a limitation. They are never zero.

`CALCULATOR_VERSION` becomes `earned-equity-core/1.2.0`.

### V4. Decision record

`gates` is optional and deprecated, and new decisions omit it. The decision keeps `outcome`, `rationale`, `acknowledgedRisks`, the optional `learningJudgment`, and `contraryToAnalysis`.
