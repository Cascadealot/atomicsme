import type { SMEStore } from "./store.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** A list that always contains at least one item. */
export type NonEmptyArray<T> = [T, ...T[]];
export type PositiveInt = number;
export type NonNegativeInt = number;
export type MoneyAmount = string;
export type MoneyLimit = string;
export type ModelSelector = string;

export type WorkflowRunId = string;
export type StageId = string;
export type EventId = string;
export type IdempotencyKey = string;
export type Hash = string;
export type OrchestrationId = string;
export type PersonaId = string;
export type ReservationId = string;
export type RequestId = string;

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type ArtifactRef = {
  path: string;
  label?: string;
  media_type?: string;
  bytes?: number;
  source_stage?: string;
  redaction_policy_version?: string;
  allowed_readers?: string[];
  artifact_root?: string;
};

export type RawWorkflowBlockContext = {
  workflow_run_id: WorkflowRunId;
  stage_id: StageId;
  blocked_reason: string;
  raw_input: JsonValue;
  raw_output: JsonValue;
  artifacts: ArtifactRef[];
};

export type TrustedWorkflowBlockContext = {
  workflow_run_id: WorkflowRunId;
  stage_id: StageId;
  blocked_reason: string;
  sanitized_input: JsonValue;
  sanitized_output: JsonValue;
  safe_artifacts: ArtifactRef[];
};

export type ContextPolicy = {
  redactionPolicy: string;
  artifactFirst: boolean;
  redactionPolicyVersion?: string;
  maxInlineBytes?: number;
  artifactDir?: string;
  allowedArtifactReaders?: string[];
  secretFields?: string[];
  piiFields?: string[];
  criticalFields?: string[];
  bulkFields?: string[];
};

export type ContextClassification =
  | "secret"
  | "pii"
  | "critical-constraint"
  | "compact-summary"
  | "bulk-artifact";

export type ContextGovernanceRequest = {
  workflow_run_id?: WorkflowRunId;
  stage_id?: StageId;
  fields?: { name: string; classification: ContextClassification; value?: JsonValue }[];
  critical_fields?: string[];
  bulk_fields?: string[];
  policy?: ContextPolicy;
  approved?: boolean;
};

export type ContextGovernancePlan = {
  workflow_run_id?: WorkflowRunId;
  stage_id?: StageId;
  classifications: { name: string; classification: ContextClassification }[];
  protected_fields: string[];
  redacted_fields: string[];
  artifact_fields: string[];
  keep_context: string[];
  redaction_policy_version: string;
  artifact_first: boolean;
};

export type SMEQuestion = {
  topic: string;
  subject: string;
  question: string;
  context: TrustedWorkflowBlockContext;
  peer_answers?: SMEAnswer[];
  peer_artifacts?: ArtifactRef[];
};

export type SMEPersona = {
  id: PersonaId;
  title: string;
  domain: string;
  local_conditions: string[];
  initial_brief: string;
  preferred_model?: ModelSelector;
};

export type DeliberationBudget = {
  max_rounds: PositiveInt;
  max_sme_calls: PositiveInt;
  max_cost: MoneyLimit;
};

export type RemainingDeliberationBudget = {
  budget: DeliberationBudget;
  spent_rounds: NonNegativeInt;
  spent_sme_calls: NonNegativeInt;
  reserved_cost: MoneyAmount;
  spent_cost: MoneyAmount;
  status: "active" | "exhausted";
};

export type SMECallReservation = {
  persona_id: PersonaId;
  round_number: PositiveInt;
  estimated_cost: MoneyAmount;
  model?: ModelSelector;
};

export type ReservedSMECall = SMECallReservation & { reservation_id: ReservationId };

export type Source = {
  url: string;
  title?: string;
  accessed_at?: string;
  excerpt?: string;
};

export type SMEAnswer = {
  persona_id: PersonaId;
  answer: string;
  reasoning: string;
  sources: Source[];
  feedback_notes?: string;
  model?: ModelSelector;
  actual_cost?: MoneyAmount;
};

