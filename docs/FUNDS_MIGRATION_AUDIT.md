# Funds migration audit

The Funds migration starts with a read-only inventory. It does not create fund
profiles, reclassify Direct positions, link holdings, or archive a room.

```sh
radar db:migrate
radar funds audit
```

The command writes deterministic JSON under `backups/` and prints a compact
human report. Use `--out <file>` to choose another JSON path.

The audit includes:

- every existing Fund investment and its entity, valuations, cash flows, and
  document metadata (never document bytes);
- every Funds room and holding, including unlinked and duplicate links;
- safe parsing of commitment, vintage, manager, strategy, status, description,
  and commitment-date cells while preserving the complete original cell map;
- explicit `migrate`, `create_fund`, and `reclassify_direct` proposals whose
  `decision` remains `null` for owner review;
- Direct analytics before and after each possible reclassification;
- Fund-routed reconciliation transactions, including notes, source account,
  and exact-name candidate positions;
- unlinked flows whose company or SPV exactly matches a Fund position even when
  their current disposition is `ignored` or `pending`;
- exact-name duplicates and broader family-name similarities, which are review
  hints only and never entity merges;
- merged-position traversal and blocking conflicts for missing mappings,
  cycles, ambiguous holdings, unsupported linked classes, or invalid Fund
  entity types;
- explicit checks for Incisive Ventures, Future of Food, Range II, and S+H
  Capital without assuming they exist or are linked.

Money parsing accepts non-negative USD numbers with optional `$`, commas, and
`k`/`m` suffixes. Other currencies, ambiguous text, invalid vintages, unknown
statuses, and non-ISO dates remain parse errors for review. Raw room values are
always retained in the audit.

This command is the input to the later reviewed Funds migration manifest. It
is not itself an apply command.
