import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  ArtifactRef,
  ContextClassification,
  ContextGovernanceError,
  ContextGovernancePlan,
  ContextGovernanceRequest,
  ContextPolicy,
  JsonValue,
  RawWorkflowBlockContext,
  Result,
  SanitizationError,
  TrustedWorkflowBlockContext,
} from "./types.js";

const SECRET_KEY = /pass(?:word)?|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|token|secret|credential|authorization|cookie|private[\s_-]?key/i;
const PII_KEY = /email|phone|address|ssn|social|name|user(name)?|account|customer|ip[_-]?address/i;
const SECRET_VALUE = /((?:^|[?&;,\s{])\s*["']?(?:pass(?:word)?|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|token|secret|credential|authorization|cookie|private[\s_-]?key)["']?\s*[:=]\s*)(["'])([\s\S]*?)\2|((?:^|[?&;,\s{])\s*["']?(?:pass(?:word)?|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|token|secret|credential|authorization|cookie|private[\s_-]?key)["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?)([^\s,;}"']+)/gi;
const NATURAL_SECRET = /\b(?:api\s+)?(?:key|token|secret|password|credential)\s+(?:is|=)\s+([A-Za-z0-9_./+:-]{8,}|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi;
const HEADER_SECRET = /\b(?:authorization|proxy-authorization)\s*:\s*(?:Bearer|Basic)\s+[^\s,;]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<![A-Za-z0-9-])(?:\+?\d[\d ()-]{7,}\d)(?![A-Za-z0-9-])/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DEFAULT_MAX_INLINE_BYTES = 32_000;
const trustedContextProofs = new WeakMap<object, string>();
const trustedContextClaims = new WeakMap<object, Set<string>>();
const rawContextClaims = new Map<string, Set<string>>();

type ProjectionState = {
  redacted: string[];
  bulk: string[];
  bulkValues: Record<string, JsonValue>;
};

/** Redact free-form model/context text before it can leave the package. */
export function redactText(value: string): string {
  return value
    .replace(HEADER_SECRET, "[REDACTED_HEADER]")
    .replace(SECRET_VALUE, (_match, quotedPrefix, _quote, _quoted, barePrefix) => `${quotedPrefix ?? barePrefix}[REDACTED]`)
    .replace(NATURAL_SECRET, (_match, secret) => _match.replace(secret, "[REDACTED]"))
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(PHONE, "[REDACTED_PHONE]")
    .replace(UUID, "[REDACTED_ID]");
}

function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function isObject(value: JsonValue): value is { [key: string]: JsonValue } { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Associate a raw event payload with its durable claim before sanitization. */
export function rememberRawWorkflowContext(raw: RawWorkflowBlockContext, claimHash: string): void {
  const key = hash(raw);
  const claims = rawContextClaims.get(key) ?? new Set<string>();
  claims.add(claimHash);
  rawContextClaims.set(key, claims);
}

function fieldClass(name: string, policy: ContextPolicy): ContextClassification | undefined {
  if (policy.secretFields?.some((field) => field.toLowerCase() === name.toLowerCase()) || SECRET_KEY.test(name)) return "secret";
  if (policy.piiFields?.some((field) => field.toLowerCase() === name.toLowerCase()) || PII_KEY.test(name)) return "pii";
  if (policy.criticalFields?.some((field) => field.toLowerCase() === name.toLowerCase())) return "critical-constraint";
  if (policy.bulkFields?.some((field) => field.toLowerCase() === name.toLowerCase())) return "bulk-artifact";
  return undefined;
}

function project(value: JsonValue, policy: ContextPolicy, path: string, state: ProjectionState): JsonValue {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item, index) => project(item, policy, `${path}[${index}]`, state));
  if (!isObject(value)) return value;
  const output: { [key: string]: JsonValue } = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    const classification = fieldClass(key, policy);
    if (classification === "secret" || classification === "pii") {
      state.redacted.push(childPath);
      continue;
    }
    if (classification === "bulk-artifact") {
      state.bulk.push(childPath);
      state.bulkValues[childPath] = project(child, { ...policy, bulkFields: [] }, childPath, state);
      continue;
    }
    output[key] = project(child, policy, childPath, state);
  }
  return output;
}

function projectValue(value: JsonValue, policy: ContextPolicy, label: string): { value: JsonValue; state: ProjectionState } {
  const state: ProjectionState = { redacted: [], bulk: [], bulkValues: {} };
  return { value: project(value, policy, label, state), state };
}

function safeArtifactRef(raw: ArtifactRef, policy: ContextPolicy, sourceStage: string): ArtifactRef {
  return {
    path: `artifact://${hash({ path: raw.path, bytes: raw.bytes, source_stage: sourceStage })}`,
    media_type: raw.media_type,
    bytes: raw.bytes,
    source_stage: sourceStage,
    redaction_policy_version: policy.redactionPolicyVersion ?? policy.redactionPolicy,
    allowed_readers: [...(policy.allowedArtifactReaders ?? ["sme-stage"])],
  };
}

/** Write a redacted, package-owned artifact and an authoritative ACL sidecar. */
export function writeSafeArtifact(value: JsonValue, artifactDir: string, name: string, policy: ContextPolicy, sourceStage?: string): ArtifactRef {
  const projected = projectValue(value, policy, name).value;
  const content = JSON.stringify(projected, null, 2);
  mkdirSync(artifactDir, { recursive: true });
  const root = resolve(artifactDir);
  const contentHash = hash(projected);
  const policyVersion = policy.redactionPolicyVersion ?? policy.redactionPolicy;
  const readers = [...(policy.allowedArtifactReaders ?? ["sme-stage"])] as string[];
  const safeName = `artifact-${hash(name).slice(0, 12)}`;
  const fileHash = hash({ content_hash: contentHash, policy_version: policyVersion, source_stage: sourceStage, allowed_readers: readers });
  const path = join(root, `${safeName}-${fileHash.slice(0, 16)}.json`);
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  writeFileSync(`${path}.acl.json`, JSON.stringify({ path: basename(path), root, allowed_readers: readers, content_hash: contentHash }), { encoding: "utf8", mode: 0o600 });
  return { path, label: safeName, media_type: "application/json", bytes: Buffer.byteLength(content), source_stage: sourceStage, redaction_policy_version: policyVersion, allowed_readers: readers, artifact_root: root };
}

/** Read a package-owned artifact after checking the authoritative sidecar ACL and content hash. */
export function readSafeArtifact(ref: ArtifactRef, reader: string): string {
  if (!ref.path || ref.path.startsWith("artifact://") || !ref.artifact_root) throw new Error("artifact is not package-readable");
  const root = realpathSync(resolve(ref.artifact_root));
  const canonical = realpathSync(resolve(ref.path));
  if (canonical === root || !canonical.startsWith(`${root}/`) || !/^artifact-[0-9a-f]{12}-[0-9a-f]{16}\.json$/i.test(basename(canonical))) throw new Error("artifact is not package-readable");
  const acl = JSON.parse(readFileSync(`${canonical}.acl.json`, "utf8")) as { path?: string; root?: string; allowed_readers?: string[]; content_hash?: string };
  if (acl.path !== basename(canonical) || acl.root !== root || !Array.isArray(acl.allowed_readers) || !acl.allowed_readers.includes(reader) || (ref.allowed_readers && !ref.allowed_readers.includes(reader))) throw new Error("artifact reader is not authorized");
  const content = readFileSync(canonical, "utf8");
  let parsed: JsonValue;
  try { parsed = JSON.parse(content) as JsonValue; } catch { throw new Error("artifact is not package-readable"); }
  if (!acl.content_hash || acl.content_hash !== hash(parsed)) throw new Error("artifact integrity check failed");
  return content;
}

/** Mark a context as trusted only after package persistence or the airlock created it. */
export function markTrustedWorkflowContext(context: TrustedWorkflowBlockContext, claims?: Iterable<string>): TrustedWorkflowBlockContext {
  const copy = { ...context };
  trustedContextProofs.set(copy, hash(copy));
  const claimSet = new Set(claims ?? []);
  if (claimSet.size) trustedContextClaims.set(copy, claimSet);
  return copy;
}

export function trustedContextClaimHashes(context: TrustedWorkflowBlockContext | undefined): ReadonlySet<string> {
  return trustedContextClaims.get(context as object) ?? new Set<string>();
}

/** Check the private airlock proof and the immutable context value. */
export function isAirlockedWorkflowContext(context: TrustedWorkflowBlockContext | undefined): boolean {
  if (!context || typeof context !== "object") return false;
  const proof = trustedContextProofs.get(context as object);
  return Boolean(proof && proof === hash(context));
}

/** The only raw-to-trusted transition in the package. */
export function sanitize_workflow_context(raw: RawWorkflowBlockContext, policy: ContextPolicy): Result<TrustedWorkflowBlockContext, SanitizationError> {
  try {
    if (!raw || typeof raw !== "object" || !raw.workflow_run_id || !raw.stage_id || !raw.blocked_reason) return { ok: false, error: { kind: "NoMeaningfulContent", message: "blocked context has no meaningful identity or reason" } };
    const maxInlineBytes = policy.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
    const input = projectValue(raw.raw_input, policy, "raw_input");
    const output = projectValue(raw.raw_output, policy, "raw_output");
    const blockedReason = redactText(raw.blocked_reason);
    const meaningful = Boolean(blockedReason.trim() || JSON.stringify(input.value) !== "{}" || JSON.stringify(output.value) !== "{}");
    if (!meaningful) return { ok: false, error: { kind: "NoMeaningfulContent", message: "blocked context has no meaningful content" } };
    if (byteLength(input.value) + byteLength(output.value) + byteLength(blockedReason) > maxInlineBytes) return { ok: false, error: { kind: "ContextTooLarge", message: "sanitized context exceeds the inline size limit" } };
    const safeArtifacts: ArtifactRef[] = (raw.artifacts ?? []).filter((artifact) => Boolean(artifact?.path)).map((artifact) => safeArtifactRef(artifact, policy, raw.stage_id));
    const bulkValues = { ...input.state.bulkValues, ...output.state.bulkValues };
    if (Object.keys(bulkValues).length) {
      if (!policy.artifactDir) return { ok: false, error: { kind: "SanitizationFailed", message: "bulk context requires a package artifact directory" } };
      safeArtifacts.push(writeSafeArtifact(bulkValues, policy.artifactDir, "blocked-context-bulk", { ...policy, bulkFields: [] }, raw.stage_id));
    }
    const claims = rawContextClaims.get(hash(raw));
    return { ok: true, value: markTrustedWorkflowContext({ workflow_run_id: raw.workflow_run_id, stage_id: raw.stage_id, blocked_reason: blockedReason, sanitized_input: input.value, sanitized_output: output.value, safe_artifacts: safeArtifacts }, claims) };
  } catch (cause) {
    return { ok: false, error: { kind: "SanitizationFailed", message: cause instanceof Error ? cause.message : String(cause) } };
  }
}

export function govern_workflow_context(request: ContextGovernanceRequest): Result<ContextGovernancePlan, ContextGovernanceError> {
  try {
    if (!request || request.approved !== true) return { ok: false, error: { kind: "PolicyInvalid", message: "context governance requires explicit approval" } };
    const policy = request.policy ?? { redactionPolicy: "strict", artifactFirst: true, redactionPolicyVersion: "strict-v1" };
    if (!policy.redactionPolicy || typeof policy.artifactFirst !== "boolean") return { ok: false, error: { kind: "PolicyInvalid", message: "context policy is invalid" } };
    const fields = request.fields ?? [];
    const allowed: ContextClassification[] = ["secret", "pii", "critical-constraint", "compact-summary", "bulk-artifact"];
    if (fields.some(({ classification }) => !allowed.includes(classification))) return { ok: false, error: { kind: "ClassificationInvalid", message: "unknown context classification" } };
    const classifications = fields.map(({ name, classification }) => ({ name, classification }));
    const protectedFields = classifications.filter((item) => item.classification === "critical-constraint").map((item) => item.name);
    const redactedFields = classifications.filter((item) => item.classification === "secret" || item.classification === "pii").map((item) => item.name);
    const keepContext = (request.critical_fields ?? protectedFields).filter((name) => !redactedFields.includes(name));
    return { ok: true, value: {
      workflow_run_id: request.workflow_run_id,
      stage_id: request.stage_id,
      classifications,
      protected_fields: protectedFields,
      redacted_fields: redactedFields,
      artifact_fields: classifications.filter((item) => item.classification === "bulk-artifact").map((item) => item.name),
      keep_context: keepContext,
      redaction_policy_version: policy.redactionPolicyVersion ?? policy.redactionPolicy,
      artifact_first: policy.artifactFirst,
    } };
  } catch (cause) {
    return { ok: false, error: { kind: "GovernanceFailed", message: cause instanceof Error ? cause.message : String(cause) } };
  }
}

export function renderKeepContext(lines: string[]): string { return ["<keepContext>", ...lines, "</keepContext>"].join("\n"); }
export function redactJson(value: JsonValue, policy: ContextPolicy): JsonValue { return projectValue(value, policy, "value").value; }
