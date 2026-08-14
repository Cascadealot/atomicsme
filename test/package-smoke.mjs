import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const workflowSource = join(root, "workflows", "sme-orchestrator.ts");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const declaredEntries = Object.keys(manifest.exports).map((entry) =>
  entry === "." ? manifest.name : `${manifest.name}/${entry.slice(2)}`,
);
const workflowEntry = `${manifest.name}/dist/workflows/sme-orchestrator.js`;
const requiredEntries = [
  manifest.name,
  `${manifest.name}/dist/extensions/index.js`,
  workflowEntry,
];
const consumer = await mkdtemp(join(tmpdir(), "atomic-sme-consumer-"));
let archive;

async function run(command, args, cwd, timeout = 120_000) {
  const execution = execFileAsync(command, args, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  execution.child?.stdin?.end();
  return execution;
}

try {
  const source = await readFile(workflowSource, "utf8");
  if (!source.includes('from "@bastani/atomic/workflows"')) {
    throw new Error("workflow source is not using @bastani/atomic/workflows");
  }
  if (/from\s+["']@bastani\/workflows["']/.test(source)) {
    throw new Error("workflow source regressed to @bastani/workflows");
  }
  for (const entry of requiredEntries) {
    if (!declaredEntries.includes(entry)) throw new Error(`missing declared entry point: ${entry}`);
  }

  await rm(dist, { recursive: true, force: true });
  const { stdout: packStdout } = await run("npm", ["pack", "--json"], root);
  const packResult = JSON.parse(packStdout);
  archive = resolve(root, packResult[0].filename);
  await access(archive);

  const directWorkflow = await import(pathToFileURL(join(dist, "workflows", "sme-orchestrator.js")));
  if (directWorkflow.default === undefined) {
    throw new Error("direct workflow import has no default export");
  }

  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  await run("npm", ["install", "--no-audit", "--no-fund", "--package-lock=false", archive], consumer);
  await writeFile(join(consumer, "import-entries.mjs"), `
const entries = ${JSON.stringify(declaredEntries)};
const loaded = new Map();
for (const entry of entries) loaded.set(entry, await import(entry));
if (loaded.get(${JSON.stringify(workflowEntry)})?.default === undefined) {
  throw new Error("installed workflow entry has no default export");
}
console.log(\`imported \${entries.length} package entries\`);
`);
  const { stdout } = await run("node", ["import-entries.mjs"], consumer);
  process.stdout.write(stdout);

  const installedPackage = join(consumer, "node_modules", "@bastani", "atomic-sme");
  const atomicCli = join(consumer, "node_modules", "@bastani", "atomic", "dist", "cli.js");
  const { stdout: workflowStdout, stderr: workflowStderr } = await run(process.execPath, [
    atomicCli,
    "--offline",
    "--approve",
    "--no-session",
    "--no-builtin-tools",
    "-e",
    installedPackage,
    "-p",
    "/workflow list",
  ], consumer, 30_000);
  const workflowOutput = `${workflowStdout}\n${workflowStderr}`;
  if (!workflowOutput.includes("sme-orchestrator")) {
    throw new Error("Atomic did not discover the installed sme-orchestrator workflow");
  }
  if (/IMPORT_FAILED|INVALID_DEFINITION/.test(workflowOutput)) {
    throw new Error("Atomic reported an installed workflow load failure");
  }
} finally {
  if (archive !== undefined) await rm(archive, { force: true });
  await rm(consumer, { recursive: true, force: true });
  await rm(dist, { recursive: true, force: true });
}
