# @bastani/atomic-sme

SQLite-backed SME context orchestration for Atomic workflows.

## Status

Intercom rescue remains **disabled**. Atomic 0.9.12 has no
`workflow_stage_blocked` or blocked-stage extension event. The package ships a
truthful disabled adapter in `extensions/index.ts`. `workflows/sme-orchestrator.ts`
remains a disabled-rescue status scaffold; it is not the runnable domain demo,
does not activate rescue, and has no resume effect.

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

## Manual orchestration demo

Run the domain API demo from a source checkout:

```bash
npm run demo:manual
```

`examples/manual-orchestration.ts` claims a blocked stage, sanitizes its raw
context, prepares a bounded strategy, and calls `orchestrate_sme` with an
injected local `call_sme` mock. It then inspects the persisted round and budget
state through the public API. Assertions prove that the durable claim and
prepared request exist before the mock runs.

The demo needs no model configuration or credentials, network access, package
staging, or rescue activation. It uses a temporary SQLite database and artifact
directory and removes the whole temporary tree in a `finally` block on success
or failure. This domain API example is separate from the disabled-rescue status
scaffold in `workflows/sme-orchestrator.ts`.

## Source-checkout install and checks

Node `22.19` or newer is required. A clean checkout installs its locked
dependencies and builds `dist/` during `npm ci`:

```bash
npm ci
npm run lint
npm run typecheck
npm run check
npm run demo:manual
npm run atomic:check
```

`npm run check` runs the ESLint gate, typecheck, existing tests, and the tracked
clean package smoke test. The smoke test starts without `dist/`, runs
`npm pack --json`, installs the resulting archive into an empty temporary
consumer, and imports the package, extension, and workflow entry points.

## Packaged install

From a source checkout, create an archive and install it in a fresh consumer:

```bash
archive=$(npm pack --silent)
consumer=$(mktemp -d)
printf '{"private":true,"type":"module"}\n' > "$consumer/package.json"
npm install --prefix "$consumer" "$(pwd)/$archive"
(cd "$consumer" && node --input-type=module -e 'for (const entry of ["@bastani/atomic-sme", "@bastani/atomic-sme/dist/extensions/index.js", "@bastani/atomic-sme/dist/workflows/sme-orchestrator.js"]) await import(entry)')
rm -rf "$consumer" "$archive"
```

The package lifecycle rebuilds from a clean state before packing, so a missing
or stale `dist/` does not affect the generated archive.

Do not publish, release, create a PR, or enable rescue as part of local staging.
