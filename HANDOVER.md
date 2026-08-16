# Handover — Atomic SME Project

Written for a future session (agent or human) resuming from this point.

## Snapshot

- Project: `/home/observatory/prj/sme` — `@bastani/atomic-sme`
- What it is: SQLite-backed SME (Subject Matter Expert) context orchestration for Atomic workflows.
- Machine: VM 198 (`192.168.1.198`, hostname `ubuntu2604`, user `observatory`).
- Credentials: `~/prj/creds.md` (lab password `Secret1`).

## Git state

- `main` is clean and pushed to `origin` (GitHub `Cascadealot/atomicsme`).
- Merged commits:
  - `9b4aab8` fix: make package installs deterministic (+ ESLint) — issue #1
  - `08a3024` test: cover durable lifecycle and budget caps — issue #2
  - `9aa7f55` docs: add manual SME orchestration demo — issue #3
  - `1d3d678` fix: scrub nested structural identifiers — issue #4
  - `cc771f9` revert: remove CI workflow (CI is NOT our process)
  - `bd38b20` feat: add sme-unblock workflow (global SME orchestration)
- All 4 issues closed on GitHub. 0 open issues, 0 open PRs.

## Key artifacts and where they live

- `workflows/sme-unblock.ts` — global SME workflow. Committed. Built to `dist/`, installed globally via `atomic install /home/observatory/prj/sme`.
- `.atomic/workflows/resolve-issue.ts` — reusable issue-resolution workflow. **Gitignored, local only.** Validated end-to-end on the benchmark.
- `.atomic/workflows/issue-{1,2,3,4}-sol-grok.ts` — one-shot per-issue workflows (historical record).
- `~/.atomic/lab/llm-catalog.json` — lab-wide model catalog: roles lexicon, 11 models, capability/preference/config.
- Gitea on VM 198 — `http://192.168.1.198:3000/` (admin `observatory` / `Secret1`). Benchmark repo `observatory/atomic-sme-benchmark`, baseline `be7d753`, 4 seeded issues.
- Feedback DB — `.atomic/atomic-state.db`, auto-created on first use by `resolve-issue`.
- Planning lists — `hugefuckinglist.txt` (deleted during cleanup); the design decisions are captured in this doc.

## The SME feature

- `sme-unblock` is a **global Atomic workflow**: install once, available to every session.
- Proven end-to-end: claim → sanitize → prepare → orchestrate → real SME model call → durable decision returned.
- Defaults: one SME persona, no web research, model auto-picked from catalog (highest preference with `sme`/`worker` role).
- Explicit invocation works now. Automatic rescue still blocked on Atomic's missing blocked-stage hook (0.9.13).

## Lab rules (do not violate)

1. In-house first, not offline-only. Internet stays for SME research and downloads.
2. No external CI. All review/lint/QA run in-house via workflows.
3. Catalog-only models. No hardcoded models. Agents choose from `llm-catalog.json`. The audit catches violations.
4. Enable/enhance/assist agents. Never gate or constrain. Feedback is free-form.
5. Human pace. Propose → approve → execute. Do not run ahead.
6. Failure is signal. Share it openly; never hide or silently self-correct.

## Known loose ends

1. `sme-unblock` inspection returned `rounds_recorded: 0` / `calls_recorded: 0` on the first run, though the SME clearly ran. Cosmetic wiring detail to investigate.
2. Multi-SME path not yet exercised: disagreement → revise round → agreement, budget caps, replay safety.
3. `resolve-issue` implement stages leave new files untracked, so reviewers can't see them in the diff. Three fix options proposed, none decided yet.
4. Self-learning feedback loop not built (feedback → catalog/DB → next run).
5. LLM catalog is human-owned (Cas). Needs ongoing assessment.
6. Non-Atomic package install (npm publish) is out of scope.

## Suggested next work list (ranked)

1. Investigate/fix `sme-unblock` rounds/calls inspection returning 0.
2. Exercise the multi-SME path: `diversify_models_when_available: true`, two SME models, verify disagreement → revise → agreement.
3. Decide + fix the `resolve-issue` untracked-new-files gap (stage new files so reviewers see them).
4. Extend SME selection: per-persona catalog models, optional web research.
5. Build the self-learning feedback loop (feedback DB → next-run guidance).
6. Catalog maintenance (Cas): keep capability/preference/availability current.
7. Later: automatic rescue when Atomic ships the blocked-stage hook.

## Guidance for the next ~10 hours

- Everything persists on VM 198. Start: `cd /home/observatory/prj/sme && git status` (should be clean), then `workflow list` to confirm `sme-unblock` and `resolve-issue` are present.
- Models: use only `~/.atomic/lab/llm-catalog.json` entries. No Anthropic (fails). Use Sol / Grok / DeepSeek / local.
- Work at Cas's pace. He drives. Propose, wait for approval, then act.
- Failure is signal — report it, don't bury it.
