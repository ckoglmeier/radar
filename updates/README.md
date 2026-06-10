# Investor Updates

Quarterly updates from portfolio companies. Markdown files are the source of truth; the `company_updates` table is the queryable index.

## Directory layout

```
updates/
  <company-slug>/
    YYYY-QN.md          e.g. 2026-Q1.md
```

Slug rule: lowercase, hyphen-separated, stripped of suffixes like "Inc" or "Capital".

## File format

Every update file has three sections. Frontmatter + "From the Founders" are written by CK at import time. "Review" is written by Claude. "Feedback" is written by CK after reading the review.

```markdown
---
company: Acme Robotics
quarter: Q1 2026
date: 2026-04-15
arr: 250000
burn: 55000
runway_months: 9
headcount: 16
cash_on_hand: 495000
source: email
attachment: ./attachments/acme-robotics-2026-q1.pdf
---

# Acme Robotics — Q1 2026 Update

## From the Founders

<paste the founder update content here — milestones, challenges, asks, metrics narrative>

## Review (Claude)

### Flags / interesting threads
- <surprising metrics, trend changes, notable mentions>

### Bull read
<what's accelerating; the upside case if this trajectory holds>

### Bear read
<what's slipping; what this could look like in 2 quarters if the trend continues>

### Net read
<one-line synthesis: the single thing to watch next quarter>

### Suggested followups
- <specific questions CK should ask the founder>

## Feedback (CK)

<CK fills in his own notes, questions for the founder, action items>
```

## Review format (council-lite)

Every Claude review uses the 5-subsection structure above. Two principles:

- **Bull/Bear sections can be short.** On a routine quarterly check-in with no surprises, two sentences each is fine. The point is *tension*, not volume.
- **Net read is a one-liner.** A single sentence that names the one thing to watch. If it needs more, it's probably two things — pick the most important.

This is intentionally lighter than the investment-grading council (Bull/Bear/Calibrator/CFO). Updates are monitoring, not a binary invest decision — no "Deploy/Defer/Pass" vote is needed. If a follow-on round comes up, grade it through `radar eval` instead.

## Frontmatter fields

| Field | Required | Notes |
|---|---|---|
| `company` | yes | Canonical company name. Must match investments.company_name if linked. |
| `quarter` | yes | Format: `Q1 2026`. Used as dedup key with `company`. |
| `date` | yes | ISO date (YYYY-MM-DD). Date the update was sent/received. |
| `arr` | no | Annual recurring revenue or run-rate revenue, in USD. |
| `burn` | no | Monthly burn rate, in USD. |
| `runway_months` | no | Months of runway. Decimal OK (e.g. `9.5`). |
| `headcount` | no | Current FTE headcount. |
| `cash_on_hand` | no | Current cash balance, in USD. |
| `source` | no | `email`, `pdf`, `portal`, `call`. Default: `email`. |
| `attachment` | no | Relative path or URL to the original document. |

All money values are numeric USD. Do not include `$` or commas.

## Workflow

```bash
# 1. Scaffold a new update file
radar updates new "Acme Robotics" -q "Q1 2026"

# 2. Paste the update content into updates/acme-robotics/2026-Q1.md,
#    edit frontmatter metrics, save.

# 3. Import into the DB
radar updates import

# 4. Find anything needing review
radar updates list --needs-review

# 5. In a Claude session, ask Claude to review the file.
#    Claude reads the file, appends a "## Review (Claude)" section,
#    and flags interesting points + suggested followups.

# 6. Re-import to refresh has_review flag
radar updates import

# 7. CK fills in the "## Feedback (CK)" section with his own notes

# 8. Re-import to refresh has_feedback flag
radar updates import

# 9. View
radar updates detail <id>
radar updates timeline "Acme Robotics"
```
