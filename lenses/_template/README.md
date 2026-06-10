# Radar Lens Authoring Guide

A **lens** is a portable investment-thesis plugin for Radar. It holds your thesis definitions, deal-scoring rubric, auto-tagging rules, GP tier list, kill criteria, outcome distributions, and round parameters — all as plain JSON files in a directory.

Lenses are the unit of customization: copy one, edit it to match your framework, install it, and Radar's analysis commands (`bet-size`, `thesis performance`, `eval validate`, etc.) all adapt automatically.

---

## Quick Start

```bash
# 1. Scaffold a new lens from this template
node src/cli.js lens new my-lens

# 2. Edit the files (see field reference below)
cd lenses/my-lens

# 3. Install and activate (project-local)
node src/cli.js lens install . --activate

# OR install globally (available across projects)
node src/cli.js lens install . --global --activate

# 4. Verify
node src/cli.js lens active
node src/cli.js lens inspect lenses/my-lens
```

The active lens is stored in `.radar/config.json` (project-local) or `~/.radar/config.json` (global). The loader checks project-local first, then global, then falls back to the bundled default lens.

---

## Directory Structure

```
my-lens/
  manifest.json        # Identity and metadata — required
  theses/              # One .json file per thesis cluster — required
    my-thesis.json
  rubric.json          # Deal-scoring rubric — optional but strongly recommended
  rubric-secondary.json  # Alternate rubric for secondary/pre-IPO trades — optional
  tagging-rules.json   # Auto-tagging rules for CSV import — optional
  gp-tiers.json        # GP/syndicate tier list — optional
  kill-criteria.json   # Automatic passes and structural flags — optional
  round-params.json    # Kelly solver parameters per round stage — optional
  distributions.json   # Outcome probability distributions per score band — optional
```

All files except `manifest.json` and the `theses/` directory are optional. The loader will silently skip any file that doesn't exist, and the relevant commands will fall back to reasonable defaults.

---

## File Reference

### `manifest.json`

Identity and metadata for the lens. Consumed by `lens list`, `lens active`, and `lens inspect`.

