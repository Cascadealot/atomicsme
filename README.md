# @bastani/atomic-sme

SQLite-backed SME context orchestration for Atomic workflows.

## Status

The first local stage keeps intercom rescue **disabled**. Atomic 0.9.12 has no
`workflow_stage_blocked` or blocked-stage extension event. The package ships a
truthful disabled adapter in `extensions/index.ts` and an explicit opt-in
workflow scaffold; it does not invent a hook or create a second resume path.

The verified catalog selectors are:

- coordinator: `openai-codex/gpt-5.6-luna`
- local SME candidates: `local-vllm-109/qwen3.6-27b-fp8`,
  `local-vllm-104-muse-glimmer/RedHatAI/Muse-Glimmer-30B-FP8-block`, and
  `local-qwen36-35b/qwen3.6-35b-a3b-iq4_nl`

Availability/authentication is still a runtime concern; policy records the
configured choice and fallback.

## Doors

`src/doors.ts` exports the RFC doors. `claim_blocked_stage` is the first
idempotency transition. `reserve_sme_call` is the only budget reservation
path. `sanitize_workflow_context` is the raw-context airlock. Only
`orchestrate_sme` can return a `continue` decision. SQLite persistence is in
`src/store.ts` and uses the Node 22+ `node:sqlite` `DatabaseSync` API with
FTS5.

The API returns `{ ok, value }` or `{ ok, error }` rather than throwing domain
refusals. Each model invocation must happen after a durable claim and budget
reservation.

## Local checks

```bash
npm install
npm run check
atomic --offline --no-session -e . --list-models
```

Do not publish, release, create a PR, or enable rescue as part of local staging.
