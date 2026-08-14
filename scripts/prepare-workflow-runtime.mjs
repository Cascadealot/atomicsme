import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const workflowPath = resolve("dist/workflows/sme-orchestrator.js");
const compiled = await readFile(workflowPath, "utf8");
const supportedImport = 'import { workflow } from "@bastani/atomic/workflows";';

if (!compiled.includes(supportedImport)) {
  throw new Error(`compiled workflow is missing the supported ${supportedImport} import`);
}

const nodeCompatibleWorkflow = `import { createJiti } from "jiti/static"; const workflow = (() => { if (typeof require === "function") { try { return require("@bastani/workflows").workflow; } catch (error) { if (error?.code !== "MODULE_NOT_FOUND") throw error; } } return createJiti(import.meta.url, { tryNative: false })("@bastani/atomic/workflows").workflow; })();`;

await writeFile(workflowPath, compiled.replace(supportedImport, nodeCompatibleWorkflow));