```json
{
  "name": "my-lens",
  "version": "0.1.0",
  "description": "A short description of your framework",
  "author": { "name": "Your Name", "handle": "your-handle" },
  "license": "MIT",
  "price_tier": "free",
  "radar_version_min": "1.0.0",
  "thesis_count": 2,
  "created": "YYYY-MM-DD",
  "updated": "YYYY-MM-DD",
  "tags": ["angel", "pre-seed", "seed"]
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | Must match the directory name. Only `[a-zA-Z0-9_-]` characters. |
| `version` | string | Semver. Increment when you change scoring logic. |
| `price_tier` | string | `"free"` or `"paid"` — informational only. |
| `radar_version_min` | string | Minimum Radar version required. |
| `thesis_count` | number | Should equal the number of active thesis files in `theses/`. |
| `tags` | array | Free-form strings for discovery. |

---

### `theses/<name>.json`

One file per thesis cluster. All `.json` files in `theses/` are loaded and sorted alphabetically. Consumed by `getTheses()`, `getThesisClusters()`, and throughout portfolio and eval reports.

```json
{
  "id": "my-thesis-id",
  "name": "My Thesis Display Name",
  "belief": "The one-paragraph belief statement that anchors this thesis.",
  "qualifications": [
    "What types of companies belong here",
    "Be specific enough to score a deal against"
  ],
  "exclusions": [
    "What explicitly does not belong",
    "Common false positives to watch for"
  ],
  "portfolio_examples": [
    { "name": "Example Co", "check": 5000, "note": "why it fits" }
  ],
  "conviction_signal": "What pattern gives you the most confidence a deal belongs here.",
  "active": true
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable identifier. Used as the key in `investment_theses` DB rows and tagging-rules. Must not change after investments are tagged with it. |
| `name` | string | Display name. Used in CLI output and `getThesisClusters()` mapping. |
| `belief` | string | The core investment thesis statement. Referenced during deal grading. |
| `qualifications` | array | What belongs. Used as grading reference. |
| `exclusions` | array | What doesn't belong. Common false positives. |
| `portfolio_examples` | array | Illustrative examples. `check` and `note` are optional. |
| `active` | boolean | `false` = inactive thesis (not shown in active thesis lists, not used for auto-tagging). |

**Inactive theses:** set `"active": false` to retire a thesis without deleting its history. Inactive theses still appear in historical reports but are excluded from new deal grading.

---

### `rubric.json`

The deal-scoring rubric. Consumed by `bet-size`, `eval validate`, and the investment grading skill. The rubric defines dimensions across two sections (Thesis Fit and Viability), each scored 1–5.

```json
{
  "total_points": 50,
  "sections": [
    {
      "name": "Thesis Fit",
      "weight_pct": 50,
      "max_points": 25,
      "dimensions": [
        {
          "name": "Domain match",
          "weight_pct": 15,
          "scale": [1, 5],
          "anchors": {
            "1": "What a 1/5 looks like",
            "3": "What a 3/5 looks like",
            "5": "What a 5/5 looks like"
          }
        }
      ]
    }
  ],
  "verdict_bands": [
    { "range": [40, 50], "verdict": "Strong fit", "response_type": "Warm interest" },
    { "range": [30, 39], "verdict": "Worth exploring", "response_type": "Request more info" },
    { "range": [20, 29], "verdict": "Likely pass", "response_type": "Polite pass" },
    { "range": [0, 19], "verdict": "Clear pass", "response_type": "Quick pass" }
  ]
}
```

The standard rubric has two sections of equal weight (50/50), each worth 25 points, for a 50-point total. Each dimension has a `weight_pct` (within its section) and 1–5 anchors. The `weight_pct` values within a section should sum to 100, though Radar does not enforce this — it's a reference for the grading skill.

**`verdict_bands`:** the ranges determine what CLI output and grading-skill responses are shown. Adjust the thresholds to match your conviction bar.

---

### `rubric-secondary.json` (optional)

An alternate rubric for secondary trades or pre-IPO rounds, where the key question shifts from "will this company grow?" to "will this position exit on a reasonable timeline?". Loaded only when `getRubric('secondary')` is called. If this file doesn't exist, `getRubric('secondary')` falls back to `rubric.json`.

Structure is identical to `rubric.json`. Common replacements: swap "Compounding structure" → "Exit path clarity", "Capital efficiency" → "Time to liquidity". See the reference implementation for an example with full anchors and a kill criterion on Time to Liquidity ≤ 2.

---

### `tagging-rules.json`

Auto-tagging rules applied when importing an AngelList CSV (`radar import angellist`). Each rule maps a `thesis_id` to a list of market-category strings and company-name substrings.

```json
{
  "rules": [
    {
      "thesis_id": "my-thesis-id",
      "market_patterns": ["AI / ML", "Software"],
      "company_patterns": ["Example AI Co", "Specific Company Name"]
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `thesis_id` | string | Must match an `id` in `theses/`. |
| `market_patterns` | array | Matched case-insensitively against the AngelList market/sector column using `String.includes()`. |
| `company_patterns` | array | Matched case-insensitively against the company name using `String.includes()`. Useful for companies not captured by market patterns. |

**How matching works:** for each investment being imported, the engine checks every rule. If the investment's market field contains any `market_pattern`, or its company name contains any `company_pattern`, the investment is tagged with that rule's `thesis_id`. Multiple rules can match the same investment — it gets tagged to all matching theses, with equal weight split across them.

Manual thesis tags (`tagged_by='manual'` in the DB) are never overwritten by auto-tagging.

---

### `gp-tiers.json`

Your GP/syndicate tier list. Used by `gp summary`, `gp detail`, and the source-quality dimension in the rubric grading skill. Not consumed programmatically in a way that requires specific tier numbers — this is reference data surfaced in CLI output.

```json
{
  "tiers": [
    {
      "tier": 1,
      "label": "Primary deal flow, highest trust",
      "gps": [
        { "name": "Example Syndicate Lead", "deals": 12, "notes": "Optional notes" }
      ]
    }
  ],
  "direct": [
    { "name": "Example Direct Co", "total": 10000, "notes": "Direct investment, no syndicate" }
  ]
}
```

`direct` tracks investments made directly without a GP/syndicate lead. `total` is your total invested amount — informational only, not used in calculations.

---

### `kill-criteria.json`

Automatic passes and structural flags that inform the grading skill. Not enforced programmatically — these are reference criteria surfaced during deal grading.

```json
{
  "automatic_pass": [
    {
      "label": "Short description of the category",
      "reason": "Why you don't invest here"
    }
  ],
  "structural_flags": [
    {
      "label": "Short description of the flag",
      "impact": "lower_score",
      "reason": "Why this is a red flag"
    }
  ],
  "notes": "Any additional context for the grading skill."
}
```

`automatic_pass` items are hard stops — the grading skill should issue a Pass regardless of score. `structural_flags` items reduce scores within the rubric but don't force a pass on their own.

---

### `round-params.json`

Kelly solver parameters per investment round. Consumed by `bet-size` via `getRoundParams()`. The `rounds` object is iterated over using `Object.entries()`, so do not add non-round keys directly inside `rounds`.

```json
{
  "rounds": {
    "pre-seed": { "confidence": "very_low", "time_to_liquidity_years": 9 },
    "seed":     { "confidence": "low",      "time_to_liquidity_years": 8 },
    "series a": { "confidence": "low",      "time_to_liquidity_years": 6 },
    "series b": { "confidence": "low",      "time_to_liquidity_years": 5 },
    "series c": { "confidence": "medium",   "time_to_liquidity_years": 3 },
    "series d": { "confidence": "medium",   "time_to_liquidity_years": 2 },
    "secondary": { "confidence": "high",    "time_to_liquidity_years": 2 }
  },
  "default": { "confidence": "low", "time_to_liquidity_years": 7 }
}
```

| Field | Type | Notes |
|---|---|---|
| `confidence` | string | One of `"very_low"`, `"low"`, `"medium"`, `"high"`. Passed to the Kelly Python solver. |
| `time_to_liquidity_years` | number | Expected years to exit. Used to discount the Kelly recommendation. |
| `default` | object | Used when the round doesn't match any key. |

Round matching is done via `String.includes()` on the lowercased round label, so `"series a"` matches `"Series A"`, `"Series A+"`, etc.

---

### `distributions.json`

Outcome probability distributions per score band. Consumed by `bet-size` to run the Kelly solver — this is the core calibration data. The `bands` object is iterated with `Object.keys()`, so all keys directly inside `bands` must be valid band keys (`"44+"`, `"39-43"`, `"30-38"`, `"<30"`), not documentation keys.

```json
{
  "_calibration_note": "Top-level doc fields with underscore prefix are safe here.",
  "calibration_date": "YYYY-MM-DD",
  "calibration_source": "Describe your data source",
  "bands": {
    "44+": {
      "outcomes": [0.0, 0.5, 1.0, 3.0, 10.0, 30.0, 100.0],
      "probs":    [0.35, 0.10, 0.12, 0.13, 0.18, 0.09, 0.03],
      "calibration_note": "Per-band notes are safe — only outcomes and probs are read by the solver."
    }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `bands` | object | Keys must exactly match `scoreToBand()` output: `"44+"`, `"39-43"`, `"30-38"`, `"<30"`. |
| `outcomes` | array of numbers | MOIC multiples (e.g. `0.0` = total loss, `1.0` = return of capital, `10.0` = 10x). |
| `probs` | array of numbers | Probability for each outcome. Must sum to 1.0 and be the same length as `outcomes`. |
| `calibration_note` | string | Per-band annotation — not read by the solver. |

**Calibrating distributions:** start with the defaults in this template (illustrative priors). After you have 5+ mature positions (exited or marked down) in a given band, replace the defaults with data-derived values. Run `radar eval validate` to check whether your score bands are predictive.

---

## Creating Your Own Lens

1. **Scaffold** from the template:
   ```bash
   node src/cli.js lens new my-lens
   ```

2. **Edit `manifest.json`** — set `name`, `description`, `author`, `thesis_count`.

3. **Write thesis files** — one `.json` per cluster in `theses/`. The `id` field is the stable key used in tagging and DB rows; don't change it after investments are tagged with it.

4. **Configure `rubric.json`** — define your scoring dimensions and verdict bands.

5. **Add `tagging-rules.json`** — use market patterns for broad matching, company patterns for specific overrides.

6. **Install and activate**:
   ```bash
   # Project-local (stored in lenses/my-lens/)
   node src/cli.js lens install ./lenses/my-lens --activate

   # Global (stored in ~/.radar/lenses/my-lens/, available across projects)
   node src/cli.js lens install ./lenses/my-lens --global --activate
   ```

7. **Verify**:
   ```bash
   node src/cli.js lens active
   node src/cli.js lens inspect lenses/my-lens
   ```

### Config Resolution Order

Radar resolves the active lens in this order:

1. `.radar/config.json` in the project root (`active_lens` field) — project-local override
2. `~/.radar/config.json` (`active_lens` field) — global user config
3. Bundled default lens (`lenses/ck-conviction-era/`)

`active_lens` can be a bare name (looked up in `lenses/<name>/` then `~/.radar/lenses/<name>/`) or an absolute path within a known lens root.

---

## Notes on `_instructions` Keys

JSON has no comment syntax. A `_calibration_note` or similar underscore-prefixed key at the **top level** of a JSON file is safe — the loader reads named fields, and unknown fields are ignored.

Do **not** add underscore-prefixed keys inside `distributions.bands` or `round-params.rounds`. Those objects are iterated with `Object.keys()` / `Object.entries()` and every key is treated as a data entry.

Fields with underscore prefixes inside `bands` entries (like `calibration_note`) are safe — the solver only reads `outcomes` and `probs` from each band object.
