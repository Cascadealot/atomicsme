import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getContextPolicy, getDatabasePath } from "./config.js";
import { isAirlockedWorkflowContext, markTrustedWorkflowContext, redactJson, redactText, rememberRawWorkflowContext, trustedContextClaimHashes } from "./context.js";
import { settlementToken } from "./internal.js";
import { isPreparedSMERequest, markPreparedSMERequest, markRecordedRound, markRemainingBudget } from "./runtime.js";
import type {
  AuditReadScope, ClaimedBlockedStage, ContextPolicy, DeliberationBudget, DeliberationRound, DeliveryStatus,
  Hash, JsonValue, MemoryReadScope, MemoryRetentionTarget, OrchestrationAudit, OrchestrationStatus,
  PreparedSMERequest, PurgeReceipt, RedactedAuditExport, RedactedAuditFilter, RecordedRound,
  RemainingDeliberationBudget, ReservationId, ReservedSMECall, Result, SafeSearchQuery,
  SMEAnswer, SMEBlockRescueRequested, SMECallResult, SMEDataRetentionAuthority, SMEPersona,
  SMEAuditExportAuthority, SMEAuthorityAction, SMEAuthoritySubject, SMEAuthorityVerifier, SMEMemoryPage, SMEQuestion, Source, WorkflowUnblockDecision,
} from "./types.js";

