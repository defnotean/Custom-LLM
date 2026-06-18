import { buildToolRegistry } from "../src/tools";
import { writeToolEvalSuite } from "../src/training/eval/ToolEvalSuite";

async function main(): Promise<void> {
  const path = parsePath(process.argv.slice(2));
  const summary = await writeToolEvalSuite(path, buildToolRegistry());
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

function parsePath(argv: string[]): string {
  let path = "training/evals/tool-routing.eval.jsonl";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--out") {
      const value = argv[++index];
      if (!value) throw new Error("--out requires a path");
      path = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return path;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
