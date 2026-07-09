# The Council & Model Auth

Radar can run an adversarial investment **council** over a deal — Bull, Bear,
Calibrator, and CFO, each scoring against your own lens — and write the result
to your deal log. This doc covers how to run it and how it authenticates to
Claude.

## Running the council

```
radar council <deal-slug>
```

Grades a pipeline deal headlessly: it researches the team and company, runs the
council against your injected lens + calibration, writes a
`deal-log/YYYY-MM-DD-company.md` diagnosis, and ingests it into
`deal_evaluations`.

Flags:
- `--dry-run` — assemble and preview the session (models, tools, context size)
  **without** calling a model or writing anything. Good for a first look.
- `--deal-log-dir <path>` — where the artifact is written (defaults to
  `$DEAL_LOG_DIR`).

The judgment the council scores against is never baked into the tool — it is
injected at run time from your lens (rubric, kill criteria, GP tiers, theses)
and your calibration (which evolves as you grade more deals). The vendored
procedure at `skills/investment-grading/SKILL.md` contains no calibration of its
own.

## Auth modes

Radar routes every model call through the Claude Agent SDK, which can bill two
ways. Choose with `RADAR_AUTH_MODE`:

| `RADAR_AUTH_MODE` | Bills | Use when |
|---|---|---|
| `api_key` (default) | Pay-per-token API credits | Any deployment; the only mode allowed for hosted/multi-user |
| `subscription` | Your Claude subscription's monthly Agent-SDK credit | A single-user, local install (CLI / desktop) |

### api_key mode (default)

Set `ANTHROPIC_API_KEY`. Nothing else to do.

### subscription mode

Bills against your Pro/Max/Team subscription's Agent-SDK credit instead of
metered API tokens. It does **not** draw down your interactive Claude Code / chat
limits.

1. Generate a subscription token, then **export what it prints**:
   ```
   claude setup-token
   export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-…'   # the token it printed
   ```
   Add the export to your shell profile to persist it. Radar passes it through to
   the SDK subprocess; it never logs or copies the value.
2. Select the mode:
   ```
   export RADAR_AUTH_MODE=subscription
   ```
3. **Unset any `ANTHROPIC_API_KEY`.** If a key is present, the CLI would silently
   prefer it and bill your API account instead of the subscription. Radar refuses
   to start subscription mode while a key is in the environment:
   ```
   unset ANTHROPIC_API_KEY
   ```

Check what's configured (and, with `--probe`, what actually wins):
```
radar auth:status
radar auth:status --probe    # spawns a tiny session; needs a live credential
```
`--probe` reports what actually billed. On the subscription it reads **"billing
your subscription (no API key used)"** — the SDK's `apiKeySource` is `none`
because the OAuth token uses no API key. If it instead reports an API key while
you selected subscription (or vice-versa), Radar flags the mismatch — so you
never get a silent billing surprise.

## The single-user boundary

The subscription/OAuth path is licensed for **individual, single-user** use.
Serving other people's requests must use `api_key`. Radar enforces this: with any
non-local `RADAR_MODE` set (a hosted or multi-user deployment), subscription mode
refuses to start. **Productizing Radar for others means api_key mode.**

## Fallback (opt-in, never silent)

If the subscription hits a credit or rate limit, Radar surfaces a clear error and
stops — it does **not** quietly switch to metered billing. To allow a fallback to
`api_key` on those (and only those) conditions:
```
export RADAR_FALLBACK_TO_API=true
```
Exact string `true` only. Authentication failures never fall back.

## Model policy

Each council role runs at the cheapest model that fits, as SDK aliases (the SDK
resolves the current model per tier):

| Role | Model |
|---|---|
| Research (web retrieval) | haiku |
| Bull / Bear / CFO | sonnet |
| Calibrator (canonical score) | opus |

## Secrets

Tokens and keys stay in your local credential store / environment. Radar never
commits, bundles, or logs them; any credential value that appears in an error is
redacted before it surfaces. Keep `.env` out of git (it already is).