/**
 * The durable state for the package. Monetary values stay as canonical decimal
 * strings and are converted to micro-units only inside exact bigint arithmetic.
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;
CREATE TABLE IF NOT EXISTS orchestrations (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  decision_json JSON,
  audit_json JSON,
  budget_json JSON,
  orchestration_status TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  execution_owner TEXT,
  lease_until TEXT,
  execution_version INTEGER NOT NULL DEFAULT 0,
  delivery_owner TEXT,
  delivery_lease_until TEXT,
  spent_rounds INTEGER NOT NULL DEFAULT 0,
  spent_sme_calls INTEGER NOT NULL DEFAULT 0,
  reserved_cost TEXT NOT NULL DEFAULT '0',
  spent_cost TEXT NOT NULL DEFAULT '0',
  budget_status TEXT NOT NULL DEFAULT 'active',
  redaction_policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (workflow_run_id, stage_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  orchestration_id TEXT NOT NULL UNIQUE REFERENCES orchestrations(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  subject TEXT NOT NULL,
  question TEXT NOT NULL,
  context_json JSON NOT NULL,
  personas_json JSON NOT NULL,
  budget_json JSON NOT NULL,
  strategy_rationale TEXT NOT NULL,
  memory_scope TEXT NOT NULL,
  artifact_acl_json JSON NOT NULL,
  prepared_hash TEXT NOT NULL DEFAULT '',
  research_required INTEGER NOT NULL DEFAULT 0,
  current_question_json JSON,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sme_call_reservations (
  id TEXT PRIMARY KEY,
  orchestration_id TEXT NOT NULL REFERENCES orchestrations(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  estimated_cost TEXT NOT NULL,
  actual_cost TEXT,
  status TEXT NOT NULL,
  model TEXT,
  invocation_owner TEXT,
  invocation_lease_until TEXT,
  result_json JSON,
  created_at TEXT NOT NULL,
  UNIQUE (orchestration_id, persona_id, round_number)
);
CREATE TABLE IF NOT EXISTS sme_responses (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL,
  persona_json JSON NOT NULL,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  answer TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  sources_json JSON NOT NULL,
  feedback_notes TEXT,
  model TEXT,
  actual_cost TEXT,
  synthesis_hint TEXT,
  round_question_json JSON,
  created_at TEXT NOT NULL,
  UNIQUE (request_id, round_number, persona_id)
);
CREATE TABLE IF NOT EXISTS purge_receipts (
  id TEXT PRIMARY KEY,
  authority_subject TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  records_removed INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_tombstones (
  id TEXT PRIMARY KEY,
  purge_receipt_id TEXT NOT NULL REFERENCES purge_receipts(id),
  orchestration_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(
  topic, subject, question, strategy_rationale,
  content='requests', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS requests_ai AFTER INSERT ON requests BEGIN
  INSERT INTO requests_fts(rowid, topic, subject, question, strategy_rationale)
  VALUES (new.rowid, new.topic, new.subject, new.question, new.strategy_rationale);
END;
CREATE TRIGGER IF NOT EXISTS requests_au AFTER UPDATE ON requests BEGIN
  INSERT INTO requests_fts(requests_fts, rowid, topic, subject, question, strategy_rationale)
  VALUES ('delete', old.rowid, old.topic, old.subject, old.question, old.strategy_rationale);
  INSERT INTO requests_fts(rowid, topic, subject, question, strategy_rationale)
  VALUES (new.rowid, new.topic, new.subject, new.question, new.strategy_rationale);
END;
CREATE TRIGGER IF NOT EXISTS requests_ad AFTER DELETE ON requests BEGIN
  INSERT INTO requests_fts(requests_fts, rowid, topic, subject, question, strategy_rationale)
  VALUES ('delete', old.rowid, old.topic, old.subject, old.question, old.strategy_rationale);
END;
CREATE INDEX IF NOT EXISTS idx_orchestration_stage ON orchestrations(workflow_run_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_request_orchestration ON requests(orchestration_id);
CREATE INDEX IF NOT EXISTS idx_reservation_orchestration ON sme_call_reservations(orchestration_id);
CREATE INDEX IF NOT EXISTS idx_response_round ON sme_responses(request_id, round_number);
`;

type Row = Record<string, unknown>;
type DoorFailure = { kind: string; message: string; details?: unknown };
type ExecutionLease = "acquired" | "busy" | "settled";
type DeliveryLease = "acquired" | "busy" | "delivered";
type InvocationLease = "acquired" | "busy" | "completed" | "failed";

export class SMEStore {
  readonly db: DatabaseSync;
  private readonly authorityVerifier?: SMEAuthorityVerifier;

  constructor(path = getDatabasePath(), authorityVerifier?: SMEAuthorityVerifier) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.authorityVerifier = authorityVerifier;
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(SCHEMA_SQL);
    this.ensureColumns();
    try { this.db.exec("INSERT INTO requests_fts(requests_fts) VALUES ('rebuild')"); } catch { /* a fresh or legacy FTS table may already be consistent */ }
  }

  private ensureColumns(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(orchestrations)").all() as Row[]).map((row) => String(row.name)));
    const additions: Record<string, string> = {
      audit_json: "JSON",
      budget_json: "JSON",
      execution_owner: "TEXT",
      lease_until: "TEXT",
      execution_version: "INTEGER NOT NULL DEFAULT 0",
      delivery_owner: "TEXT",
      delivery_lease_until: "TEXT",
    };
    for (const [name, type] of Object.entries(additions)) if (!columns.has(name)) this.db.exec(`ALTER TABLE orchestrations ADD COLUMN ${name} ${type}`);

    const requestColumns = new Set((this.db.prepare("PRAGMA table_info(requests)").all() as Row[]).map((row) => String(row.name)));
    if (!requestColumns.has("memory_scope")) this.db.exec("ALTER TABLE requests ADD COLUMN memory_scope TEXT NOT NULL DEFAULT 'sme'");
    if (!requestColumns.has("prepared_hash")) this.db.exec("ALTER TABLE requests ADD COLUMN prepared_hash TEXT NOT NULL DEFAULT ''");
    if (!requestColumns.has("research_required")) this.db.exec("ALTER TABLE requests ADD COLUMN research_required INTEGER NOT NULL DEFAULT 0");
    if (!requestColumns.has("current_question_json")) this.db.exec("ALTER TABLE requests ADD COLUMN current_question_json JSON");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_one_per_orchestration ON requests(orchestration_id)");
    const reservationColumns = new Set((this.db.prepare("PRAGMA table_info(sme_call_reservations)").all() as Row[]).map((row) => String(row.name)));
    const reservationAdditions: Record<string, string> = {
      model: "TEXT",
      invocation_owner: "TEXT",
      invocation_lease_until: "TEXT",
      result_json: "JSON",
    };
    for (const [name, type] of Object.entries(reservationAdditions)) if (!reservationColumns.has(name)) this.db.exec(`ALTER TABLE sme_call_reservations ADD COLUMN ${name} ${type}`);
    const responseColumns = new Set((this.db.prepare("PRAGMA table_info(sme_responses)").all() as Row[]).map((row) => String(row.name)));
    if (!responseColumns.has("sources_json")) this.db.exec("ALTER TABLE sme_responses ADD COLUMN sources_json JSON NOT NULL DEFAULT '[]'");
    if (!responseColumns.has("feedback_notes")) this.db.exec("ALTER TABLE sme_responses ADD COLUMN feedback_notes TEXT");
    if (!responseColumns.has("model")) this.db.exec("ALTER TABLE sme_responses ADD COLUMN model TEXT");
    if (!responseColumns.has("actual_cost")) this.db.exec("ALTER TABLE sme_responses ADD COLUMN actual_cost TEXT");
    if (!responseColumns.has("synthesis_hint")) this.db.exec("ALTER TABLE sme_responses ADD COLUMN synthesis_hint TEXT");
    if (!responseColumns.has("round_question_json")) this.db.exec("ALTER TABLE sme_responses ADD COLUMN round_question_json JSON");
  }
  close(): void { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (cause) {
      try { this.db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw cause;
    }
  }


  claim(event: SMEBlockRescueRequested, redactionPolicyVersion = "strict-v1"): Result<ClaimedBlockedStage, DoorFailure> {
    if (!validRescueEvent(event)) return fail("InvalidRescueEvent", "rescue event is missing required fields");
    const payloadHash = hashPayload({
      workflow_run_id: event.workflow_run_id,
      stage_id: event.stage_id,
      idempotency_key: event.idempotency_key,
      raw_context: event.raw_context,
    });
    try {
      const result: Result<ClaimedBlockedStage, DoorFailure> = this.transaction((): Result<ClaimedBlockedStage, DoorFailure> => {
        const existing = this.db.prepare("SELECT id, workflow_run_id, stage_id, idempotency_key, payload_hash FROM orchestrations WHERE workflow_run_id = ? AND stage_id = ? AND idempotency_key = ?").get(event.workflow_run_id, event.stage_id, event.idempotency_key) as Row | undefined;
        if (existing) {
          if (String(existing.payload_hash) !== payloadHash) return fail("DuplicatePayloadMismatch", "idempotency key was reused with a different payload");
          return { ok: true, value: claimFromRow(existing) };
        }
        const id = randomUUID();
        this.db.prepare("INSERT INTO orchestrations (id, workflow_run_id, stage_id, idempotency_key, payload_hash, orchestration_status, redaction_policy_version, created_at) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?)").run(id, event.workflow_run_id, event.stage_id, event.idempotency_key, payloadHash, redactionPolicyVersion, now());
        return { ok: true, value: { orchestration_id: id, workflow_run_id: event.workflow_run_id, stage_id: event.stage_id, idempotency_key: event.idempotency_key, payload_hash: payloadHash } };
      });
      if (result.ok) rememberRawWorkflowContext(event.raw_context, result.value.payload_hash);
      return result;
    } catch (cause) {
      return fail("ClaimUnavailable", message(cause));
    }
  }

  getClaim(orchestrationId: string): ClaimedBlockedStage | undefined {
    const row = this.db.prepare("SELECT id, workflow_run_id, stage_id, idempotency_key, payload_hash FROM orchestrations WHERE id = ?").get(orchestrationId) as Row | undefined;
    return row ? claimFromRow(row) : undefined;
  }

  getOrchestrationRow(orchestrationId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM orchestrations WHERE id = ?").get(orchestrationId) as Row | undefined;
  }

  acquireExecution(claim: ClaimedBlockedStage, owner: string, leaseMs = 60_000): ExecutionLease {
    return this.transaction(() => {
      const row = this.getOrchestrationRow(claim.orchestration_id);
      if (!row || !sameClaim(claim, claimFromRow(row))) return "busy";
      if (row.decision_json) return "settled";
      const currentOwner = row.execution_owner == null ? "" : String(row.execution_owner);
      const leaseUntil = row.lease_until == null ? 0 : Date.parse(String(row.lease_until));
      if (currentOwner && currentOwner !== owner && leaseUntil > Date.now()) return "busy";
      const result = this.db.prepare(
        "UPDATE orchestrations SET execution_owner = ?, lease_until = ?, execution_version = execution_version + 1, orchestration_status = 'running' WHERE id = ? AND decision_json IS NULL",
      ).run(owner, new Date(Date.now() + leaseMs).toISOString(), claim.orchestration_id);
      return result.changes === 0 ? "busy" : "acquired";
    });
  }

  renewExecution(orchestrationId: string, owner: string, leaseMs = 60_000): boolean {
    const result = this.db.prepare("UPDATE orchestrations SET lease_until = ? WHERE id = ? AND execution_owner = ? AND decision_json IS NULL").run(new Date(Date.now() + leaseMs).toISOString(), orchestrationId, owner);
    return result.changes > 0;
  }

  releaseExecution(orchestrationId: string, owner: string): void {
    this.db.prepare("UPDATE orchestrations SET execution_owner = NULL, lease_until = NULL WHERE id = ? AND execution_owner = ?").run(orchestrationId, owner);
  }

  waitForDecision(orchestrationId: string, timeoutMs = 65_000): WorkflowUnblockDecision | undefined {
    const end = Date.now() + timeoutMs;
    do {
      const decision = this.getDecision(orchestrationId);
      if (decision) return decision;
      sleep(25);
    } while (Date.now() < end);
    return undefined;
  }
  saveRequest(claim: ClaimedBlockedStage, prepared: PreparedSMERequest): string {
    assertTrustedPrepared(prepared);
    if (!isPreparedSMERequest(prepared)) throw new Error("prepared request is not strategy-authenticated");
    if (!isAirlockedWorkflowContext(prepared.question.context) || !trustedContextClaimHashes(prepared.question.context).has(claim.payload_hash)) throw new Error("prepared context is not airlock-authenticated for this claim");
    validateBudget(prepared.budget);
    const policy = getContextPolicy();
    const canonical = canonicalPrepared(prepared, policy);
    const preparedHash = hashPayload(canonical);
    return this.transaction(() => {
      const row = this.getOrchestrationRow(claim.orchestration_id);
      if (!row || !sameClaim(claim, claimFromRow(row))) throw new Error("claim is not durable");
      const existing = this.db.prepare("SELECT id, prepared_hash FROM requests WHERE orchestration_id = ?").get(claim.orchestration_id) as Row | undefined;
      if (existing) {
        if (existing.prepared_hash && String(existing.prepared_hash) !== preparedHash) throw new Error("prepared request does not match the canonical request");
        return String(existing.id);
      }
      const priorReservations = Number((this.db.prepare("SELECT COUNT(*) AS count FROM sme_call_reservations WHERE orchestration_id = ?").get(claim.orchestration_id) as Row).count);
      if (priorReservations > 0) throw new Error("cannot save a strategy after call reservations exist");
      const id = randomUUID();
      const createdAt = now();
      const safeContext = canonical.question.context;
      const safePersonas = canonical.personas;
      const safeArtifacts = safeContext.safe_artifacts.map((artifact) => ({
        path: artifact.path,
        ...(artifact.label == null ? {} : { label: artifact.label }),
        ...(artifact.media_type == null ? {} : { media_type: artifact.media_type }),
        ...(artifact.bytes == null ? {} : { bytes: artifact.bytes }),
        ...(artifact.source_stage == null ? {} : { source_stage: artifact.source_stage }),
        ...(artifact.redaction_policy_version == null ? {} : { redaction_policy_version: artifact.redaction_policy_version }),
        ...(artifact.allowed_readers == null ? {} : { allowed_readers: artifact.allowed_readers }),
        ...(artifact.artifact_root == null ? {} : { artifact_root: artifact.artifact_root }),
      }));
      this.db.prepare(
        "INSERT INTO requests (id, orchestration_id, topic, subject, question, context_json, personas_json, budget_json, strategy_rationale, memory_scope, artifact_acl_json, prepared_hash, research_required, current_question_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        claim.orchestration_id,
        canonical.question.topic,
        canonical.question.subject,
        canonical.question.question,
        json(safeContext),
        json(safePersonas),
        json(canonical.budget),
        canonical.rationale,
        "sme",
        json(safeArtifacts),
        preparedHash,
        canonical.research_required ? 1 : 0,
        json(canonical.question),
        createdAt,
      );
      this.db.prepare("UPDATE orchestrations SET orchestration_status = 'prepared', budget_json = ? WHERE id = ?").run(json(canonical.budget), claim.orchestration_id);
      return id;
    });
  }
  getRequestId(orchestrationId: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM requests WHERE orchestration_id = ?").get(orchestrationId) as Row | undefined;
    return row ? String(row.id) : undefined;
  }
  getPrepared(orchestrationId: string): PreparedSMERequest | undefined {
    const row = this.db.prepare("SELECT * FROM requests WHERE orchestration_id = ?").get(orchestrationId) as Row | undefined;
    if (!row) return undefined;
    const claim = this.getClaim(orchestrationId);
    if (!claim) return undefined;
    const context = parse<import("./types.js").TrustedWorkflowBlockContext>(row.context_json);
    const prepared = {
      question: {
        topic: String(row.topic),
        subject: String(row.subject),
        question: String(row.question),
        context: markTrustedWorkflowContext(context, [claim.payload_hash]),
      },
      personas: parse(row.personas_json),
      budget: parse(row.budget_json),
      rationale: String(row.strategy_rationale),
      research_required: Number(row.research_required ?? 0) === 1,
    } as PreparedSMERequest;
    return markPreparedSMERequest(prepared);
  }
  preparedMatches(orchestrationId: string, prepared: PreparedSMERequest): boolean {
    const row = this.db.prepare("SELECT prepared_hash FROM requests WHERE orchestration_id = ?").get(orchestrationId) as Row | undefined;
    if (!row || !row.prepared_hash) return false;
    try { return String(row.prepared_hash) === hashPayload(canonicalPrepared(prepared, getContextPolicy())); } catch { return false; }
  }
  reserve(
    claim: ClaimedBlockedStage,
    reservation: { persona_id: string; round_number: number; estimated_cost: string; model?: string },
    budget?: DeliberationBudget,
  ): Result<ReservedSMECall, DoorFailure> {
    if (!claim || !this.getClaim(claim.orchestration_id)) return fail("BudgetStateInvalid", "claim is not durable");
    if (!nonEmptyString(reservation?.persona_id) || !Number.isInteger(reservation.round_number) || reservation.round_number <= 0) return fail("BudgetStateInvalid", "reservation is invalid");
    try {
      return this.transaction(() => {
        const row = this.getOrchestrationRow(claim.orchestration_id);
        if (!row || !sameClaim(claim, claimFromRow(row)) || row.decision_json) return fail("BudgetStateInvalid", "orchestration is absent, mismatched, or settled");
        const request = this.db.prepare("SELECT personas_json, budget_json FROM requests WHERE orchestration_id = ?").get(claim.orchestration_id) as Row | undefined;
        if (!request || !request.budget_json) return fail("BudgetStateInvalid", "a durable strategy request is required before reserving a call");
        const canonicalBudget = parse<DeliberationBudget>(request.budget_json);
        validateBudget(canonicalBudget);
        const personas = parse<SMEPersona[]>(request.personas_json);
        const persona = personas.find((candidate) => candidate.id === reservation.persona_id);
        if (!persona) return fail("BudgetStateInvalid", "reservation persona is outside the durable cohort");
        const estimate = parseMoney(reservation.estimated_cost);
        const existing = this.db.prepare("SELECT * FROM sme_call_reservations WHERE orchestration_id = ? AND persona_id = ? AND round_number = ?").get(claim.orchestration_id, reservation.persona_id, reservation.round_number) as Row | undefined;
        if (budget && hashPayload(canonicalBudget) !== hashPayload(budget)) return fail("BudgetStateInvalid", "budget does not match the durable strategy budget");
        if (existing) {
          const existingModel = existing.model == null ? null : String(existing.model);
          const requestedModel = reservation.model ?? persona.preferred_model ?? null;
          if (String(existing.estimated_cost) !== canonicalMoney(estimate) || requestedModel !== existingModel) return fail("BudgetStateInvalid", "reservation key was reused with different details");
          return { ok: true, value: reservedFromRow(existing) };
        }
        if (reservation.round_number > canonicalBudget.max_rounds || Number(row.spent_rounds ?? 0) >= canonicalBudget.max_rounds) return fail("BudgetStateInvalid", "reservation is outside the declared round budget");
        if (reservation.round_number !== Number(row.spent_rounds ?? 0) + 1) return fail("BudgetStateInvalid", "calls must be reserved for the next deliberation round");
        const allocated = Number((this.db.prepare("SELECT COUNT(*) AS count FROM sme_call_reservations WHERE orchestration_id = ?").get(claim.orchestration_id) as Row).count);
        const reserved = parseMoney(String(row.reserved_cost ?? "0"));
        const spent = parseMoney(String(row.spent_cost ?? "0"));
        const maxCost = parseMoney(canonicalBudget.max_cost);
        if (allocated >= canonicalBudget.max_sme_calls) return fail("CallsExhausted", "SME call budget is exhausted");
        if (reserved + spent >= maxCost || reserved + spent + estimate > maxCost) return fail("CostLimitExceeded", "SME cost budget is exhausted");
        const id = randomUUID();
        const nextReserved = reserved + estimate;
        const nextCalls = allocated + 1;
        const exhausted = nextCalls >= canonicalBudget.max_sme_calls || nextReserved + spent >= maxCost;
        const model = reservation.model ?? persona.preferred_model ?? null;
        this.db.prepare("INSERT INTO sme_call_reservations (id, orchestration_id, persona_id, round_number, estimated_cost, status, model, created_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)").run(id, claim.orchestration_id, reservation.persona_id, reservation.round_number, canonicalMoney(estimate), model, now());
        this.db.prepare("UPDATE orchestrations SET reserved_cost = ?, spent_sme_calls = ?, budget_status = ? WHERE id = ?").run(canonicalMoney(nextReserved), nextCalls, exhausted ? "exhausted" : "active", claim.orchestration_id);
        return { ok: true, value: { persona_id: reservation.persona_id, round_number: reservation.round_number, estimated_cost: canonicalMoney(estimate), ...(model == null ? {} : { model }), reservation_id: id } };
      });
    } catch (cause) {
      return fail("BudgetStateInvalid", message(cause));
    }
  }
  claimReservation(reservationId: ReservationId, owner: string, leaseMs = 60_000): InvocationLease {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM sme_call_reservations WHERE id = ?").get(reservationId) as Row | undefined;
      if (!row) return "failed";
      if (row.result_json != null) return isFailedResult(row.result_json) ? "failed" : "completed";
      const current = row.invocation_owner == null ? "" : String(row.invocation_owner);
      const until = row.invocation_lease_until == null ? 0 : Date.parse(String(row.invocation_lease_until));
      if (current && current !== owner && until > Date.now()) return "busy";
      const changed = this.db.prepare("UPDATE sme_call_reservations SET invocation_owner = ?, invocation_lease_until = ?, status = 'invoking' WHERE id = ? AND result_json IS NULL").run(owner, new Date(Date.now() + leaseMs).toISOString(), reservationId);
      return changed.changes === 0 ? "busy" : "acquired";
    });
  }
  getReservationResult(reservationId: ReservationId): SMECallResult | undefined {
    const row = this.db.prepare("SELECT result_json FROM sme_call_reservations WHERE id = ?").get(reservationId) as Row | undefined;
    if (!row?.result_json || isFailedResult(row.result_json)) return undefined;
    return parse<SMECallResult>(row.result_json);
  }
  getReservationFailure(reservationId: ReservationId): string | undefined {
    const row = this.db.prepare("SELECT result_json FROM sme_call_reservations WHERE id = ?").get(reservationId) as Row | undefined;
    if (!row?.result_json) return undefined;
    const result = parse<Record<string, unknown>>(row.result_json);
    return result.failed ? String(result.error ?? "SME call failed") : undefined;
  }
  /** Complete a reservation after its invocation lease is held, or complete a low-level reserved fixture. */
  completeReservation(reservationId: ReservationId, resultOrCost?: SMECallResult | string, status: "completed" | "failed" = "completed", failureReason?: string, invocationOwner?: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM sme_call_reservations WHERE id = ?").get(reservationId) as Row | undefined;
      if (!row) throw new Error("reservation not found");
      if (row.result_json != null) return;
      if (status !== "completed" && status !== "failed") throw new Error("reservation status is invalid");
      if (invocationOwner && (String(row.invocation_owner ?? "") !== invocationOwner || String(row.status) !== "invoking")) throw new Error("reservation invocation lease is not held");
      if (!invocationOwner && String(row.status) === "invoking" && row.invocation_owner != null) throw new Error("reservation invocation lease is not held");
      const estimated = parseMoney(String(row.estimated_cost));
      const rawResult = typeof resultOrCost === "object" && resultOrCost !== null ? resultOrCost : undefined;
      const orchestrationId = String(row.orchestration_id);
      const orchestration = this.getOrchestrationRow(orchestrationId);
      if (!orchestration || orchestration.decision_json != null) throw new Error("orchestration is absent or settled");
      const budget = orchestration.budget_json ? parse<DeliberationBudget>(orchestration.budget_json) : undefined;
      if (!budget) throw new Error("durable strategy budget is unavailable");
      validateBudget(budget);
      const actual = parseMoney(typeof resultOrCost === "string" ? resultOrCost : rawResult?.actual_cost ?? String(row.estimated_cost));
      const reserved = parseMoney(String(orchestration.reserved_cost ?? "0"));
      const spent = parseMoney(String(orchestration.spent_cost ?? "0"));
      const nextReserved = reserved >= estimated ? reserved - estimated : 0n;
      const nextSpent = spent + actual;
      if (nextReserved + nextSpent > parseMoney(budget.max_cost)) throw new Error("actual cost exceeds durable cost budget");
      const allocated = Number((this.db.prepare("SELECT COUNT(*) AS count FROM sme_call_reservations WHERE orchestration_id = ?").get(orchestrationId) as Row).count);
      const exhausted = allocated >= budget.max_sme_calls || nextReserved + nextSpent >= parseMoney(budget.max_cost);
      const storedResult = status === "failed" ? { failed: true, error: redactText(failureReason ?? "SME call failed") } : rawResult ? redactCallResult({ ...rawResult, actual_cost: canonicalMoney(actual), model: rawResult.model ?? (row.model == null ? undefined : String(row.model)) }) : undefined;
      this.db.prepare("UPDATE sme_call_reservations SET actual_cost = ?, status = ?, invocation_owner = NULL, invocation_lease_until = NULL, result_json = ? WHERE id = ? AND result_json IS NULL").run(canonicalMoney(actual), status, storedResult == null ? null : json(storedResult), reservationId);
      this.db.prepare("UPDATE orchestrations SET reserved_cost = ?, spent_cost = ?, budget_status = ? WHERE id = ? AND decision_json IS NULL").run(canonicalMoney(nextReserved), canonicalMoney(nextSpent), exhausted ? "exhausted" : "active", orchestrationId);
    });
  }
  recordRound(orchestrationId: string, round: DeliberationRound): Result<RecordedRound, DoorFailure> {
    try {
      return this.transaction(() => {
        const orchestration = this.getOrchestrationRow(orchestrationId);
        if (!orchestration || orchestration.decision_json != null) return fail("SchemaMismatch", "orchestration is absent or already settled");
        const request = this.db.prepare("SELECT id, personas_json, budget_json, research_required FROM requests WHERE orchestration_id = ?").get(orchestrationId) as Row | undefined;
        if (!request) return fail("SchemaMismatch", "strategy request is absent");
        const requestId = String(request.id);
        const budget = parse<DeliberationBudget>(request.budget_json);
        validateBudget(budget);
        if (!Number.isInteger(round?.round_number) || round.round_number <= 0 || round.round_number > budget.max_rounds || !Array.isArray(round.answers) || round.answers.length === 0) return fail("SchemaMismatch", "round is incomplete or outside the budget");
        if (this.db.prepare("SELECT 1 FROM sme_responses WHERE request_id = ? AND round_number = ? LIMIT 1").get(requestId, round.round_number)) return fail("RoundAlreadyRecorded", "deliberation round is already recorded");
        const priorRounds = Number((this.db.prepare("SELECT COUNT(DISTINCT round_number) AS count FROM sme_responses WHERE request_id = ?").get(requestId) as Row).count);
        if (round.round_number !== priorRounds + 1) return fail("SchemaMismatch", "round is not the next durable round");
        const personas = parse<SMEPersona[]>(request.personas_json);
        const reservations = this.db.prepare("SELECT persona_id, status, result_json FROM sme_call_reservations WHERE orchestration_id = ? AND round_number = ?").all(orchestrationId, round.round_number) as Row[];
        if (reservations.length !== personas.length) return fail("SchemaMismatch", "round does not cover the complete persona cohort");
        const reservationByPersona = new Map(reservations.map((reservation) => [String(reservation.persona_id), reservation]));
        if (personas.some((persona) => !reservationByPersona.has(persona.id))) return fail("SchemaMismatch", "round is missing a cohort reservation");
        if (reservations.some((reservation) => !["completed", "failed"].includes(String(reservation.status)))) return fail("SchemaMismatch", "round has an outstanding durable reservation");
        const completedIds = new Set(reservations.filter((reservation) => String(reservation.status) === "completed" && reservation.result_json && !isFailedResult(reservation.result_json)).map((reservation) => String(reservation.persona_id)));
        if (round.answers.length !== completedIds.size || round.answers.some((answer) => !completedIds.has(answer.persona_id))) return fail("SchemaMismatch", "round answers do not cover all completed durable calls");
        const ids = new Set<string>();
        const recordedAnswers: SMEAnswer[] = [];
        if (round.answers.length > personas.length) return fail("SchemaMismatch", "round contains too many persona answers");
        const recordedAt = now();
        for (const answer of round.answers) {
          if (ids.has(answer.persona_id)) return fail("SchemaMismatch", "round contains duplicate persona answers");
          ids.add(answer.persona_id);
          const persona = personas.find((candidate) => candidate.id === answer.persona_id);
          if (!persona || !validAnswer(answer)) return fail("SchemaMismatch", "round answer is incomplete or outside the cohort");
          const reservation = this.db.prepare("SELECT status, result_json FROM sme_call_reservations WHERE orchestration_id = ? AND persona_id = ? AND round_number = ?").get(orchestrationId, answer.persona_id, round.round_number) as Row | undefined;
          if (!reservation || String(reservation.status) !== "completed" || !reservation.result_json || isFailedResult(reservation.result_json)) return fail("SchemaMismatch", "round answer has no completed durable reservation");
          const durable = redactCallResult(parse<SMECallResult>(reservation.result_json));
          if (Number(request.research_required ?? 0) === 1 && (!durable.sources || durable.sources.length === 0)) return fail("SchemaMismatch", "research-required round has no durable sources");
          const supplied = redactAnswer(answer);
          const expected: SMEAnswer = { persona_id: answer.persona_id, answer: durable.answer, reasoning: durable.reasoning, sources: durable.sources ?? [], ...(durable.feedback_notes == null ? {} : { feedback_notes: durable.feedback_notes }), ...(durable.model == null ? {} : { model: durable.model }), ...(durable.actual_cost == null ? {} : { actual_cost: durable.actual_cost }) };
          if (supplied.answer !== expected.answer || supplied.reasoning !== expected.reasoning || hashPayload(supplied.sources) !== hashPayload(expected.sources) || (supplied.feedback_notes ?? undefined) !== (expected.feedback_notes ?? undefined) || (supplied.model != null && supplied.model !== expected.model) || (supplied.actual_cost != null && supplied.actual_cost !== expected.actual_cost)) return fail("SchemaMismatch", "round answer does not match the durable SME result");
          const storedPersona = redactPersona(persona);
          const canonicalAnswer = expected;
          recordedAnswers.push(canonicalAnswer);
          this.db.prepare("INSERT INTO sme_responses (id, request_id, persona_id, persona_json, round_number, answer, reasoning, sources_json, feedback_notes, model, actual_cost, synthesis_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), requestId, answer.persona_id, json(storedPersona), round.round_number, canonicalAnswer.answer, canonicalAnswer.reasoning, json(canonicalAnswer.sources), canonicalAnswer.feedback_notes ?? null, canonicalAnswer.model ?? storedPersona.preferred_model ?? null, canonicalAnswer.actual_cost ?? null, round.synthesis_hint ?? null, recordedAt);
        }
        const updated = this.db.prepare("UPDATE orchestrations SET spent_rounds = ?, orchestration_status = 'round-recorded' WHERE id = ? AND decision_json IS NULL").run(round.round_number, orchestrationId);
        if (updated.changes !== 1) return fail("SchemaMismatch", "orchestration settled while recording the round");
        const question = this.getPrepared(orchestrationId)?.question;
        return { ok: true, value: markRecordedRound({ round_number: round.round_number, answers: recordedAnswers, ...(round.synthesis_hint == null ? {} : { synthesis_hint: round.synthesis_hint }), orchestration_id: orchestrationId, request_id: requestId, recorded_at: recordedAt }, question) };
      });
    } catch (cause) {
      return fail("DatabaseUnavailable", message(cause));
    }
  }
  getRound(orchestrationId: string, roundNumber: number): RecordedRound | undefined {
    const request = this.db.prepare("SELECT id FROM requests WHERE orchestration_id = ?").get(orchestrationId) as Row | undefined;
    if (!request) return undefined;
    const requestId = String(request.id);
    const rows = this.db.prepare("SELECT * FROM sme_responses WHERE request_id = ? AND round_number = ? ORDER BY rowid").all(requestId, roundNumber) as Row[];
    if (!rows.length) return undefined;
    const question = this.getPrepared(orchestrationId)?.question;
    return markRecordedRound({
      round_number: roundNumber,
      answers: rows.map((row) => ({
        persona_id: String(row.persona_id),
        answer: String(row.answer),
        reasoning: String(row.reasoning),
        sources: parse(row.sources_json),
        ...(row.feedback_notes == null ? {} : { feedback_notes: String(row.feedback_notes) }),
        ...(row.model == null ? {} : { model: String(row.model) }),
        ...(row.actual_cost == null ? {} : { actual_cost: String(row.actual_cost) }),
      })),
      ...(rows[0].synthesis_hint == null ? {} : { synthesis_hint: String(rows[0].synthesis_hint) }),
      orchestration_id: orchestrationId,
      request_id: requestId,
      recorded_at: String(rows[0].created_at),
    }, question);
  }

  listRounds(orchestrationId: string): RecordedRound[] {
    const rows = this.db.prepare("SELECT DISTINCT round_number FROM sme_responses JOIN requests ON requests.id = sme_responses.request_id WHERE requests.orchestration_id = ? ORDER BY round_number").all(orchestrationId) as Row[];
    return rows.map((row) => this.getRound(orchestrationId, Number(row.round_number))).filter((round): round is RecordedRound => Boolean(round));
  }

  settleAndPersist(orchestrationId: string, decision: WorkflowUnblockDecision, audit: OrchestrationAudit, owner: string, token?: typeof settlementToken): Result<WorkflowUnblockDecision, DoorFailure> {
    if (token !== settlementToken) return fail("DatabaseUnavailable", "settlement is package-internal");
    try {
      const safeDecision = redactDecision(decision);
      validateDecision(safeDecision);
      return this.transaction(() => {
        const row = this.getOrchestrationRow(orchestrationId);
        if (!row) return fail("DatabaseUnavailable", "orchestration not found");
        if (!owner || String(row.execution_owner ?? "") !== owner) return fail("DatabaseUnavailable", "orchestration execution lease is not held");
        if (!audit || audit.orchestration_id !== orchestrationId || !sameClaim(audit.claim, claimFromRow(row))) return fail("DatabaseUnavailable", "audit claim does not match orchestration");
        if (hashPayload(redactDecision(audit.decision)) !== hashPayload(safeDecision)) return fail("DatabaseUnavailable", "audit decision does not match settlement");
        const durableRounds = this.listRounds(orchestrationId);
        if (hashPayload(durableRounds) !== hashPayload(audit.rounds)) return fail("DatabaseUnavailable", "audit rounds do not match durable rounds");
        const request = this.db.prepare("SELECT prepared_hash FROM requests WHERE orchestration_id = ?").get(orchestrationId) as Row | undefined;
        if (!request || !audit.prepared || String(request.prepared_hash) !== hashPayload(canonicalPrepared(audit.prepared, getContextPolicy()))) return fail("DatabaseUnavailable", "audit prepared request does not match the canonical request");
        const existing = row.decision_json ? redactDecision(parse(row.decision_json)) : undefined;
        if (existing && hashPayload(existing) !== hashPayload(safeDecision)) return fail("DatabaseUnavailable", "orchestration already has a different decision");
        const settled = existing ?? safeDecision;
        const safeAudit = redactJson(audit as unknown as JsonValue, getContextPolicy());
        if (!existing) {
          this.db.prepare("UPDATE orchestrations SET decision_json = ?, audit_json = ?, orchestration_status = 'settled', settled_at = ?, execution_owner = NULL, lease_until = NULL WHERE id = ? AND decision_json IS NULL").run(json(settled), json(safeAudit), now(), orchestrationId);
        } else if (row.audit_json == null) {
          this.db.prepare("UPDATE orchestrations SET audit_json = ? WHERE id = ? AND decision_json IS NOT NULL").run(json(safeAudit), orchestrationId);
        }
        return { ok: true, value: settled };
      });
    } catch (cause) {
      return fail("DatabaseUnavailable", message(cause));
    }
  }

  getDecision(orchestrationId: string): WorkflowUnblockDecision | undefined {
    const row = this.getOrchestrationRow(orchestrationId);
    return row?.decision_json ? redactDecision(parse(row.decision_json)) : undefined;
  }

  hasDurableAudit(orchestrationId: string): boolean {
    const row = this.getOrchestrationRow(orchestrationId);
    return Boolean(row?.decision_json && row.audit_json);
  }



  claimDelivery(orchestrationId: string, owner: string, leaseMs = 60_000): DeliveryLease {
    return this.transaction(() => {
      const row = this.getOrchestrationRow(orchestrationId);
      if (!row?.decision_json) return "busy";
      if (row.delivery_status === "delivered") return "delivered";
      const current = row.delivery_owner == null ? "" : String(row.delivery_owner);
      const until = row.delivery_lease_until == null ? 0 : Date.parse(String(row.delivery_lease_until));
      if (current && current !== owner && until > Date.now()) return "busy";
      const changed = this.db.prepare(
        "UPDATE orchestrations SET delivery_owner = ?, delivery_lease_until = ? WHERE id = ? AND decision_json IS NOT NULL",
      ).run(owner, new Date(Date.now() + leaseMs).toISOString(), orchestrationId);
      return changed.changes === 0 ? "busy" : "acquired";
    });
  }

  setDeliveryStatus(orchestrationId: string, status: DeliveryStatus, owner?: string): void {
    if (owner) {
      this.db.prepare("UPDATE orchestrations SET delivery_status = ?, delivery_owner = NULL, delivery_lease_until = NULL WHERE id = ? AND delivery_owner = ?").run(status, orchestrationId, owner);
    } else {
      this.db.prepare("UPDATE orchestrations SET delivery_status = ? WHERE id = ?").run(status, orchestrationId);
    }
  }

  budget(orchestrationId: string, budget: DeliberationBudget): RemainingDeliberationBudget {
    const row = this.getOrchestrationRow(orchestrationId);
    if (!row) throw new Error("orchestration not found");
    const canonicalBudget = row.budget_json ? parse<DeliberationBudget>(row.budget_json) : budget;
    validateBudget(canonicalBudget);
    if (row.budget_json && hashPayload(canonicalBudget) !== hashPayload(budget)) throw new Error("budget does not match the durable strategy budget");
    const spentRounds = Number(row.spent_rounds ?? 0);
    const spentCalls = Number(row.spent_sme_calls ?? 0);
    const reserved = parseMoney(String(row.reserved_cost ?? "0"));
    const spent = parseMoney(String(row.spent_cost ?? "0"));
    const exhausted = spentRounds >= canonicalBudget.max_rounds || spentCalls >= canonicalBudget.max_sme_calls || reserved + spent >= parseMoney(canonicalBudget.max_cost);
    return markRemainingBudget({ budget: canonicalBudget, spent_rounds: spentRounds, spent_sme_calls: spentCalls, reserved_cost: canonicalMoney(reserved), spent_cost: canonicalMoney(spent), status: exhausted ? "exhausted" : "active" }, orchestrationId);
  }
  search(query: SafeSearchQuery, scope: MemoryReadScope, maxPageSize = 50, maxQueryLength = 500): Result<SMEMemoryPage, DoorFailure> {
    if (scope?.authorized === false || !scope || !this.authorized("memory-read", scope) || (!scope.workflow_run_id && !scope.orchestration_ids?.length && !scope.subjects?.length)) return fail("Unauthorized", "an explicit authorized memory scope is required");
    if (!query || typeof query.text !== "string" || !query.text.trim() || query.text.length > maxQueryLength) return fail("QueryInvalid", "query is empty or too long");
    const rawLimit = query.limit ?? 20;
    const rawOffset = query.offset ?? 0;
    if (!Number.isFinite(rawLimit) || !Number.isFinite(rawOffset) || rawLimit < 0 || rawOffset < 0) return fail("QueryInvalid", "query paging values are invalid");
    const limit = Math.min(Math.max(Math.trunc(rawLimit), 1), maxPageSize);
    const offset = Math.max(Math.trunc(rawOffset), 0);
    try {
      const clauses = ["requests_fts MATCH ?", "r.memory_scope = 'sme'"];
      const params: (string | number)[] = [query.text];
      if (scope.workflow_run_id) { clauses.push("o.workflow_run_id = ?"); params.push(scope.workflow_run_id); }
      if (scope.orchestration_ids?.length) { clauses.push(`o.id IN (${scope.orchestration_ids.map(() => "?").join(",")})`); params.push(...scope.orchestration_ids); }
      if (scope.subjects?.length) { clauses.push(`r.subject IN (${scope.subjects.map(() => "?").join(",")})`); params.push(...scope.subjects); }
      const where = clauses.join(" AND ");
      const count = this.db.prepare(`SELECT COUNT(*) AS count FROM requests_fts JOIN requests r ON r.rowid = requests_fts.rowid JOIN orchestrations o ON o.id = r.orchestration_id WHERE ${where}`).get(...params) as Row;
      const rows = this.db.prepare(`SELECT r.id AS request_id, o.id AS orchestration_id, r.topic, r.subject, r.question, r.strategy_rationale, r.created_at FROM requests_fts JOIN requests r ON r.rowid = requests_fts.rowid JOIN orchestrations o ON o.id = r.orchestration_id WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
      const matches = rows.map((row) => {
        const match: { request_id: string; orchestration_id: string; topic: string; subject: string; question: string; strategy_rationale: string; created_at: string; rounds?: RecordedRound[] } = {
          request_id: String(row.request_id), orchestration_id: String(row.orchestration_id), topic: String(row.topic), subject: String(row.subject), question: String(row.question), strategy_rationale: String(row.strategy_rationale), created_at: String(row.created_at),
        };
        if (scope.include_sources) match.rounds = this.listRounds(String(row.orchestration_id));
        return match;
      });
      return { ok: true, value: { matches, total: Number(count.count), limit, offset } };
    } catch (cause) {
      return fail("QueryInvalid", message(cause));
    }
  }

  inspect(orchestrationId: string, scope: AuditReadScope): Result<OrchestrationStatus, DoorFailure> {
    if (scope?.authorized === false || !scope || !this.authorized("audit-read", scope) || (!scope.workflow_run_id && !scope.orchestration_ids?.length)) return fail("Unauthorized", "an explicit authorized audit scope is required");
    const row = this.getOrchestrationRow(orchestrationId);
    if (!row) return fail("NotFound", "orchestration not found");
    if ((scope.orchestration_ids && !scope.orchestration_ids.includes(orchestrationId)) || (scope.workflow_run_id && scope.workflow_run_id !== String(row.workflow_run_id))) return fail("Unauthorized", "audit scope is not authorized");
    try {
      return { ok: true, value: this.statusFromRow(row) };
    } catch (cause) {
      return fail("InspectionUnavailable", message(cause));
    }
  }

  persistDecision(decision: WorkflowUnblockDecision, audit: OrchestrationAudit): Result<{ orchestration_id: string; persisted: true }, DoorFailure> {
    try {
      const row = this.getOrchestrationRow(audit.orchestration_id);
      if (!row) return fail("DatabaseUnavailable", "orchestration not found");
      if (!sameClaim(audit.claim, claimFromRow(row))) return fail("DatabaseUnavailable", "audit claim does not match orchestration");
      const canonical = this.getDecision(audit.orchestration_id);
      if (!canonical) return fail("DatabaseUnavailable", "decision must be settled before persistence");
      if (hashPayload(canonical) !== hashPayload(redactDecision(decision))) return fail("DatabaseUnavailable", "canonical decision differs from requested decision");
      if (hashPayload(canonical) !== hashPayload(redactDecision(audit.decision))) return fail("DatabaseUnavailable", "audit decision does not match canonical decision");
      const durableRounds = this.listRounds(audit.orchestration_id);
      if (hashPayload(durableRounds) !== hashPayload(audit.rounds)) return fail("DatabaseUnavailable", "audit rounds do not match durable rounds");
      const request = this.db.prepare("SELECT prepared_hash FROM requests WHERE orchestration_id = ?").get(audit.orchestration_id) as Row | undefined;
      if (!request || !audit.prepared || String(request.prepared_hash) !== hashPayload(canonicalPrepared(audit.prepared, getContextPolicy()))) return fail("DatabaseUnavailable", "audit prepared request does not match the canonical request");
      const safeAudit = redactJson(audit as unknown as JsonValue, getContextPolicy());
      if (row.audit_json != null && hashPayload(parse(row.audit_json)) !== hashPayload(safeAudit)) return fail("DatabaseUnavailable", "settled audit is immutable");
      this.transaction(() => {
        this.db.prepare("UPDATE orchestrations SET audit_json = ? WHERE id = ? AND decision_json IS NOT NULL AND (audit_json IS NULL OR audit_json = ?)").run(json(safeAudit), audit.orchestration_id, row.audit_json == null ? null : String(row.audit_json));
      });
      return { ok: true, value: { orchestration_id: audit.orchestration_id, persisted: true } };
    } catch (cause) {
      return fail("DatabaseUnavailable", message(cause));
    }
  }
  purge(authority: SMEDataRetentionAuthority, target: MemoryRetentionTarget, policyVersion = authority?.policy_version ?? "strict-v1", batchSize = 100): Result<PurgeReceipt, DoorFailure> {
    if (!authority?.subject?.trim() || !authority.policy_version?.trim() || !authority?.can_purge || authority.role !== "retention-authority" || !this.authorized("purge", authority)) return fail("Unauthorized", "retention authority is required");
    if (!target || (!target.workflow_run_id && !target.before && !target.orchestration_ids?.length)) return fail("TargetInvalid", "retention target is empty");
    if (target.before && !Number.isFinite(Date.parse(target.before))) return fail("TargetInvalid", "retention cutoff is invalid");
    if (target.orchestration_ids && target.orchestration_ids.length > batchSize) return fail("TargetInvalid", "retention target exceeds the configured batch size");
    const targetHash = hashPayload(target);
    try {
      return this.transaction(() => {
        const clauses: string[] = [];
        const params: string[] = [];
        if (target.workflow_run_id) { clauses.push("workflow_run_id = ?"); params.push(target.workflow_run_id); }
        if (target.before) { clauses.push("created_at < ?"); params.push(target.before); }
        if (target.orchestration_ids?.length) { clauses.push(`id IN (${target.orchestration_ids.map(() => "?").join(",")})`); params.push(...target.orchestration_ids); }
        const where = clauses.join(" AND ");
        const rows = this.db.prepare(`SELECT id FROM orchestrations WHERE ${where} LIMIT ${batchSize}`).all(...params) as Row[];
        const receiptId = randomUUID();
        const createdAt = now();
        this.db.prepare("INSERT INTO purge_receipts (id, authority_subject, target_hash, records_removed, policy_version, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(receiptId, authority.subject, targetHash, rows.length, policyVersion, createdAt);
        for (const row of rows) this.db.prepare("INSERT INTO audit_tombstones (id, purge_receipt_id, orchestration_hash, created_at) VALUES (?, ?, ?, ?)").run(randomUUID(), receiptId, hashPayload(String(row.id)), createdAt);
        for (const row of rows) this.removeArtifacts(String(row.id));
        if (rows.length) this.db.prepare(`DELETE FROM orchestrations WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((row) => String(row.id)));
        return { ok: true, value: { id: receiptId, authority_subject: authority.subject, target_hash: targetHash, records_removed: rows.length, policy_version: policyVersion, created_at: createdAt } };
      });
    } catch (cause) {
      return fail("PurgeUnavailable", message(cause));
    }
  }

  exportAudit(authority: SMEAuditExportAuthority, filter: RedactedAuditFilter): Result<RedactedAuditExport, DoorFailure> {
    if (!authority || !authority.subject?.trim() || !["audit-authority", "retention-authority"].includes(authority.role) || !this.authorized("audit-export", authority)) return fail("Unauthorized", "audit authority is required");
    if (authority.allowed_workflow_run_ids === undefined && authority.allowed_orchestration_ids === undefined) return fail("Unauthorized", "an explicit audit allowlist is required");
    const limit = Math.trunc(filter?.limit ?? 50);
    if (!filter || !Number.isFinite(filter.limit ?? 50) || limit < 1 || limit > 50) return fail("FilterInvalid", "audit filter is invalid");
    const requestedIds = filter.orchestration_ids;
    if (requestedIds && authority.allowed_orchestration_ids !== undefined && requestedIds.some((id) => !authority.allowed_orchestration_ids!.includes(id))) return fail("Unauthorized", "orchestration is outside authority scope");
    if (filter.workflow_run_id && authority.allowed_workflow_run_ids !== undefined && !authority.allowed_workflow_run_ids.includes(filter.workflow_run_id)) return fail("Unauthorized", "workflow is outside authority scope");
    const clauses: string[] = [];
    const params: string[] = [];
    if (requestedIds?.length) { clauses.push(`id IN (${requestedIds.map(() => "?").join(",")})`); params.push(...requestedIds); }
    if (filter.workflow_run_id) { clauses.push("workflow_run_id = ?"); params.push(filter.workflow_run_id); }
    if (authority.allowed_orchestration_ids !== undefined) {
      if (!authority.allowed_orchestration_ids.length) clauses.push("0");
      else { clauses.push(`id IN (${authority.allowed_orchestration_ids.map(() => "?").join(",")})`); params.push(...authority.allowed_orchestration_ids); }
    }
    if (authority.allowed_workflow_run_ids !== undefined) {
      if (!authority.allowed_workflow_run_ids.length) clauses.push("0");
      else { clauses.push(`workflow_run_id IN (${authority.allowed_workflow_run_ids.map(() => "?").join(",")})`); params.push(...authority.allowed_workflow_run_ids); }
    }
    try {
      const rows = this.db.prepare(`SELECT * FROM orchestrations ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as Row[];
      return { ok: true, value: { generated_at: now(), records: rows.map((row) => this.statusFromRow(row)) } };
    } catch (cause) {
      return fail("ExportTooLarge", message(cause));
    }
  }

  private authorized(action: SMEAuthorityAction, subject: SMEAuthoritySubject): boolean {
    if (!this.authorityVerifier) return false;
    try { return this.authorityVerifier(action, subject); } catch { return false; }
  }
  private removeArtifacts(orchestrationId: string): void {
    const rows = this.db.prepare("SELECT artifact_acl_json FROM requests WHERE orchestration_id = ?").all(orchestrationId) as Row[];
    for (const row of rows) {
      let artifacts: unknown;
      try { artifacts = parse(row.artifact_acl_json); } catch { continue; }
      if (!Array.isArray(artifacts)) continue;
      for (const artifact of artifacts as Array<{ path?: string; artifact_root?: string }>) {
        if (!artifact?.path || !artifact.artifact_root || artifact.path.startsWith("artifact://")) continue;
        const root = resolve(artifact.artifact_root);
        const path = resolve(artifact.path);
        if (!path.startsWith(`${root}/`) || !/^.+-[0-9a-f]{16}\.json$/i.test(basename(path))) continue;
        for (const candidate of [path, `${path}.acl.json`]) if (existsSync(candidate)) unlinkSync(candidate);
      }
    }
  }


  private statusFromRow(row: Row): OrchestrationStatus {
    const id = String(row.id);
    const prepared = this.getPrepared(id);
    const budget = prepared?.budget ?? (row.budget_json ? parse<DeliberationBudget>(row.budget_json) : undefined);
    const remaining = budget ? this.budget(id, budget) : undefined;
    return {
      orchestration_id: id,
      workflow_run_id: String(row.workflow_run_id),
      stage_id: String(row.stage_id),
      orchestration_status: String(row.orchestration_status),
      delivery_status: String(row.delivery_status) as DeliveryStatus,
      ...(remaining ? { budget: remaining } : {}),
      rounds_recorded: this.listRounds(id).length,
      calls_recorded: Number(row.spent_sme_calls ?? 0),
      personas: prepared?.personas ?? [],
      decision: row.decision_json ? redactDecision(parse(row.decision_json)) : undefined,
      created_at: String(row.created_at),
      settled_at: row.settled_at == null ? undefined : String(row.settled_at),
    };
  }
}

export function hashPayload(value: unknown): Hash { return createHash("sha256").update(stableJson(value)).digest("hex"); }
export function now(): string { return new Date().toISOString(); }
function fail<T extends DoorFailure>(kind: T["kind"], message: string, details?: unknown): Result<never, T> { return { ok: false, error: { kind, message, ...(details === undefined ? {} : { details }) } as T }; }

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validRescueEvent(event: SMEBlockRescueRequested | undefined): boolean {
  const raw = event?.raw_context;
  return Boolean(
    event && nonEmptyString(event.event_id) && nonEmptyString(event.workflow_run_id) && nonEmptyString(event.stage_id) && nonEmptyString(event.idempotency_key)
      && raw && raw.workflow_run_id === event.workflow_run_id && raw.stage_id === event.stage_id
      && nonEmptyString(raw.blocked_reason) && "raw_input" in raw && "raw_output" in raw && Array.isArray(raw.artifacts),
  );
}
function claimFromRow(row: Row): ClaimedBlockedStage { return { orchestration_id: String(row.id), workflow_run_id: String(row.workflow_run_id), stage_id: String(row.stage_id), idempotency_key: String(row.idempotency_key), payload_hash: String(row.payload_hash) }; }
function sameClaim(a: ClaimedBlockedStage, b: ClaimedBlockedStage): boolean { return a.orchestration_id === b.orchestration_id && a.workflow_run_id === b.workflow_run_id && a.stage_id === b.stage_id && a.idempotency_key === b.idempotency_key && a.payload_hash === b.payload_hash; }
function json(value: unknown): string { return JSON.stringify(value); }
function parse<T = any>(value: unknown): T { return typeof value === "string" ? JSON.parse(value) as T : value as T; }
function sleep(ms: number): void { const until = Date.now() + ms; while (Date.now() < until) { /* DatabaseSync does not expose async transactions. */ } }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function parseMoney(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error("money amount must be a non-negative decimal with at most six fractional digits");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}
function canonicalMoney(value: bigint): string {
  if (value < 0n) throw new Error("money amount cannot be negative");
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
function validateBudget(budget: DeliberationBudget): void {
  if (!budget || !Number.isInteger(budget.max_rounds) || budget.max_rounds <= 0 || !Number.isInteger(budget.max_sme_calls) || budget.max_sme_calls <= 0) throw new Error("budget bounds are invalid");
  parseMoney(budget.max_cost);
}
function redactSource(source: Source): Source {
  if (!source || !nonEmptyString(source.url)) throw new Error("source URL is required");
  return {
    url: redactText(source.url),
    ...(source.title == null ? {} : { title: redactText(String(source.title)) }),
    ...(source.accessed_at == null ? {} : { accessed_at: redactText(String(source.accessed_at)) }),
    ...(source.excerpt == null ? {} : { excerpt: redactText(String(source.excerpt)) }),
  };
}
function redactPersona(persona: SMEPersona): SMEPersona {
  return {
    id: String(persona.id),
    title: redactText(String(persona.title)),
    domain: redactText(String(persona.domain)),
    local_conditions: Array.isArray(persona.local_conditions) ? persona.local_conditions.map((value) => redactText(String(value))) : [],
    initial_brief: redactText(String(persona.initial_brief)),
    ...(persona.preferred_model == null ? {} : { preferred_model: redactText(String(persona.preferred_model)) }),
  };
}
function validAnswer(answer: SMEAnswer): boolean {
  return Boolean(
    answer && nonEmptyString(answer.persona_id) && nonEmptyString(answer.answer) && nonEmptyString(answer.reasoning)
      && Array.isArray(answer.sources) && answer.sources.every((source) => source && nonEmptyString(source.url)),
  );
}
function redactAnswer(answer: SMEAnswer): SMEAnswer {
  return {
    persona_id: String(answer.persona_id),
    answer: redactText(String(answer.answer)),
    reasoning: redactText(String(answer.reasoning)),
    sources: answer.sources.map(redactSource),
    ...(answer.feedback_notes == null ? {} : { feedback_notes: redactText(String(answer.feedback_notes)) }),
    ...(answer.model == null ? {} : { model: redactText(String(answer.model)) }),
    ...(answer.actual_cost == null ? {} : { actual_cost: canonicalMoney(parseMoney(String(answer.actual_cost))) }),
  };
}
function redactCallResult(result: SMECallResult): SMECallResult {
  if (!nonEmptyString(result.answer) || !nonEmptyString(result.reasoning)) throw new Error("SME answer is incomplete");
  const sources = result.sources ?? [];
  if (!Array.isArray(sources) || !sources.every((source) => source && nonEmptyString(source.url))) throw new Error("SME sources are invalid");
  return {
    answer: redactText(result.answer),
    reasoning: redactText(result.reasoning),
    sources: sources.map(redactSource),
    ...(result.feedback_notes == null ? {} : { feedback_notes: redactText(result.feedback_notes) }),
    ...(result.actual_cost == null ? {} : { actual_cost: canonicalMoney(parseMoney(result.actual_cost)) }),
    ...(result.model == null ? {} : { model: redactText(result.model) }),
  };
}
function redactDecision(decision: WorkflowUnblockDecision): WorkflowUnblockDecision {
  if (decision?.kind === "continue") {
    const answer = decision.answer;
    return { kind: "continue", answer: { answer: redactText(String(answer?.answer ?? "")), reasoning: redactText(String(answer?.reasoning ?? "")), sources: Array.isArray(answer?.sources) ? answer.sources.map(redactSource) : [] } };
  }
  if (decision?.kind === "escalate") return { kind: "escalate", reasons: Array.isArray(decision.reasons) ? decision.reasons.map((reason) => redactText(String(reason))) as [string, ...string[]] : ["invalid escalation"] };
  return {
    kind: "unresolved",
    reasons: Array.isArray(decision?.reasons) ? decision.reasons.map((reason) => redactText(String(reason))) as [string, ...string[]] : ["invalid unresolved decision"],
    ...(decision?.partial ? { partial: { answer: redactText(String(decision.partial.answer)), reasoning: redactText(String(decision.partial.reasoning)), sources: Array.isArray(decision.partial.sources) ? decision.partial.sources.map(redactSource) : [] } } : {}),
  };
}
function validateDecision(decision: WorkflowUnblockDecision): void {
  if (decision?.kind === "continue") {
    if (!nonEmptyString(decision.answer?.answer) || !nonEmptyString(decision.answer?.reasoning) || !Array.isArray(decision.answer?.sources)) throw new Error("continue decision is incomplete");
    return;
  }
  if ((decision?.kind === "escalate" || decision?.kind === "unresolved") && Array.isArray(decision.reasons) && decision.reasons.length && decision.reasons.every(nonEmptyString)) return;
  throw new Error("unblock decision is invalid");
}
function isFailedResult(value: unknown): boolean { try { return Boolean(parse<Record<string, unknown>>(value).failed); } catch { return false; } }
function reservedFromRow(row: Row): ReservedSMECall {
  return { persona_id: String(row.persona_id), round_number: Number(row.round_number), estimated_cost: String(row.estimated_cost), ...(row.model == null ? {} : { model: String(row.model) }), reservation_id: String(row.id) };
}
function canonicalPrepared(prepared: PreparedSMERequest, policy: ContextPolicy): PreparedSMERequest {
  assertTrustedPrepared(prepared);
  const context = JSON.parse(JSON.stringify(redactJson(prepared.question.context as unknown as JsonValue, policy))) as import("./types.js").TrustedWorkflowBlockContext;
  const personas = prepared.personas.map(redactPersona) as [SMEPersona, ...SMEPersona[]];
  return {
    question: {
      topic: redactText(prepared.question.topic),
      subject: redactText(prepared.question.subject),
      question: redactText(prepared.question.question),
      context,
      ...(prepared.question.peer_answers == null ? {} : { peer_answers: prepared.question.peer_answers.map(redactAnswer) }),
      ...(prepared.question.peer_artifacts == null ? {} : { peer_artifacts: JSON.parse(JSON.stringify(redactJson(prepared.question.peer_artifacts as unknown as JsonValue, policy))) }),
    },
    personas,
    budget: { max_rounds: prepared.budget.max_rounds, max_sme_calls: prepared.budget.max_sme_calls, max_cost: canonicalMoney(parseMoney(prepared.budget.max_cost)) },
    rationale: redactText(prepared.rationale),
    ...(prepared.research_required == null ? {} : { research_required: prepared.research_required }),
  };
}
function assertTrustedPrepared(prepared: PreparedSMERequest): void {
  const context = prepared?.question?.context as unknown as Record<string, unknown>;
  if (!context || "raw_input" in context || "raw_output" in context || "blocked_reason" in context === false || !context.workflow_run_id || !context.stage_id || !("sanitized_input" in context) || !("sanitized_output" in context) || !Array.isArray(context.safe_artifacts)) throw new Error("prepared request must contain TrustedWorkflowBlockContext");
  if (!Array.isArray(prepared.personas) || !prepared.personas.length || !prepared.rationale || !prepared.budget) throw new Error("prepared request is incomplete");
}