export type DeliberationRound = {
  round_number: PositiveInt;
  answers: SMEAnswer[];
  synthesis_hint?: string;
};

export type RecordedRound = DeliberationRound & {
  orchestration_id: OrchestrationId;
  request_id: RequestId;
  recorded_at: string;
};

export type RevisionRequest = {
  round_number: PositiveInt;
  persona_id: PersonaId;
  reason: string;
  question: SMEQuestion;
};

export type SynthesizedResponse = {
  answer: string;
  reasoning: string;
  sources: Source[];
};

export type SynthesisOutcome =
  | { kind: "final"; answer: SynthesizedResponse }
  | { kind: "revise"; request: RevisionRequest }
  | { kind: "unresolved"; reasons: NonEmptyArray<string> };

export type PreparedSMERequest = {
  question: SMEQuestion;
  personas: NonEmptyArray<SMEPersona>;
  budget: DeliberationBudget;
  rationale: string;
  research_required?: boolean;
};

export type SMEBlockRescueRequested = {
  event_id: EventId;
  workflow_run_id: WorkflowRunId;
  stage_id: StageId;
  idempotency_key: IdempotencyKey;
  raw_context: RawWorkflowBlockContext;
};

export type ClaimedBlockedStage = {
  orchestration_id: OrchestrationId;
  workflow_run_id: WorkflowRunId;
  stage_id: StageId;
  idempotency_key: IdempotencyKey;
  payload_hash: Hash;
};

export type WorkflowUnblockDecision =
  | { kind: "continue"; answer: SynthesizedResponse }
  | { kind: "escalate"; reasons: NonEmptyArray<string> }
  | { kind: "unresolved"; reasons: NonEmptyArray<string>; partial?: SynthesizedResponse };

export type MemoryReadScope = {
  workflow_run_id?: WorkflowRunId;
  orchestration_ids?: OrchestrationId[];
  subjects?: string[];
  include_sources?: boolean;
  authorized?: boolean;
};

export type SMEMemoryMatch = {
  request_id: RequestId;
  orchestration_id: OrchestrationId;
  topic: string;
  subject: string;
  question: string;
  strategy_rationale: string;
  created_at: string;
  rounds?: RecordedRound[];
};

export type SMEMemoryPage = {
  matches: SMEMemoryMatch[];
  total: number;
  limit: number;
  offset: number;
};

export type RelevantSMEMemory = SMEMemoryPage | SMEMemoryMatch[];

export type SafeSearchQuery = {
  text: string;
  limit?: number;
  offset?: number;
};

export type AuditReadScope = {
  workflow_run_id?: WorkflowRunId;
  orchestration_ids?: OrchestrationId[];
  include_context?: boolean;
  authorized?: boolean;
};

export type OrchestrationStatus = {
  orchestration_id: OrchestrationId;
  workflow_run_id: WorkflowRunId;
  stage_id: StageId;
  orchestration_status: string;
  delivery_status: "pending" | "delivered" | "failed";
  budget?: RemainingDeliberationBudget;
  rounds_recorded: number;
  calls_recorded: number;
  personas: SMEPersona[];
  decision?: WorkflowUnblockDecision;
  created_at: string;
  settled_at?: string;
};

export type SMEDataRetentionAuthority = {
  subject: string;
  role: string;
  can_purge: boolean;
  policy_version: string;
};

export type MemoryRetentionTarget = {
  orchestration_ids?: OrchestrationId[];
  workflow_run_id?: WorkflowRunId;
  before?: string;
};

export type PurgeReceipt = {
  id: string;
  authority_subject: string;
  target_hash: Hash;
  records_removed: number;
  policy_version: string;
  created_at: string;
};

export type SMEAuditExportAuthority = {
  subject: string;
  role: string;
  allowed_workflow_run_ids?: WorkflowRunId[];
  allowed_orchestration_ids?: OrchestrationId[];
};

export type SMEAuthorityAction = "memory-read" | "audit-read" | "purge" | "audit-export";
export type SMEAuthoritySubject = MemoryReadScope | AuditReadScope | SMEDataRetentionAuthority | SMEAuditExportAuthority;
export type SMEAuthorityVerifier = (action: SMEAuthorityAction, subject: SMEAuthoritySubject) => boolean;

