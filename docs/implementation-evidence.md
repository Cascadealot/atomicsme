# @bastani/atomic-sme implementation evidence

Date: 2026-08-13

## Scope

Lightweight Atomic lab demo from `specs/2026-08-13-sme-agent-context-orchestration.md`.
Intercom rescue stays disabled because Atomic 0.9.12 exposes no blocked-stage hook.

## Evidence

| Requirement | Evidence |
| --- | --- |
| Valid Atomic package | `package.json` declares `atomic.extensions` and `atomic.workflows`; build emits `dist/`. |
| SQLite persistence | `src/store.ts` uses Node 22 `DatabaseSync`, FTS5, durable claims, reservations, rounds, decisions, and purge receipts. |
| Claim before model work | `claim_blocked_stage` persists the idempotency claim; orchestration reserves each call before invoking `call_sme`. |
| Durable call budgets | Reservations and actual costs are stored in SQLite and checked against rounds, calls, and cost limits. |
| Redaction/airlock | `sanitize_workflow_context` is the raw-to-trusted transition; persisted answers and decisions are redacted. |
| Single resume chokepoint | `orchestrate_sme` is the only door that returns an unblock decision; the adapter never resumes a workflow. |
| Verified Atomic limitation | `docs/atomic-hook-capability.md` records the extension API check and the disabled adapter. |
| Tests and package checks | `npm run check`, `npm run typecheck`, `npm run atomic:check`, Atomic workflow discovery/execution, and `npm pack --dry-run` pass. |

## Explicitly deferred

This demo does not add production security hardening, advanced lease fencing,
full governance enforcement, or a live rescue integration. Those are deferred
because the user narrowed the task to a lightweight lab demo and required
rescue to remain disabled.

## Contract amendments received

> This is supposed to be a lighweight, simple, none security aware (no need for such in this lab) demo. I think we should regroup and define our path to success, because this does not appear to be working for me.

> Stop this workflow.

> Continue where you left off. If you believe you are finished with your original task (or a redefined task if the user told you), stop.

> <keepContext>Stop broad research now. Use only findings already gathered plus local Atomic docs/source. Write the concise evidence artifact and advance to implementation. Do not wait on unavailable Anthropic models or web research. Keep rescue disabled; do not install, publish, release, or enable rescue until package checks pass.</keepContext>
