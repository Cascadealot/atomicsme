import type { DeliberationRound, PreparedSMERequest, RecordedRound, RemainingDeliberationBudget, SMEQuestion } from "./types.js";

const recordedProofs = new WeakMap<object, string>();
const recordedQuestions = new WeakMap<object, SMEQuestion>();
const budgetProofs = new WeakMap<object, string>();
const budgetOrchestrations = new WeakMap<object, string>();
const preparedProofs = new WeakMap<object, string>();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function markPreparedSMERequest(prepared: PreparedSMERequest): PreparedSMERequest {
  preparedProofs.set(prepared, stableJson(prepared));
  return prepared;
}

export function isPreparedSMERequest(prepared: PreparedSMERequest | undefined): prepared is PreparedSMERequest {
  return Boolean(prepared && typeof prepared === "object" && preparedProofs.get(prepared) === stableJson(prepared));
}

export function markRecordedRound(round: RecordedRound, question?: SMEQuestion): RecordedRound {
  recordedProofs.set(round, stableJson(round));
  if (question) recordedQuestions.set(round, question);
  return round;
}

export function isRecordedRound(round: DeliberationRound | undefined): round is RecordedRound {
  return Boolean(round && typeof round === "object" && recordedProofs.get(round) === stableJson(round));
}

export function recordedRoundQuestion(round: RecordedRound | undefined): SMEQuestion | undefined {
  return round && isRecordedRound(round) ? recordedQuestions.get(round) : undefined;
}

export function markRemainingBudget(budget: RemainingDeliberationBudget, orchestrationId?: string): RemainingDeliberationBudget {
  budgetProofs.set(budget, stableJson(budget));
  if (orchestrationId) budgetOrchestrations.set(budget, orchestrationId);
  return budget;
}

export function isRemainingBudget(budget: RemainingDeliberationBudget | undefined): budget is RemainingDeliberationBudget {
  return Boolean(budget && typeof budget === "object" && budgetProofs.get(budget) === stableJson(budget));
}

export function remainingBudgetOrchestration(budget: RemainingDeliberationBudget | undefined): string | undefined {
  return budget && isRemainingBudget(budget) ? budgetOrchestrations.get(budget) : undefined;
}
