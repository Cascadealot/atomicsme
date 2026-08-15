import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SMEStore,
  claim_blocked_stage,
  inspect_sme_orchestration,
  orchestrate_sme,
  prepare_sme_strategy,
  sanitize_workflow_context,
} from "../src/index.js";
import type { Result, SMEBlockRescueRequested } from "../src/index.js";

type PublicDoorError = { kind: string; message: string };

function unwrap<T>(label: string, result: Result<T, PublicDoorError>): T {
  if (!result.ok) throw new Error(`${label} failed: ${result.error.kind}: ${result.error.message}`);
  return result.value;
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "atomic-sme-manual-"));
const databasePath = join(temporaryRoot, "sme.db");
const artifactDir = join(temporaryRoot, "artifacts");
let store: SMEStore | undefined;

try {
  store = new SMEStore(databasePath, () => true);
  const requested: SMEBlockRescueRequested = {
    event_id: "manual-demo-event",
    workflow_run_id: "manual-demo-run",
    stage_id: "manual-demo-stage",
    idempotency_key: "manual-demo-claim",
    raw_context: {
      workflow_run_id: "manual-demo-run",
      stage_id: "manual-demo-stage",
      blocked_reason: "Confirm that the local manual demo can continue safely.",
      raw_input: {
        question: "Can this local demo continue?",
        token: "demo-secret",
        transcript: "This bulk field becomes a temporary safe artifact.",
      },
      raw_output: { status: "blocked" },
      artifacts: [],
    },
  };

  const claim = unwrap("claim", claim_blocked_stage(requested, store));
  const claimedStatus = unwrap(
    "claimed orchestration inspection",
    inspect_sme_orchestration(claim.orchestration_id, { workflow_run_id: claim.workflow_run_id, authorized: true }, store),
  );
  assert.equal(claimedStatus.orchestration_id, claim.orchestration_id);
  assert.equal(claimedStatus.rounds_recorded, 0);
  assert.equal(claimedStatus.budget, undefined);

  const trustedContext = unwrap("context sanitization", sanitize_workflow_context(requested.raw_context, {
    redactionPolicy: "strict",
    redactionPolicyVersion: "strict-v1",
    artifactFirst: true,
    artifactDir,
    bulkFields: ["transcript"],
  }));
  assert.equal(JSON.stringify(trustedContext).includes("demo-secret"), false);
  assert.equal(trustedContext.safe_artifacts.length, 1);

  const prepared = unwrap("strategy preparation", prepare_sme_strategy(trustedContext, [], {
    budget: { max_rounds: 2, max_sme_calls: 2, max_cost: "1" },
    require_web_research: false,
    diversify_models_when_available: false,
    persona_factory: () => [{
      id: "manual-local-mock",
      title: "Local mock reviewer",
      domain: "manual orchestration",
      local_conditions: ["Use only the supplied trusted context."],
      initial_brief: "Return the fixed local demo answer.",
    }],
  }));

  let mockCalls = 0;
  const decision = unwrap("orchestration", await orchestrate_sme(claim, prepared, {
    store,
    call_sme: async (persona, question, roundNumber) => {
      const durableBeforeMock = unwrap(
        "pre-mock durable inspection",
        inspect_sme_orchestration(claim.orchestration_id, { orchestration_ids: [claim.orchestration_id], authorized: true }, store),
      );
      assert.equal(durableBeforeMock.orchestration_id, claim.orchestration_id, "claim must be durable before the mock runs");
      assert.deepEqual(durableBeforeMock.personas.map(({ id }) => id), prepared.personas.map(({ id }) => id), "request must be durable before the mock runs");
      assert.deepEqual(durableBeforeMock.budget?.budget, prepared.budget, "prepared budget must be durable before the mock runs");
      assert.equal(durableBeforeMock.rounds_recorded, 0);
      assert.equal(durableBeforeMock.calls_recorded, 1, "the call must be reserved before the mock runs");
      assert.equal(persona.id, prepared.personas[0].id);
      assert.equal(question.context.workflow_run_id, claim.workflow_run_id);
      assert.equal(roundNumber, 1);
      mockCalls += 1;
      return { answer: "Continue with the local demo.", reasoning: "The injected mock confirms the prepared request.", actual_cost: "0.1" };
    },
  }));
  assert.equal(mockCalls, 1);

  const persisted = unwrap(
    "settled orchestration inspection",
    inspect_sme_orchestration(claim.orchestration_id, { orchestration_ids: [claim.orchestration_id], authorized: true }, store),
  );
  assert.deepEqual(persisted.decision, decision);
  assert.ok(persisted.budget);

  console.log(`orchestration_id=${claim.orchestration_id}`);
  console.log(`decision_kind=${decision.kind}`);
  console.log(`persisted_budget rounds=${persisted.rounds_recorded}/${persisted.budget.budget.max_rounds} calls=${persisted.calls_recorded}/${persisted.budget.budget.max_sme_calls} cost=${persisted.budget.spent_cost}/${persisted.budget.budget.max_cost} status=${persisted.budget.status}`);
} finally {
  try {
    store?.close();
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
