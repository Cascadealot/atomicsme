import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  claim_blocked_stage,
  inspect_sme_orchestration,
  orchestrate_sme,
  prepare_sme_strategy,
  sanitize_workflow_context,
} from "../src/index.js";
import type {
  JsonValue,
  RawWorkflowBlockContext,
  SMEBlockRescueRequested,
  SMEPolicy,
} from "../src/types.js";

const CATALOG = join(homedir(), ".atomic", "lab", "llm-catalog.json");

function loadSmeModel(): string {
  if (!existsSync(CATALOG)) return "";
  try {
    const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as {
      models: { fullId: string; available: boolean; preference: number; suggested_uses: string[] }[];
    };
    const usable = catalog.models
      .filter((m) => m.available && (m.preference ?? 0) > 0)
      .sort((a, b) => b.preference - a.preference);
    return usable.find((m) => m.suggested_uses.includes("sme") || m.suggested_uses.includes("worker"))?.fullId ?? "";
  } catch {
    return "";
  }
}

const defaultPolicy = (smeModel: string): SMEPolicy => ({
  coordinator_model: "sme-coordinator",
  sme_models: smeModel ? [smeModel] : [],
  budget: { max_rounds: 2, max_sme_calls: 4, max_cost: "1" },
  require_web_research: false,
  diversify_models_when_available: false,
});

export default workflow({
  name: "sme-unblock",
  description: "Orchestrate SME agents to resolve a blocked workflow stage and return a durable decision.",
  inputs: {
    workflow_run_id: Type.String({ description: "Run id of the blocked workflow." }),
    stage_id: Type.String({ description: "Stage id of the blocked stage." }),
    blocked_reason: Type.String({ description: "Why the stage is blocked." }),
    raw_input: Type.Optional(Type.String({ description: "JSON of the blocked stage's raw input." })),
    raw_output: Type.Optional(Type.String({ description: "JSON of the blocked stage's raw output." })),
    policy: Type.Optional(Type.String({ description: "Optional JSON SMEPolicy override." })),
    sme_model: Type.Optional(Type.String({ description: "Optional SME model fullId override." })),
  },
  outputs: {
    ok: Type.Boolean(),
    decision_kind: Type.String(),
    answer: Type.Optional(Type.String()),
    reasons: Type.Optional(Type.Array(Type.String())),
    error_kind: Type.Optional(Type.String()),
    rounds_recorded: Type.Number(),
    calls_recorded: Type.Number(),
  },
  run: async (ctx) => {
    const parseJson = (raw: string | undefined): JsonValue => {
      if (!raw) return {};
      try {
        return JSON.parse(raw) as JsonValue;
      } catch {
        return {};
      }
    };

    const rawContext: RawWorkflowBlockContext = {
      workflow_run_id: String(ctx.inputs.workflow_run_id),
      stage_id: String(ctx.inputs.stage_id),
      blocked_reason: String(ctx.inputs.blocked_reason),
      raw_input: parseJson(ctx.inputs.raw_input),
      raw_output: parseJson(ctx.inputs.raw_output),
      artifacts: [],
    };

    const event: SMEBlockRescueRequested = {
      event_id: `${String(ctx.inputs.workflow_run_id)}:${String(ctx.inputs.stage_id)}`,
      workflow_run_id: String(ctx.inputs.workflow_run_id),
      stage_id: String(ctx.inputs.stage_id),
      idempotency_key: `${String(ctx.inputs.workflow_run_id)}:${String(ctx.inputs.stage_id)}`,
      raw_context: rawContext,
    };

    const claimed = claim_blocked_stage(event);
    if (!claimed.ok) {
      return { ok: false, decision_kind: "error", error_kind: claimed.error.kind, rounds_recorded: 0, calls_recorded: 0 };
    }

    const trusted = await sanitize_workflow_context(rawContext, { redactionPolicy: "strict", artifactFirst: true });
    if (!trusted.ok) {
      return { ok: false, decision_kind: "error", error_kind: trusted.error.kind, rounds_recorded: 0, calls_recorded: 0 };
    }

    const smeModel = ctx.inputs.sme_model || loadSmeModel();
    const policy: SMEPolicy = ctx.inputs.policy ? (JSON.parse(ctx.inputs.policy) as SMEPolicy) : defaultPolicy(smeModel);

    const strategy = prepare_sme_strategy(trusted.value, [], policy);
    if (!strategy.ok) {
      return { ok: false, decision_kind: "error", error_kind: strategy.error.kind, rounds_recorded: 0, calls_recorded: 0 };
    }

    const result = await orchestrate_sme(claimed.value, strategy.value, {
      call_sme: async (persona, question, roundNumber) => {
        const answer = await ctx.task(`sme-${persona.id}-r${roundNumber}`, {
          model: smeModel || undefined,
          prompt: [
            persona.initial_brief,
            ...persona.local_conditions,
            `Question: ${question.question}`,
            "Answer concisely with a clear recommendation.",
          ].join("\n\n"),
        });
        return { answer: answer.text ?? "", reasoning: "SME response", sources: [], model: smeModel || undefined };
      },
    });

    const inspection = inspect_sme_orchestration(claimed.value.orchestration_id, {
      workflow_run_id: String(ctx.inputs.workflow_run_id),
      authorized: true,
    });
    const roundsRecorded = inspection.ok ? inspection.value.rounds_recorded : 0;
    const callsRecorded = inspection.ok ? inspection.value.calls_recorded : 0;

    if (!result.ok) {
      return { ok: false, decision_kind: "error", error_kind: result.error.kind, rounds_recorded: roundsRecorded, calls_recorded: callsRecorded };
    }

    const decision = result.value;
    const answer = decision.kind === "continue" ? decision.answer.answer : undefined;
    const reasons = decision.kind === "continue" ? undefined : decision.reasons;

    return {
      ok: true,
      decision_kind: decision.kind,
      ...(answer !== undefined ? { answer } : {}),
      ...(reasons !== undefined ? { reasons } : {}),
      rounds_recorded: roundsRecorded,
      calls_recorded: callsRecorded,
    };
  },
});
