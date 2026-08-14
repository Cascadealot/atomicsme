import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claim_blocked_stage,
  inspect_sme_orchestration,
  orchestrate_sme,
  prepare_sme_strategy,
  purge_sme_memory,
  record_sme_round,
  reserve_sme_call,
  search_sme_memory,
  synthesize_response,
} from "../src/doors.js";
import { govern_workflow_context, readSafeArtifact, redactText, sanitize_workflow_context, writeSafeArtifact } from "../src/context.js";
import { SMEStore } from "../src/store.js";
import type { ClaimedBlockedStage, PreparedSMERequest, RawWorkflowBlockContext, SMEAnswer, SMEBlockRescueRequested, SMEPolicy } from "../src/types.js";

function setup() {
  return new SMEStore(join(mkdtempSync(join(tmpdir(), "atomic-sme-")), "sme.db"), () => true);
}

function event(secret = "safe"): SMEBlockRescueRequested {
  const raw: RawWorkflowBlockContext = {
    workflow_run_id: "run-1",
    stage_id: "stage-1",
    blocked_reason: "Need domain judgment",
    raw_input: { question: "Should this pass?", token: secret, email: "person@example.com" },
    raw_output: { result: "blocked" },
    artifacts: [],
  };
  return { event_id: "event-1", workflow_run_id: "run-1", stage_id: "stage-1", idempotency_key: "key-1", raw_context: raw };
}

async function prepared(store: SMEStore) {
  const claimed = claim_blocked_stage(event(), store);
  assert.equal(claimed.ok, true);
  const trusted = await sanitize_workflow_context(event().raw_context, { redactionPolicy: "strict", artifactFirst: true, maxInlineBytes: 32_000 });
  assert.equal(trusted.ok, true);
  const policy: SMEPolicy = { coordinator_model: "frontier", sme_models: ["local-a", "local-b"], budget: { max_rounds: 2, max_sme_calls: 4, max_cost: "1" }, require_web_research: true, diversify_models_when_available: true };
  const strategy = prepare_sme_strategy(trusted.value, [], policy);
  assert.equal(strategy.ok, true);
  return { claim: claimed.value, strategy: strategy.value };
}

async function completeRoundCalls(store: SMEStore, claim: ClaimedBlockedStage, strategy: PreparedSMERequest): Promise<SMEAnswer[]> {
  const answers: SMEAnswer[] = [];
  for (const persona of strategy.personas) {
    const reserved = reserve_sme_call(claim, { persona_id: persona.id, round_number: 1, estimated_cost: "0.1" }, strategy.budget, store);
    assert.equal(reserved.ok, true);
    if (!reserved.ok) continue;
    store.completeReservation(reserved.value.reservation_id, { answer: `answer-${persona.id}`, reasoning: "reason", sources: [{ url: `https://${persona.id}.example` }] });
    const result = store.getReservationResult(reserved.value.reservation_id);
    assert.ok(result);
    if (result) answers.push({ persona_id: persona.id, answer: result.answer, reasoning: result.reasoning, sources: result.sources ?? [], ...(result.actual_cost == null ? {} : { actual_cost: result.actual_cost }), ...(result.model == null ? {} : { model: result.model }) });
  }
  return answers;
}

