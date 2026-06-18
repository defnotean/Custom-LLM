import { readFile, stat } from "node:fs/promises";

const axolotlConfig = "training/configs/axolotl/qwen3-qlora-sft.yaml";
const axolotlDpoConfig = "training/configs/axolotl/qwen3-qlora-dpo.yaml";
const unslothConfig = "training/configs/unsloth/qwen3_qlora_sft.py";
const unslothDpoConfig = "training/configs/unsloth/qwen3_dpo.py";
const preferenceDatasetPaths = [
  "training/data/preferences/production-dpo.train.jsonl",
  "training/data/preferences/production-dpo.validation.jsonl",
];

async function main(): Promise<void> {
  const axolotl = await readFile(axolotlConfig, "utf8");
  const axolotlDpo = await readFile(axolotlDpoConfig, "utf8");
  const unsloth = await readFile(unslothConfig, "utf8");
  const unslothDpo = await readFile(unslothDpoConfig, "utf8");
  const datasetPaths = uniquePaths([...extractYamlPaths(axolotl), ...extractYamlPaths(axolotlDpo), ...preferenceDatasetPaths]);

  assertIncludes(axolotl, "base_model: Qwen/Qwen3-4B-Instruct-2507", axolotlConfig);
  assertIncludes(axolotl, "adapter: qlora", axolotlConfig);
  assertIncludes(axolotl, "load_in_4bit: true", axolotlConfig);
  assertIncludes(axolotl, "chat_template: qwen3", axolotlConfig);
  assertIncludes(axolotl, "type: chat_template", axolotlConfig);
  assertIncludes(axolotl, "sample_packing: true", axolotlConfig);
  assertIncludes(axolotl, "gradient_checkpointing: true", axolotlConfig);
  assertIncludes(axolotl, "train_on_inputs: false", axolotlConfig);
  assertIncludes(axolotl, "roles_to_train:", axolotlConfig);
  assertIncludes(axolotl, "- assistant", axolotlConfig);
  assertIncludes(axolotl, "train_on_eos: turn", axolotlConfig);

  assertIncludes(axolotlDpo, "rl: dpo", axolotlDpoConfig);
  assertIncludes(axolotlDpo, "base_model: Qwen/Qwen3-4B-Instruct-2507", axolotlDpoConfig);
  assertIncludes(axolotlDpo, "adapter: qlora", axolotlDpoConfig);
  assertIncludes(axolotlDpo, "load_in_4bit: true", axolotlDpoConfig);
  assertIncludes(axolotlDpo, "type: chatml.prompt_pairs", axolotlDpoConfig);
  assertIncludes(axolotlDpo, "training/data/preferences/production-dpo.train.jsonl", axolotlDpoConfig);
  assertIncludes(axolotlDpo, "training/data/preferences/production-dpo.validation.jsonl", axolotlDpoConfig);
  assertIncludes(axolotlDpo, "dpo_beta: 0.1", axolotlDpoConfig);

  assertIncludes(unsloth, "FastLanguageModel", unslothConfig);
  assertIncludes(unsloth, "unsloth/Qwen3-4B-Instruct-2507-bnb-4bit", unslothConfig);
  assertIncludes(unsloth, "load_in_4bit=True", unslothConfig);
  assertIncludes(unsloth, "assistant_only_loss=True", unslothConfig);
  assertIncludes(unsloth, "packing=True", unslothConfig);
  assertIncludes(unsloth, "training/data/mixtures/production-sft.train.jsonl", unslothConfig);
  assertIncludes(unsloth, "training/data/mixtures/production-sft.validation.jsonl", unslothConfig);

  assertIncludes(unslothDpo, "DPOTrainer", unslothDpoConfig);
  assertIncludes(unslothDpo, "DPOConfig", unslothDpoConfig);
  assertIncludes(unslothDpo, "unsloth/Qwen3-4B-Instruct-2507-bnb-4bit", unslothDpoConfig);
  assertIncludes(unslothDpo, "load_in_4bit=True", unslothDpoConfig);
  assertIncludes(unslothDpo, "training/data/preferences/production-dpo.train.jsonl", unslothDpoConfig);
  assertIncludes(unslothDpo, "training/data/preferences/production-dpo.validation.jsonl", unslothDpoConfig);
  assertIncludes(unslothDpo, "beta=0.1", unslothDpoConfig);

  for (const datasetPath of datasetPaths) {
    await assertNonEmpty(datasetPath);
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        status: "ok",
        axolotlConfig,
        axolotlDpoConfig,
        unslothConfig,
        unslothDpoConfig,
        datasetPaths,
      },
      null,
      2,
    ),
  );
}

function assertIncludes(body: string, needle: string, path: string): void {
  if (!body.includes(needle)) throw new Error(`${path} is missing required text: ${needle}`);
}

function extractYamlPaths(body: string): string[] {
  return [...body.matchAll(/^\s*-?\s*path:\s*(.+?)\s*$/gm)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => value.startsWith("training/data/mixtures/") || value.startsWith("training/data/preferences/"));
}

async function assertNonEmpty(path: string): Promise<void> {
  const info = await stat(path);
  if (info.size <= 0) throw new Error(`Expected non-empty dataset file: ${path}`);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
