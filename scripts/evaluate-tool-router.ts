import { writeFile } from "node:fs/promises";
import { buildToolRegistry } from "../src/tools";
import {
  evaluateToolRouter,
  type ToolRouterEvalStrategyName,
} from "../src/training/eval/ToolRouterEvalSuite";

interface Args {
  suite: string;
  out: string;
  strategy: ToolRouterEvalStrategyName;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await evaluateToolRouter(args.suite, buildToolRegistry(), args.strategy);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(args.out, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(body);
}

function parseArgs(argv: string[]): Args {
  let suite = "training/evals/tool-router.eval.jsonl";
  let out = "training/evals/tool-router-keyword.report.json";
  let strategy: ToolRouterEvalStrategyName = "keyword";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--suite") suite = requireValue(argv[++index], arg);
    else if (arg === "--out") out = requireValue(argv[++index], arg);
    else if (arg === "--strategy") strategy = parseStrategy(requireValue(argv[++index], arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { suite, out, strategy };
}

function parseStrategy(value: string): ToolRouterEvalStrategyName {
  if (value === "keyword" || value === "hashing-embedding") return value;
  throw new Error(`Unknown strategy: ${value}`);
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
