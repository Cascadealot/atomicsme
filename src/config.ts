import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextPolicy, SMEPolicy } from "./types.js";

export type SMEConfigBudget = {
  maxRounds: number;
  maxSMECalls: number;
  maxCost: string;
};

export type SMEConfig = {
  integration: { mode: "intercom-rescue" | string; allowWorkflowWrapper: boolean; enabled: false };
  coordinator: { modelClass: "frontier" | string; model: string; requireStrategyRationale: boolean };
  smes: { preferLocalReasoning: boolean; diversifyModelsWhenAvailable: boolean; requireWebResearch: boolean; models: string[] };
  memory: {
    engine: "sqlite-fts5";
    path: string;
    retention: string;
    maxPageSize: number;
    maxQueryLength: number;
    retentionBatchSize: number;
    checkpointPolicy: string;
    ftsRebuildPolicy: string;
  };
  context: ContextPolicy;
  budget: SMEConfigBudget;
};

/** Input form used by package authors; omitted values inherit the package defaults. */
export type SMEConfigInput = {
  integration?: { mode?: "intercom-rescue" | string; allowWorkflowWrapper?: boolean; enabled?: boolean };
  coordinator?: { modelClass?: "frontier" | string; model?: string; requireStrategyRationale?: boolean };
  smes?: { preferLocalReasoning?: boolean; diversifyModelsWhenAvailable?: boolean; requireWebResearch?: boolean; models?: string[] };
  memory?: Partial<SMEConfig["memory"]>;
  context?: Partial<ContextPolicy>;
  budget?: Partial<SMEConfigBudget>;
};

/** Model selectors verified against the installed Atomic catalog. */
export const VERIFIED_COORDINATOR_MODEL = "openai-codex/gpt-5.6-luna";
export const VERIFIED_SME_MODELS = [
  "local-vllm-109/qwen3.6-27b-fp8",
  "local-vllm-104-muse-glimmer/RedHatAI/Muse-Glimmer-30B-FP8-block",
  "local-qwen36-35b/qwen3.6-35b-a3b-iq4_nl",
];

export const DEFAULT_SME_DB_PATH = join(homedir(), ".atomic", "sme", "sme.db");
export const DEFAULT_SME_ARTIFACT_DIR = join(homedir(), ".atomic", "sme", "artifacts");

export const defaultSMEConfig: SMEConfig = {
  integration: { mode: "intercom-rescue", allowWorkflowWrapper: false, enabled: false },
  coordinator: { modelClass: "frontier", model: VERIFIED_COORDINATOR_MODEL, requireStrategyRationale: true },
  smes: { preferLocalReasoning: true, diversifyModelsWhenAvailable: true, requireWebResearch: true, models: [...VERIFIED_SME_MODELS] },
  memory: {
    engine: "sqlite-fts5",
    path: DEFAULT_SME_DB_PATH,
    retention: "configured-policy",
    maxPageSize: 50,
    maxQueryLength: 500,
    retentionBatchSize: 100,
    checkpointPolicy: "configured-policy",
    ftsRebuildPolicy: "configured-policy",
  },
  context: { redactionPolicy: "strict", artifactFirst: true, artifactDir: DEFAULT_SME_ARTIFACT_DIR, redactionPolicyVersion: "strict-v1", maxInlineBytes: 32_000, allowedArtifactReaders: ["sme-stage"] },
  budget: { maxRounds: 3, maxSMECalls: 18, maxCost: "10.00" },
};

/** Merge package configuration while keeping the first-stage rescue adapter disabled. */
export function defineSMEConfig(input: SMEConfigInput = {}): SMEConfig {
  return {
    integration: {
      ...defaultSMEConfig.integration,
      ...input.integration,
      enabled: false,
    },
    coordinator: { ...defaultSMEConfig.coordinator, ...input.coordinator },
    smes: {
      ...defaultSMEConfig.smes,
      ...input.smes,
      models: input.smes?.models ? [...input.smes.models] : [...defaultSMEConfig.smes.models],
    },
    memory: { ...defaultSMEConfig.memory, ...input.memory },
    context: {
      ...defaultSMEConfig.context,
      ...input.context,
      allowedArtifactReaders: input.context?.allowedArtifactReaders
        ? [...input.context.allowedArtifactReaders]
        : [...(defaultSMEConfig.context.allowedArtifactReaders ?? [])],
      secretFields: input.context?.secretFields ? [...input.context.secretFields] : defaultSMEConfig.context.secretFields,
      piiFields: input.context?.piiFields ? [...input.context.piiFields] : defaultSMEConfig.context.piiFields,
      criticalFields: input.context?.criticalFields ? [...input.context.criticalFields] : defaultSMEConfig.context.criticalFields,
      bulkFields: input.context?.bulkFields ? [...input.context.bulkFields] : defaultSMEConfig.context.bulkFields,
    },
    budget: { ...defaultSMEConfig.budget, ...input.budget },
  };
}

export function getSMEPolicy(config: SMEConfig = defaultSMEConfig): SMEPolicy {
  return {
    coordinator_model: config.coordinator.model,
    coordinator_model_class: config.coordinator.modelClass,
    sme_models: [...config.smes.models],
    prefer_local_reasoning: config.smes.preferLocalReasoning,
    diversify_models_when_available: config.smes.diversifyModelsWhenAvailable,
    require_web_research: config.smes.requireWebResearch,
    require_strategy_rationale: config.coordinator.requireStrategyRationale,
    budget: { max_rounds: config.budget.maxRounds, max_sme_calls: config.budget.maxSMECalls, max_cost: config.budget.maxCost },
    max_memory_page_size: config.memory.maxPageSize,
    memory_scope: "sme",
    redaction_policy_version: config.context.redactionPolicyVersion,
  };
}

export function getContextPolicy(config: SMEConfig = defaultSMEConfig): ContextPolicy {
  return {
    ...config.context,
    allowedArtifactReaders: config.context.allowedArtifactReaders ? [...config.context.allowedArtifactReaders] : undefined,
    secretFields: config.context.secretFields ? [...config.context.secretFields] : undefined,
    piiFields: config.context.piiFields ? [...config.context.piiFields] : undefined,
    criticalFields: config.context.criticalFields ? [...config.context.criticalFields] : undefined,
    bulkFields: config.context.bulkFields ? [...config.context.bulkFields] : undefined,
  };
}

export function getDatabasePath(config: SMEConfig = defaultSMEConfig): string {
  return process.env.ATOMIC_SME_DB_PATH || process.env.ATOMIC_SME_DATABASE || config.memory.path;
}
