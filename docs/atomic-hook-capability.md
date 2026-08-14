# Atomic blocked-stage hook capability

Checked against the installed Atomic 0.9.12 extension reference and runtime
TypeScript declarations.

`ExtensionAPI.on` supports startup, resource, session, agent, provider, model,
tool, user-bash, and input events. The lifecycle diagram in
`/usr/local/lib/node_modules/@bastani/atomic/docs/extensions.md` lists no
`workflow_stage_blocked`, `stage_blocked`, or equivalent blocked-stage event.
The only generic blocking result is the `tool_call` result
`{ block: true, reason?: string }`, which cannot observe a workflow stage
blocked by another runtime.

This package therefore does **not** register an invented hook. The adapter in
`extensions/index.ts` reports:

```json
{
  "enabled": false,
  "hook_available": false
}
```

The workflow in `workflows/sme-orchestrator.ts` is an explicit scaffold only.
It records the limitation and never resumes an original workflow. A future
Atomic release may add a real hook; wiring it must still delegate to
`claim_blocked_stage`, then `sanitize_workflow_context`, strategy, deliberation,
and finally the single `orchestrate_sme` resume chokepoint.
