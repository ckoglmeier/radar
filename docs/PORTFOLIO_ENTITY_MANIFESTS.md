# Portfolio entity manifests

Radar keeps legal-entity identity separate from investment positions. The
identity migration is review-gated: the audit proposes links but never writes
them, and apply accepts only an explicitly edited manifest.

## Create the dry run

```sh
radar db:migrate
radar portfolio identity-audit
```

The audit writes a deterministic JSON manifest under `backups/` and reports
the candidate and conflict counts. Each candidate includes the affected
position names, dates, asset classes, ownership entities, sources, and any
confirmed alias evidence.

Fund candidates are always one position per legal vehicle. Similar names,
managers, Roman numerals, and vintages never cause fund entities to be merged.
Archived `merged` positions are not candidates; the audit follows their
consolidation chain to the surviving position and blocks on missing mappings or
cycles.

## Record decisions

Replace each candidate's `null` decision with one of:

```json
{ "action": "create_and_link" }
```

```json
{ "action": "create_and_link", "legal_name": "Correct Legal Name", "legal_form": "llc" }
```

```json
{ "action": "link_existing", "entity_id": "existing-entity-uuid" }
```

```json
{ "action": "leave_unlinked" }
```

Optional create fields are `legal_name`, `legal_form`, `jurisdiction`,
`website`, and `description`. Do not edit proposal fields, hashes, conflicts,
or source evidence. `legal_form`, when known, is one of `llc`,
`c_corporation`, `limited_partnership`, or `other`. Run a new audit if a
proposal is wrong.

## Apply the reviewed manifest

```sh
radar portfolio identity-apply ./backups/reviewed-manifest.json
```

Apply is supported only on local PGlite until Radar has a hosted driver with
real interactive transactions. It rejects unresolved conflicts, missing
decisions, edited proposals, stale source data, merged-position targets, and
links that now point elsewhere. All approved links are written in one
transaction; any error rolls back the full manifest. Reapplying the same
approved manifest is safe and produces no duplicate entities or links.

This wave intentionally leaves `UNIQUE(company_name, invest_date)` in place so
the current AngelList and CSV importers continue to work unchanged.