export type RedactedAuditFilter = {
  orchestration_ids?: OrchestrationId[];
  workflow_run_id?: WorkflowRunId;
  limit?: number;
};

export type RedactedAuditExport = {
  records: OrchestrationStatus[];
  generated_at: string;
};

export type SMEPolicy = {
  coordinator_model?: ModelSelector;
  coordinator_model_class?: "frontier" | string;
  sme_models?: ModelSelector[];
  prefer_local_reasoning?: boolean;
  diversify_models_when_available?: boolean;
  require_web_research?: boolean;
  require_strategy_rationale?: boolean;
  budget?: DeliberationBudget;
  max_memory_page_size?: number;
  memory_scope?: string;
  redaction_policy_version?: string;
  persona_factory?: (context: TrustedWorkflowBlockContext, memory: RelevantSMEMemory) => SMEPersona[];
};

export type SMECallResult = {
  answer: string;
  reasoning: string;
  sources?: Source[];
  feedback_notes?: string;
  actual_cost?: MoneyAmount;
  model?: ModelSelector;
};

export type SMECallRunner = (
  persona: SMEPersona,
  question: SMEQuestion,
  round_number: PositiveInt,
  signal?: AbortSignal,
) => Promise<SMECallResult>;

export type OrchestrationOptions = {
  store?: SMEStore;
  call_sme?: SMECallRunner;
  deliver?: (decision: WorkflowUnblockDecision) => Promise<void> | void;
  signal?: AbortSignal;
};

export type OrchestrationAudit = {
  orchestration_id: OrchestrationId;
  request_id?: RequestId;
  claim: ClaimedBlockedStage;
  prepared: PreparedSMERequest;
  rounds: RecordedRound[];
  decision: WorkflowUnblockDecision;
  delivery_status?: "pending" | "delivered" | "failed";
};

export type RescueAdapterStatus = {
  enabled: false;
  hook_available: false;
  reason: string;
};

export type DeliveryStatus = "pending" | "delivered" | "failed";

export type DoorError = {
  kind: string;
  message: string;
  details?: JsonValue;
};

export type SanitizationError = DoorError & {
  kind: "ContextTooLarge" | "NoMeaningfulContent" | "SanitizationFailed";
};
export type StrategyError = DoorError & {
  kind: "InsufficientContext" | "BudgetUnavailable" | "PersonaCreationFailed";
};
export type ClaimError = DoorError & {
  kind: "DuplicatePayloadMismatch" | "ClaimUnavailable" | "InvalidRescueEvent";
};
export type BudgetError = DoorError & {
  kind: "CallsExhausted" | "CostLimitExceeded" | "BudgetStateInvalid";
};
export type PersistenceError = DoorError & {
  kind: "DatabaseUnavailable" | "RoundAlreadyRecorded" | "SchemaMismatch";
};
export type SynthesisError = DoorError & {
  kind: "EmptyRound" | "ContextMismatch" | "BudgetStateInvalid";
};
export type RevisionError = DoorError & {
  kind: "PersonaNotInCohort" | "PeerSetInvalid" | "ResearchFailed";
};
export type SearchError = DoorError & {
  kind: "Unauthorized" | "QueryInvalid" | "SearchUnavailable";
};
export type InspectionError = DoorError & {
  kind: "Unauthorized" | "NotFound" | "InspectionUnavailable";
};
export type PurgeError = DoorError & {
  kind: "Unauthorized" | "TargetInvalid" | "PurgeUnavailable";
};
export type ExportError = DoorError & {
  kind: "Unauthorized" | "FilterInvalid" | "ExportTooLarge";
};
export type ContextGovernanceError = DoorError & {
  kind: "ClassificationInvalid" | "PolicyInvalid" | "GovernanceFailed";
};
export type OrchestrationError = DoorError & {
  kind: "BudgetExceeded" | "AllSMEsFailed" | "PersistenceUnavailable";
};
