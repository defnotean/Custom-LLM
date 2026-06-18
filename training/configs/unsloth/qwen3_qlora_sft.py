#!/usr/bin/env python3
"""Unsloth QLoRA SFT entrypoint for the Custom-LLM bot.

This script is intended for a CUDA notebook/workstation with Unsloth installed,
not for the current CPU-only local smoke runs.
"""

from __future__ import annotations

import os
from pathlib import Path

from datasets import load_dataset
from trl import SFTConfig, SFTTrainer
from unsloth import FastLanguageModel, is_bfloat16_supported


BASE_MODEL = os.getenv("BASE_MODEL", "unsloth/Qwen3-4B-Instruct-2507-bnb-4bit")
TRAIN_FILE = Path(os.getenv("TRAIN_FILE", "training/data/mixtures/production-sft.train.jsonl"))
VAL_FILE = Path(os.getenv("VAL_FILE", "training/data/mixtures/production-sft.validation.jsonl"))
OUTPUT_DIR = os.getenv("OUTPUT_DIR", "training/runs/unsloth-qwen3-qlora-sft")
MAX_SEQ_LENGTH = int(os.getenv("MAX_SEQ_LENGTH", "2048"))


def main() -> None:
    if not TRAIN_FILE.exists():
        raise FileNotFoundError(f"Missing train file: {TRAIN_FILE}. Run `npm run build:sft-mixture` first.")
    if not VAL_FILE.exists():
        raise FileNotFoundError(f"Missing validation file: {VAL_FILE}. Run `npm run build:sft-mixture` first.")

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL,
        max_seq_length=MAX_SEQ_LENGTH,
        load_in_4bit=True,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        use_gradient_checkpointing="unsloth",
        random_state=2026,
    )

    dataset = load_dataset(
        "json",
        data_files={"train": str(TRAIN_FILE), "validation": str(VAL_FILE)},
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset["train"],
        eval_dataset=dataset["validation"],
        args=SFTConfig(
            output_dir=OUTPUT_DIR,
            dataset_text_field=None,
            dataset_kwargs={"skip_prepare_dataset": False},
            max_seq_length=MAX_SEQ_LENGTH,
            assistant_only_loss=True,
            packing=True,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=16,
            num_train_epochs=2,
            learning_rate=2e-4,
            warmup_ratio=0.03,
            lr_scheduler_type="cosine",
            logging_steps=10,
            eval_steps=100,
            save_steps=100,
            bf16=is_bfloat16_supported(),
            fp16=not is_bfloat16_supported(),
            optim="adamw_8bit",
            seed=2026,
            report_to=[],
        ),
    )
    trainer.train()
    trainer.save_model(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)


if __name__ == "__main__":
    main()
