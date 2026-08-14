import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claim_blocked_stage,
  orchestrate_sme,
  prepare_sme_strategy,
  reserve_sme_call,
  sanitize_workflow_context,
} from "../src/doors.js";
import { SMEStore } from "../src/store.js";
import type {
  DeliberationBudget,
  PreparedSMERequest,
  RawWorkflowBlockContext,
  SMEBlockRescueRequested,
} from "../src/types.js";

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "atomic-sme-lifecycle-")), "sme.db");
}

function rescueEvent(): SMEBlockRescueRequested {
  const raw_context: RawWorkflowBlockContext = {
    workflow_run_id: "lifecycle-run",
    stage_id: "blocked-stage",
    blocked_reason: "Choose the safe outcome",
    raw_input: { question: "Should this continue?" },
    raw_output: { result: "blocked" },
    artifacts: [],
  };
  return {
    event_id: "lifecycle-event",
    workflow_run_id: raw_context.workflow_run_id,
    stage_id: raw_context.stage_id,
    idempotency_key: "lifecycle-key",
    raw_context,
  };
}

async function prepare(
  store: SMEStore,
  budget: DeliberationBudget = { max_rounds: 3, max_sme_calls: 6, max_cost: "6" },
  models = ["local-a", "local-b"],
) {
  const requested = rescueEvent();
  const claimed = claim_blocked_stage(requested, store);
  assert.equal(claimed.ok, true);
  const trusted = await sanitize_workflow_context(requested.raw_context, {
    redactionPolicy: "strict",
    artifactFirst: true,
  });
  assert.equal(trusted.ok, true);
  const strategy = prepare_sme_strategy(trusted.value, [], {
    sme_models: models,
    budget,
    require_web_research: false,
    diversify_models_when_available: models.length > 1,
  });
  assert.equal(strategy.ok, true);
  return { claim: claimed.value, strategy: strategy.value };
}

function assertNonContinuing(decision: { kind: string }): void {
  assert.notEqual(decision.kind, "continue");
  assert.ok(decision.kind === "unresolved" || decision.kind === "escalate");
}

test("duplicate delivery runs one SME execution set and one successful callback across replay", async () => {
  const store = new SMEStore(databasePath(), () => true);
  const { claim, strategy } = await prepare(store);
  const executions: Array<{ persona: string; round: number }> = [];
  let successfulDeliveries = 0;
  const call_sme = async (persona: { id: string }, _question: unknown, round: number) => {
    executions.push({ persona: persona.id, round });
    return { answer: "continue safely", reasoning: "the evidence agrees" };
  };
  const deliver = async () => { successfulDeliveries += 1; };

  const initial = await orchestrate_sme(claim, strategy, { store, call_sme, deliver });
  const replay = await orchestrate_sme(claim, strategy, { store, call_sme, deliver });

  assert.equal(initial.ok, true);
  assert.equal(initial.value.kind, "continue");
  assert.deepEqual(replay, initial);
  assert.deepEqual(executions, strategy.personas.map((persona) => ({ persona: persona.id, round: 1 })));
  assert.equal(successfulDeliveries, 1);
  assert.equal(store.getOrchestrationRow(claim.orchestration_id)?.delivery_status, "delivered");
  store.close();
});

test("delivery retry persists failure then replays one delivery with zero extra SME calls", async () => {
  const store = new SMEStore(databasePath(), () => true);
  const { claim, strategy } = await prepare(store);
  let smeCalls = 0;
  let deliveryAttempts = 0;
  let successfulDeliveries = 0;
  const call_sme = async () => {
    smeCalls += 1;
    return { answer: "continue safely", reasoning: "the evidence agrees" };
  };
  const deliver = async () => {
    deliveryAttempts += 1;
    if (deliveryAttempts === 1) throw new Error("temporary delivery failure");
    successfulDeliveries += 1;
  };

  const initial = await orchestrate_sme(claim, strategy, { store, call_sme, deliver });
  assert.equal(initial.ok, true);
  assert.equal(smeCalls, strategy.personas.length);
  assert.equal(deliveryAttempts, 1);
  assert.equal(successfulDeliveries, 0);
  assert.equal(store.getOrchestrationRow(claim.orchestration_id)?.delivery_status, "failed");
  const callsAfterFailure = smeCalls;

  const replay = await orchestrate_sme(claim, strategy, { store, call_sme, deliver });
  assert.deepEqual(replay, initial);
  assert.equal(deliveryAttempts, 2);
  assert.equal(successfulDeliveries, 1);
  assert.equal(smeCalls, callsAfterFailure);
  assert.equal(store.getOrchestrationRow(claim.orchestration_id)?.delivery_status, "delivered");
  store.close();
});