test("sanitize airlock removes secret and PII", async () => {
  const result = await sanitize_workflow_context(event().raw_context, { redactionPolicy: "strict", artifactFirst: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.sanitized_input, { question: "Should this pass?" });
  assert.equal(JSON.stringify(result.value).includes('"token"'), false);
  assert.equal(JSON.stringify(result.value).includes("person@example.com"), false);
});

test("sanitize scrubs nested structural ID values but preserves trusted top-level identity", () => {
  const nestedStageId = "stage owner nested-stage-owner@example.test token is NESTED_STAGE_TOKEN_ABC12345";
  const nestedIdempotencyKey = "requester nested-key-owner@example.test token is NESTED_KEY_TOKEN_XYZ67890";
  const raw = event().raw_context;
  raw.workflow_run_id = "Run/Exact:ABC_123";
  raw.stage_id = "Stage/Exact:XYZ_789";
  raw.raw_input = { metadata: { stage_id: nestedStageId } };
  raw.raw_output = { metadata: { idempotency_key: nestedIdempotencyKey } };

  const result = sanitize_workflow_context(raw, { redactionPolicy: "strict", artifactFirst: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const serialized = JSON.stringify(result.value);
  assert.equal(serialized.includes(nestedStageId), false);
  assert.equal(serialized.includes("nested-stage-owner@example.test"), false);
  assert.equal(serialized.includes("NESTED_STAGE_TOKEN_ABC12345"), false);
  assert.equal(serialized.includes(nestedIdempotencyKey), false);
  assert.equal(serialized.includes("nested-key-owner@example.test"), false);
  assert.equal(serialized.includes("NESTED_KEY_TOKEN_XYZ67890"), false);
  assert.equal(result.value.workflow_run_id, raw.workflow_run_id);
  assert.equal(result.value.stage_id, raw.stage_id);
});

test("safe artifact persistence scrubs nested structural ID values", () => {
  const nestedStageId = "stage owner artifact-stage-owner@example.test token is ARTIFACT_STAGE_TOKEN_ABC12345";
  const nestedIdempotencyKey = "requester artifact-key-owner@example.test token is ARTIFACT_KEY_TOKEN_XYZ67890";
  const artifactDir = mkdtempSync(join(tmpdir(), "atomic-sme-artifacts-"));
  const ref = writeSafeArtifact(
    { metadata: { stage_id: nestedStageId, idempotency_key: nestedIdempotencyKey } },
    artifactDir,
    "nested-structural-ids",
    { redactionPolicy: "strict", artifactFirst: true },
  );

  const persisted = readFileSync(ref.path, "utf8");
  assert.equal(persisted.includes(nestedStageId), false);
  assert.equal(persisted.includes("artifact-stage-owner@example.test"), false);
  assert.equal(persisted.includes("ARTIFACT_STAGE_TOKEN_ABC12345"), false);
  assert.equal(persisted.includes(nestedIdempotencyKey), false);
  assert.equal(persisted.includes("artifact-key-owner@example.test"), false);
  assert.equal(persisted.includes("ARTIFACT_KEY_TOKEN_XYZ67890"), false);
});

test("claim is idempotent and changed payload is refused", () => {
  const store = setup();
  const first = claim_blocked_stage(event(), store);
  const replay = claim_blocked_stage(event(), store);
  assert.equal(first.ok, true);
  assert.deepEqual(replay, first);
  const mismatch = claim_blocked_stage(event("different"), store);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.kind, "DuplicatePayloadMismatch");
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM orchestrations").get() as { n: number }).n, 1);
  store.close();
});

test("reservation persists and rejects overspend", async () => {
  const store = setup();
  const { claim, strategy } = await prepared(store);
  store.saveRequest(claim, strategy);
  const first = reserve_sme_call(claim, { persona_id: strategy.personas[0].id, round_number: 1, estimated_cost: "0.75" }, strategy.budget, store);
  assert.equal(first.ok, true);
  const second = reserve_sme_call(claim, { persona_id: strategy.personas[1].id, round_number: 1, estimated_cost: "0.75" }, strategy.budget, store);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.kind, "CostLimitExceeded");
  store.close();
});

test("reservation requires a durable strategy and cohort persona", async () => {
  const store = setup();
  const { claim, strategy } = await prepared(store);
  const before = reserve_sme_call(claim, { persona_id: "not-in-cohort", round_number: 1, estimated_cost: "0.1" }, strategy.budget, store);
  assert.equal(before.ok, false);
  store.saveRequest(claim, strategy);
  const after = reserve_sme_call(claim, { persona_id: "not-in-cohort", round_number: 1, estimated_cost: "0.1" }, strategy.budget, store);
  assert.equal(after.ok, false);
  store.close();
});

test("FTS memory is bounded and scoped", async () => {
  const store = setup();
  const { claim, strategy } = await prepared(store);
  store.saveRequest(claim, strategy);
  const result = search_sme_memory({ text: "judgment", limit: 1000 }, { workflow_run_id: "run-1", authorized: true }, store);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.limit, 50);
  const tooLong = search_sme_memory({ text: "x".repeat(501) }, { workflow_run_id: "run-1", authorized: true }, store);
  assert.equal(tooLong.ok, false);
  store.close();
});

test("rounds require completed durable results and reject forged answers", async () => {
  const store = setup();
  const { claim, strategy } = await prepared(store);
  store.saveRequest(claim, strategy);
  const answers = await completeRoundCalls(store, claim, strategy);
  const forged = record_sme_round(claim.orchestration_id, { round_number: 1, answers: answers.map((answer) => ({ ...answer, answer: "forged" })) }, store);
  assert.equal(forged.ok, false);
  const recorded = record_sme_round(claim.orchestration_id, { round_number: 1, answers }, store);
  assert.equal(recorded.ok, true);
  const duplicate = record_sme_round(claim.orchestration_id, { round_number: 1, answers }, store);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.kind, "RoundAlreadyRecorded");
  const budget = store.budget(claim.orchestration_id, strategy.budget);
  if (recorded.ok) {
    const synthesized = synthesize_response(recorded.value, budget);
    assert.equal(synthesized.ok, true);
    if (synthesized.ok) assert.equal(synthesized.value.kind, "revise");
  }
  store.close();
});

