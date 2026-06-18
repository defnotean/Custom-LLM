import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface DatasetDownloadSource {
  id: string;
  name: string;
  url: string;
  outputFile: string;
  license: string;
  homepage: string;
  expectedSha256?: string;
  gated?: boolean;
  notes: string;
}

const sources: DatasetDownloadSource[] = [
  {
    id: "dolly",
    name: "Databricks Dolly 15k",
    url: "https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/main/databricks-dolly-15k.jsonl?download=true",
    outputFile: "databricks-dolly-15k.jsonl",
    license: "cc-by-sa-3.0",
    homepage: "https://huggingface.co/datasets/databricks/databricks-dolly-15k",
    expectedSha256: "2df9083338b4abd6bceb5635764dab5d833b393b55759dffb0959b6fcbf794ec",
    notes: "Human-authored instruction/response records; useful for general instruction behavior.",
  },
  {
    id: "oasst1_ready",
    name: "OpenAssistant OASST1 ready messages",
    url: "https://huggingface.co/datasets/OpenAssistant/oasst1/resolve/main/2023-04-12_oasst_ready.messages.jsonl.gz?download=true",
    outputFile: "2023-04-12_oasst_ready.messages.jsonl.gz",
    license: "apache-2.0",
    homepage: "https://huggingface.co/datasets/OpenAssistant/oasst1",
    expectedSha256: "286a6e9a5a413b3272ae9c0b5a20d327983dea1c24342ae28cb244a6da65185c",
    notes: "Human conversation-tree messages; preparation keeps reviewed English prompt/assistant pairs only.",
  },
  {
    id: "xlam_function_calling_60k",
    name: "Salesforce xLAM function calling 60k",
    url: "https://huggingface.co/datasets/Salesforce/xlam-function-calling-60k",
    outputFile: "xlam_function_calling_60k.json",
    license: "cc-by-4.0",
    homepage: "https://huggingface.co/datasets/Salesforce/xlam-function-calling-60k",
    gated: true,
    notes: "Relevant for function-calling, but Hugging Face requires accepting access conditions before download.",
  },
];

interface Args {
  outDir: string;
  force: boolean;
  selected: Set<string>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outDir, { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    outDir: args.outDir,
    sources: [] as unknown[],
  };

  for (const source of sources) {
    if (!args.selected.has(source.id)) continue;
    const outPath = join(args.outDir, source.outputFile);
    if (source.gated) {
      manifest.sources.push({ ...source, status: "gated-manual-access", path: outPath });
      // eslint-disable-next-line no-console
      console.log(`Skipping gated dataset ${source.id}; accept terms at ${source.homepage} first.`);
      continue;
    }

    const exists = await pathExists(outPath);
    if (exists && !args.force) {
      const info = await fileInfo(outPath);
      manifest.sources.push({ ...source, status: "already-present", path: outPath, ...info });
      // eslint-disable-next-line no-console
      console.log(`Already present: ${source.id} -> ${outPath}`);
      continue;
    }

    // eslint-disable-next-line no-console
    console.log(`Downloading ${source.id} -> ${outPath}`);
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`Failed to download ${source.id}: ${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(outPath, bytes);

    const info = await fileInfo(outPath);
    if (source.expectedSha256 && info.sha256 !== source.expectedSha256) {
      throw new Error(`Checksum mismatch for ${source.id}: expected ${source.expectedSha256}, got ${info.sha256}`);
    }
    manifest.sources.push({ ...source, status: "downloaded", path: outPath, ...info });
  }

  const manifestPath = join(args.outDir, "dataset_manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote manifest -> ${manifestPath}`);
}

function parseArgs(argv: string[]): Args {
  let outDir = "training/data/raw";
  let force = false;
  const selected = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      outDir = requireValue(argv[++index], "--out-dir");
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--all-open") {
      selected.add("dolly");
      selected.add("oasst1_ready");
    } else if (arg === "--include-gated") {
      selected.add("xlam_function_calling_60k");
    } else if (arg === "--source") {
      selected.add(requireValue(argv[++index], "--source"));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (selected.size === 0) selected.add("dolly");
  return { outDir, force, selected };
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileInfo(path: string): Promise<{ bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
