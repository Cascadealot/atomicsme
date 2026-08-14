import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/**
 * Explicit opt-in wrapper workflow. It is not a rescue hook and has no direct
 * resume effect; package callers must invoke the domain doors in src/doors.ts.
 */
export default workflow({
  name: "sme-orchestrator",
  description: "Prepare a bounded SME strategy from a trusted context; rescue is disabled.",
  inputs: {
    trusted_context: Type.String({ description: "Path to a package-owned trusted context artifact." }),
    artifact_dir: Type.String({ default: ".atomic/workflows/runs/sme-orchestrator" }),
  },
  outputs: {
    status: Type.String(),
    context_artifact: Type.String(),
  },
  run: async (ctx) => {
    const statusPath = `${String(ctx.inputs.artifact_dir)}/rescue-status.json`;
    await ctx.tool("record-disabled-rescue-status", { path: statusPath }, async () => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(String(ctx.inputs.artifact_dir), { recursive: true });
      await fs.writeFile(statusPath, JSON.stringify({
        enabled: false,
        hook_available: false,
        reason: "Atomic 0.9.12 exposes no blocked-stage extension hook.",
        trusted_context: String(ctx.inputs.trusted_context),
      }, null, 2));
      return { written: true };
    });
    return { status: "disabled", context_artifact: statusPath };
  },
});
