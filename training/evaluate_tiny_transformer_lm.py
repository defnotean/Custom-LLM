#!/usr/bin/env python3
"""Run a trained tiny Transformer checkpoint against the knowledge eval suite.

This evaluates the scratch model itself, not an OpenAI-compatible server. The
output JSONL matches the TypeScript knowledge-eval runner:
{"id": "...", "output": "...", "model": "...", "latencyMs": 123}
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import torch

from train_tiny_transformer_lm import SimpleTokenizer, TinyTransformerLM, encode_generation_prompt, generate


DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful, concise assistant for a local Discord AI platform. "
    "Answer clearly, avoid making up tool results, and ask a short clarification question "
    "when the request is underspecified."
)


def main() -> None:
    args = parse_args()
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    device = torch.device(args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))

    model, tokenizer, model_name, block_size = load_checkpoint(Path(args.checkpoint), device)
    cases = load_cases(Path(args.suite))
    if args.max_cases is not None:
        cases = cases[: args.max_cases]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    with out_path.open("w", encoding="utf8") as handle:
        for case in cases:
            start = time.perf_counter()
            output = run_case(
                model=model,
                tokenizer=tokenizer,
                prompt=str(case.get("prompt", "")),
                block_size=block_size,
                sample_tokens=args.sample_tokens,
                temperature=args.temperature,
                top_k=args.top_k,
                suppress_unk=args.suppress_unk,
                device=device,
            )
            latency_ms = round((time.perf_counter() - start) * 1000, 3)
            handle.write(
                json.dumps(
                    {
                        "id": case["id"],
                        "output": output,
                        "model": model_name,
                        "latencyMs": latency_ms,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            written += 1

    print(
        json.dumps(
            {
                "status": "ok",
                "checkpoint": args.checkpoint,
                "suite": args.suite,
                "out": args.out,
                "attempted": len(cases),
                "written": written,
                "model": model_name,
                "device": str(device),
            },
            indent=2,
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a tiny Transformer checkpoint on knowledge eval JSONL.")
    parser.add_argument("--checkpoint", default="training/runs/tiny-transformer-iter4-byte/tiny_transformer_lm.pt")
    parser.add_argument("--suite", default="training/evals/knowledge.eval.jsonl")
    parser.add_argument("--out", default="training/evals/tiny-transformer.predictions.jsonl")
    parser.add_argument("--max-cases", type=int, default=None)
    parser.add_argument("--sample-tokens", type=int, default=96)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--top-k", type=int, default=25)
    parser.add_argument("--suppress-unk", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    return parser.parse_args()


def load_checkpoint(path: Path, device: torch.device) -> tuple[TinyTransformerLM, SimpleTokenizer, str, int]:
    checkpoint = torch.load(path, map_location=device, weights_only=False)
    config = checkpoint["config"]
    vocab = checkpoint["vocab"]
    checkpoint_args = checkpoint.get("args", {})
    tokenizer_mode = checkpoint_args.get("tokenizer_mode") or infer_tokenizer_mode(vocab)
    tokenizer = SimpleTokenizer(vocab, tokenizer_mode=tokenizer_mode)
    model = TinyTransformerLM(
        vocab_size=int(config["vocab_size"]),
        block_size=int(config["block_size"]),
        n_embd=int(config["n_embd"]),
        n_head=int(config["n_head"]),
        n_layer=int(config["n_layer"]),
        dropout=float(config["dropout"]),
    ).to(device)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()
    model_name = f"tiny_pytorch_transformer_lm:{path.parent.name}"
    return model, tokenizer, model_name, int(config["block_size"])


def run_case(
    model: TinyTransformerLM,
    tokenizer: SimpleTokenizer,
    prompt: str,
    block_size: int,
    sample_tokens: int,
    temperature: float,
    top_k: int,
    suppress_unk: bool,
    device: torch.device,
) -> str:
    seed_text = f"<|system|> {DEFAULT_SYSTEM_PROMPT} <|user|> {prompt.strip()} <|assistant|>"
    seed_ids = encode_generation_prompt(tokenizer, seed_text)
    generated_ids = generate(
        model,
        seed_ids,
        max_new_tokens=sample_tokens,
        block_size=block_size,
        temperature=temperature,
        top_k=top_k,
        suppress_token_ids=[tokenizer.unk] if suppress_unk else [],
        device=device,
    )
    completion_ids = generated_ids[len(seed_ids) :]
    return clean_completion(tokenizer.decode(completion_ids))


def clean_completion(text: str) -> str:
    if "<|end|>" in text:
        text = text.split("<|end|>", 1)[0]
    for marker in ["<|assistant|>", "<|user|>", "<|system|>"]:
        text = text.replace(marker, " ")
    return " ".join(text.split())


def load_cases(path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    with path.open("r", encoding="utf8") as handle:
        for line in handle:
            if line.strip():
                cases.append(json.loads(line))
    return cases


def infer_tokenizer_mode(vocab: list[str]) -> str:
    return "byte-fallback" if any(token.startswith("<byte:") for token in vocab) else "wordpunct"


if __name__ == "__main__":
    main()
