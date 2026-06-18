#!/usr/bin/env python3
"""Unsloth/TRL QLoRA DPO entrypoint for the Custom-LLM bot.

This script is intended for a CUDA notebook/workstation with Unsloth, TRL,
datasets, and peft installed. It consumes explicit prompt/chosen/rejected
JSONL built by `npm run build:preference-mixture`.
"""

from __future__ import annotations

import os
from pathlib import Path

from datasets import load_dataset
from trl import DPOConfig, DPOTrainer
from unsloth import FastLanguageModel, is_bfloat16_supported


BASE_MODEL = os.getenv("BASE_MODEL", "unsloth/Qwen3-4B-Instruct-2507-bnb-4bit")
TRAIN_FILE = Path(os.getenv("TRAIN_FILE", "training/data/preferences/production-dpo.train.jsonl"))
VAL_FILE = Path(os.getenv("VAL_FILE", "training/data/preferences/production-dpo.validation.jsonl"))
OUTPUT_DIR = os.getenv("OUTPUT_DIR", "training/runs/unsloth-qwen3-qlora-dpo")
MAX_SEQ_LENGTH = int(os.getenv("MAX_SEQ_LENGTH", "2048"))


def main() -> None:
    if not TRAIN_FILE.exists():
        raise FileNotFoundError(f"Missing train file: {TRAIN_FILE}. Run `npm run build:preference-mixture` first.")
    if not VAL_FILE.exists():
        raise FileNotFoundError(f"Missing validation file: {VAL_FILE}. Run `npm run build:preference-mixture` first.")

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

    trainer = DPOTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=dataset["train"],
        eval_dataset=dataset["validation"],
        args=DPOConfig(
            output_dir=OUTPUT_DIR,
            max_length=MAX_SEQ_LENGTH,
            max_prompt_length=1024,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=16,
            num_train_epochs=1,
            learning_rate=1e-5,
            beta=0.1,
            warmup_ratio=0.03,
            lr_scheduler_type="cosine",
            logging_steps=5,
            eval_steps=25,
            save_steps=25,
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
