import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
import type { RescueAdapterStatus } from "../src/types.js";
const INTEGRATION_MODE = "intercom-rescue";
const DISABLED_REASON = "Atomic 0.9.12 does not expose a blocked-stage extension hook.";
/**
 * Disabled rescue adapter.
 *
 * Atomic 0.9.12 exposes no workflow_stage_blocked or blocked-stage extension
 * event. This extension therefore registers inspection/configuration tools only;
 * it never listens to an invented event and never resumes a workflow.
 */
export default function atomicSMEExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "sme_rescue_status",
    label: "SME rescue status",
    description: "Show whether the Atomic SME blocked-stage rescue adapter is enabled.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "Atomic SME rescue is disabled: Atomic 0.9.12 has no blocked-stage extension hook." }],
        details: {
          enabled: false,
          hook_available: false,
          reason: DISABLED_REASON,
          integration_mode: INTEGRATION_MODE,
        },
      };
    },
  });

  // Inspection is intentionally not exposed as a user-facing tool here.
  // Atomic 0.9.12 offers no verified authority provider; accepting a caller
  // supplied orchestration id would create a fail-open audit capability.
  /*
  pi.registerTool({
    name: "sme_inspect",
    label: "Inspect SME orchestration",
    description: "Inspect one authorized durable SME orchestration by id.",
    parameters: Type.Object({ orchestration_id: Type.String(), workflow_run_id: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: "SME inspection is unavailable without a verified authority provider." }], details: { found: false, orchestration_id: params.orchestration_id } };
    },
  });
  */

  pi.registerCommand("sme-rescue", {
    description: "Report the disabled Atomic SME rescue adapter status",
    handler: async (_args, ctx) => {
      ctx.ui.notify("SME rescue remains disabled: no Atomic blocked-stage hook is available.", "info");
    },
  });
}

export const rescueAdapterStatus: RescueAdapterStatus = {
  enabled: false,
  hook_available: false,
  reason: DISABLED_REASON,
};