test("orchestrate settles a final answer and replay does not call SMEs again", async () => {
  const store = setup();
  const { claim, strategy } = await prepared(store);
  let calls = 0;
  const runner = async (persona: { id: string }) => { calls += 1; return { answer: "same", reasoning: "evidence", sources: [{ url: `https://${persona.id}.example` }] }; };
  const result = await orchestrate_sme(claim, strategy, { store, call_sme: runner });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.kind, "continue");
  const before = calls;
  const replay = await orchestrate_sme(claim, strategy, { store, call_sme: async () => { throw new Error("must not run"); } });
  assert.deepEqual(replay, result);
  assert.equal(calls, before);
  store.close();
});

test("orchestrate refuses an unclaimed stage", async () => {
  const store = setup();
  const trusted = await sanitize_workflow_context(event().raw_context, { redactionPolicy: "strict", artifactFirst: true });
  assert.equal(trusted.ok, true);
  const strategy = prepare_sme_strategy(trusted.value, [], { budget: { max_rounds: 1, max_sme_calls: 1, max_cost: "1" }, sme_models: ["local"] });
  assert.equal(strategy.ok, true);
  const result = await orchestrate_sme({ orchestration_id: "missing", workflow_run_id: "run-1", stage_id: "stage-1", idempotency_key: "key", payload_hash: "hash" }, strategy.value, { store, call_sme: async () => ({ answer: "bad", reasoning: "bad" }) });
  assert.equal(result.ok, false);
  store.close();
});

test("governance returns redaction and keep-context plan", () => {
  const result = govern_workflow_context({ approved: true, fields: [
    { name: "token", classification: "secret" },
    { name: "acceptance", classification: "critical-constraint" },
    { name: "transcript", classification: "bulk-artifact" },
  ], policy: { redactionPolicy: "strict", artifactFirst: true } });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.redacted_fields, ["token"]);
    assert.deepEqual(result.value.keep_context, ["acceptance"]);
  }
});

test("pre-strategy inspection is durable and honest", () => {
  const store = setup();
  const claimed = claim_blocked_stage(event(), store);
  assert.equal(claimed.ok, true);
  if (claimed.ok) {
    const status = inspect_sme_orchestration(claimed.value.orchestration_id, { workflow_run_id: "run-1", authorized: true }, store);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.value.budget, undefined);
  }
  store.close();
});

test("scope authorization rejects caller assertions when verifier denies", () => {
  const store = new SMEStore(":memory:", () => false);
  const claimed = claim_blocked_stage(event(), store);
  assert.equal(claimed.ok, true);
  const search = search_sme_memory({ text: "judgment" }, { workflow_run_id: "run-1", authorized: true }, store);
  assert.equal(search.ok, false);
  store.close();
});

test("redaction handles common secret forms and preserves structural IDs", async () => {
  assert.equal(redactText("api_key=topsecret access_token=topsecret token=ABC").includes("topsecret"), false);
  const raw = event();
  raw.workflow_run_id = "123e4567-e89b-12d3-a456-426614174000";
  raw.raw_context.workflow_run_id = raw.workflow_run_id;
  const safe = await sanitize_workflow_context(raw.raw_context, { redactionPolicy: "strict", artifactFirst: true });
  assert.equal(safe.ok, true);
  if (safe.ok) assert.equal(safe.value.workflow_run_id, raw.workflow_run_id);
});

test("safe artifacts can be read after a process restart", () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "atomic-sme-artifacts-"));
  const ref = writeSafeArtifact({ answer: "safe", token: "secret" }, artifactDir, "peer", { redactionPolicy: "strict", artifactFirst: true, allowedArtifactReaders: ["sme-stage"] });
  const serialized = JSON.parse(readFileSync(ref.path, "utf8"));
  assert.equal(serialized.token, undefined);
  assert.equal(readSafeArtifact(ref, "sme-stage"), readFileSync(ref.path, "utf8"));
});

test("only retention authority can purge", async () => {
  const store = setup();
  const { claim, strategy } = await prepared(store);
  store.saveRequest(claim, strategy);
  const denied = purge_sme_memory({ subject: "workflow", role: "workflow", can_purge: false, policy_version: "v1" }, { orchestration_ids: [claim.orchestration_id] }, store);
  assert.equal(denied.ok, false);
  const receipt = purge_sme_memory({ subject: "retention", role: "retention-authority", can_purge: true, policy_version: "v1" }, { orchestration_ids: [claim.orchestration_id] }, store);
  assert.equal(receipt.ok, true);
  const inspect = inspect_sme_orchestration(claim.orchestration_id, { orchestration_ids: [claim.orchestration_id], authorized: true }, store);
  assert.equal(inspect.ok, false);
  store.close();
});