test("reservation restart preserves reservation identity and aggregate call and cost accounting", async () => {
  const path = databasePath();
  const firstStore = new SMEStore(path, () => true);
  const { claim, strategy } = await prepare(firstStore, { max_rounds: 2, max_sme_calls: 4, max_cost: "1" });
  firstStore.saveRequest(claim, strategy);
  const details = { persona_id: strategy.personas[0].id, round_number: 1, estimated_cost: "0.4" };
  const initial = reserve_sme_call(claim, details, strategy.budget, firstStore);
  assert.equal(initial.ok, true);
  firstStore.completeReservation(initial.value.reservation_id, {
    answer: "durable answer",
    reasoning: "durable evidence",
    actual_cost: "0.25",
  });
  firstStore.close();

  const reopened = new SMEStore(path, () => true);
  const durableClaim = reopened.getClaim(claim.orchestration_id);
  assert.deepEqual(durableClaim, claim);
  assert.ok(durableClaim);
  const retried = reserve_sme_call(durableClaim, details, strategy.budget, reopened);
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.value, initial.value);
  const aggregate = reopened.budget(claim.orchestration_id, strategy.budget);
  assert.equal(aggregate.spent_sme_calls, 1);
  assert.equal(aggregate.reserved_cost, "0");
  assert.equal(aggregate.spent_cost, "0.25");
  assert.equal((reopened.db.prepare("SELECT COUNT(*) AS count FROM sme_call_reservations WHERE orchestration_id = ?").get(claim.orchestration_id) as { count: number }).count, 1);
  reopened.close();
});

test("disagreement persists a later round and later agreement follows the final decision path", async () => {
  const store = new SMEStore(databasePath(), () => true);
  const { claim, strategy } = await prepare(store);
  const laterQuestions: PreparedSMERequest["question"][] = [];
  const result = await orchestrate_sme(claim, strategy, {
    store,
    call_sme: async (persona, question, round) => {
      if (round === 1) return { answer: `first-${persona.id}`, reasoning: "independent view" };
      laterQuestions.push(question);
      return { answer: "later consensus", reasoning: "peer review resolved the difference" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "continue");
  const rounds = store.listRounds(claim.orchestration_id);
  assert.equal(rounds.length, 2);
  assert.notEqual(rounds[0].answers[0].answer, rounds[0].answers[1].answer);
  assert.ok(rounds[1].answers.every((answer) => answer.answer === "later consensus"));
  assert.equal(laterQuestions.length, strategy.personas.length);
  assert.ok(laterQuestions.every((question) => question.peer_answers?.length === strategy.personas.length));
  assert.deepEqual(store.getDecision(claim.orchestration_id), result.value);
  store.close();
});

test("final budget cap never persists or returns continue after call or round exhaustion", async () => {
  const cases = [
    { name: "call", budget: { max_rounds: 2, max_sme_calls: 1, max_cost: "1" } },
    { name: "round", budget: { max_rounds: 1, max_sme_calls: 2, max_cost: "1" } },
  ] as const;

  for (const budgetCase of cases) {
    const store = new SMEStore(databasePath(), () => true);
    const { claim, strategy } = await prepare(store, budgetCase.budget, ["local-only"]);
    const result = await orchestrate_sme(claim, strategy, {
      store,
      call_sme: async () => ({ answer: "apparent agreement", reasoning: "bounded evidence", actual_cost: "0.1" }),
    });

    assert.equal(result.ok, true, `${budgetCase.name} cap should settle normally`);
    assertNonContinuing(result.value);
    const persisted = store.getDecision(claim.orchestration_id);
    assert.ok(persisted);
    assertNonContinuing(persisted);
    const remaining = store.budget(claim.orchestration_id, strategy.budget);
    assert.equal(remaining.status, "exhausted");
    if (budgetCase.name === "call") {
      assert.equal(remaining.spent_sme_calls, strategy.budget.max_sme_calls);
      assert.ok(remaining.spent_rounds < strategy.budget.max_rounds);
    } else {
      assert.equal(remaining.spent_rounds, strategy.budget.max_rounds);
      assert.ok(remaining.spent_sme_calls < strategy.budget.max_sme_calls);
    }
    store.close();
  }
});
