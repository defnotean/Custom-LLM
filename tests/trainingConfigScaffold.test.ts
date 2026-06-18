import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production training config scaffolds", () => {
  it("keeps the Axolotl config on Qwen3 QLoRA with the production mixture", async () => {
    const body = await readFile("training/configs/axolotl/qwen3-qlora-sft.yaml", "utf8");
    expect(body).toContain("base_model: Qwen/Qwen3-4B-Instruct-2507");
    expect(body).toContain("adapter: qlora");
    expect(body).toContain("load_in_4bit: true");
    expect(body).toContain("chat_template: qwen3");
    expect(body).toContain("type: chat_template");
    expect(body).toContain("training/data/mixtures/production-sft.train.jsonl");
    expect(body).toContain("training/data/mixtures/production-sft.validation.jsonl");
    expect(body).toContain("sample_packing: true");
    expect(body).toContain("gradient_checkpointing: true");
    expect(body).toContain("train_on_inputs: false");
    expect(body).toContain("roles_to_train:");
    expect(body).toContain("- assistant");
    expect(body).toContain("train_on_eos: turn");
  });

  it("keeps the Axolotl DPO config on prompt pairs and QLoRA", async () => {
    const body = await readFile("training/configs/axolotl/qwen3-qlora-dpo.yaml", "utf8");
    expect(body).toContain("rl: dpo");
    expect(body).toContain("base_model: Qwen/Qwen3-4B-Instruct-2507");
    expect(body).toContain("adapter: qlora");
    expect(body).toContain("load_in_4bit: true");
    expect(body).toContain("type: chatml.prompt_pairs");
    expect(body).toContain("training/data/preferences/production-dpo.train.jsonl");
    expect(body).toContain("training/data/preferences/production-dpo.validation.jsonl");
    expect(body).toContain("dpo_beta: 0.1");
  });

  it("keeps the Unsloth config pointed at the same production mixture", async () => {
    const body = await readFile("training/configs/unsloth/qwen3_qlora_sft.py", "utf8");
    expect(body).toContain("FastLanguageModel");
    expect(body).toContain("unsloth/Qwen3-4B-Instruct-2507-bnb-4bit");
    expect(body).toContain("load_in_4bit=True");
    expect(body).toContain("assistant_only_loss=True");
    expect(body).toContain("packing=True");
    expect(body).toContain("training/data/mixtures/production-sft.train.jsonl");
    expect(body).toContain("training/data/mixtures/production-sft.validation.jsonl");
    expect(body).toContain("optim=\"adamw_8bit\"");
  });

  it("keeps the Unsloth DPO config pointed at the preference mixture", async () => {
    const body = await readFile("training/configs/unsloth/qwen3_dpo.py", "utf8");
    expect(body).toContain("DPOTrainer");
    expect(body).toContain("DPOConfig");
    expect(body).toContain("unsloth/Qwen3-4B-Instruct-2507-bnb-4bit");
    expect(body).toContain("load_in_4bit=True");
    expect(body).toContain("training/data/preferences/production-dpo.train.jsonl");
    expect(body).toContain("training/data/preferences/production-dpo.validation.jsonl");
    expect(body).toContain("beta=0.1");
  });

  it("keeps the scratch checkpoint knowledge evaluator wired to the promoted tiny run", async () => {
    const body = await readFile("training/evaluate_tiny_transformer_lm.py", "utf8");
    expect(body).toContain("training/runs/tiny-transformer-iter4-byte/tiny_transformer_lm.pt");
    expect(body).toContain("training/evals/knowledge.eval.jsonl");
    expect(body).toContain("tiny-transformer.predictions.jsonl");
    expect(body).toContain("SimpleTokenizer");
    expect(body).toContain("TinyTransformerLM");
  });
});
