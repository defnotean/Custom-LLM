import {
  buildIreneSystemStatusReport,
  type IreneSystemStatusOptions,
} from "../src/training/quality/IreneSystemStatusReport";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildIreneSystemStatusReport(options);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

function parseArgs(argv: string[]): IreneSystemStatusOptions {
  const options: IreneSystemStatusOptions = { includeProductionReadiness: true };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--skip-production-readiness") options.includeProductionReadiness = false;
    else if (arg === "--run-root") options.runRoot = requireValue(argv[++index], arg);
    else if (arg === "--planned-base-params") options.plannedProductionBaseParams = parseNonnegativeInt(argv[++index], arg);
    else if (arg === "--tool-protocol-gate") options.toolProtocolGatePath = requireValue(argv[++index], arg);
    else if (arg === "--behavior-gate") options.behaviorScratchGatePath = requireValue(argv[++index], arg);
    else if (arg === "--router-gate") options.routerScratchGatePath = requireValue(argv[++index], arg);
    else if (arg === "--tool-router-gate") options.toolRouterGatePath = requireValue(argv[++index], arg);
    else if (arg === "--memory-gate") options.memoryContinuityGatePath = requireValue(argv[++index], arg);
    else if (arg === "--skill-gate") options.skillRetrievalGatePath = requireValue(argv[++index], arg);
    else if (arg === "--long-context-gate") options.longContextGatePath = requireValue(argv[++index], arg);
    else if (arg === "--voice-gate") options.voiceGatePath = requireValue(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseNonnegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a nonnegative integer`);
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
