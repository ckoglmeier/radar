# Saved analysis lenses — local implementation, October 18

Based on `7165040`; local branch `codex/saved-analysis-lenses`. No public release,
push or publication. Version `2.4.4-lenses.3`, migration 093.

`analysis_lenses` stores explicitly named, workspace/category-scoped reusable
preference copies. Saving a custom lens never replaces Angel theses, business
defaults, Giving Plan, budget, historical snapshots or financial facts. Angel
payload contains only interests and business preferences. Giving payload uses
the existing validated cause/priority contract. Empty is intentional unspecified.

Existing plan/default evaluation calls remain compatible. Angel drafts add
`lens_choice` / nullable `save_lens_name`; submit saves the full lens only when
custom is selected and a name is supplied, inside the command transaction.
Giving start accepts plan (default), a scoped saved id, or explicit custom
payload plus optional save name. Inputs freeze lens contents, hash and source;
personal preferences still do not alter objective organization research.

Named lenses are additive, not overwritten. Duplicate names fail explicitly.
The generic save command is not exposed to the LLM planner. Reads scope by
workspace AND category. Full backup/restore includes the table; Giving export
and reset include Giving lenses only, preserving Angel lenses.

Saved thesis belief snapshots are source material, not optional notes. Preserve
their exact wording (including whitespace) up to the separate 100,000-character
source bound; optional annotations retain their 1,000-character limit. Long
saved-thesis draft readback is covered by the lens tests, now part of
`test:angel-evaluations`. No historical snapshot is rewritten.
Personal-fit context includes that frozen thesis id/name/belief under the
interest's preference block. The previous projection included only its display
name. This is personal context, never independent company evidence or a change
to the objective Council/scoring inputs.

Verified on disposable PGlite: `node src/models/test-analysis-lenses.js` and
`node src/commands/test-angel-evaluation-commands.js`, both exit 0. Covers complete
Angel save at submission, empty/unchecked/custom/saved Giving snapshots, category
and workspace isolation, no plan mutation, duplicates, invalid facts, command
authorization, Giving export/reset and restore. No model/provider calls.

Only fictional test records were added. The engine repository is public; recheck
diffs before any future push. Desktop packaging/installation is a separate gate.
