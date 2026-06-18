#!/usr/bin/env python3
"""Run a trained tiny Transformer checkpoint against the specialist-router eval suite.

This evaluates the scratch model directly, not an OpenAI-compatible server. The
output JSONL matches the TypeScript router eval runner:
{"id": "...", "output": "...", "route": "...", "model": "...", "latencyMs": 123}
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path
from typing import Any

import torch

from evaluate_tiny_transformer_lm import clean_completion, load_checkpoint
from evaluate_tiny_transformer_protocol import clean_protocol_completion
from train_tiny_transformer_lm import SimpleTokenizer, TinyTransformerLM, encode_generation_prompt, generate


ROUTER_SYSTEM_PROMPT = """You are a specialist router for a Discord AI assistant.
Choose the one best route for the user's prompt.
Routes:
- tool_protocol: requests that should be handled by tool selection, tool arguments, confirmation, or permission checks.
- knowledge: factual or explanatory answers where no external action is requested.
- persona: identity, pronouns, tone, emotional style, or how Irene should present herself.
- casual: low-stakes chat, reactions, opinions, jokes, or vibe checks with no needed tool.
- social_cue: support, celebration, repair after misunderstanding, or socially sensitive conversation.
- boundary: secrets, credential theft, account theft, evasion, or other harmful requests that require a direct boundary.
Respond with ONLY JSON: {"route":"<route>","expert":"<tool|knowledge|conversation|safety>","confidence":0.0,"reason":"short reason"}"""


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
                case=case,
                block_size=block_size,
                sample_tokens=args.sample_tokens,
                temperature=args.temperature,
                top_k=args.top_k,
                suppress_unk=args.suppress_unk,
                device=device,
            )
            latency_ms = round((time.perf_counter() - start) * 1000, 3)
            prediction: dict[str, Any] = {
                "id": case["id"],
                "output": output,
                "model": model_name,
                "latencyMs": latency_ms,
            }
            route = extract_route(output)
            if route:
                prediction["route"] = route
            handle.write(json.dumps(prediction, ensure_ascii=False) + "\n")
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
    parser = argparse.ArgumentParser(description="Evaluate a tiny Transformer checkpoint on specialist routing JSONL.")
    parser.add_argument("--checkpoint", default="training/runs/tiny-transformer-router-iter1/tiny_transformer_lm.best.pt")
    parser.add_argument("--suite", default="training/evals/specialist-routing.eval.jsonl")
    parser.add_argument("--out", default="training/evals/tiny-transformer-router.predictions.jsonl")
    parser.add_argument("--max-cases", type=int, default=None)
    parser.add_argument("--sample-tokens", type=int, default=80)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--suppress-unk", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    return parser.parse_args()


def run_case(
    model: TinyTransformerLM,
    tokenizer: SimpleTokenizer,
    case: dict[str, Any],
    block_size: int,
    sample_tokens: int,
    temperature: float,
    top_k: int,
    suppress_unk: bool,
    device: torch.device,
) -> str:
    prompt = str(case.get("prompt", "")).strip()
    seed_text = f"<|system|> {ROUTER_SYSTEM_PROMPT} <|user|> {prompt} <|assistant|>"
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
    return clean_router_completion(clean_protocol_completion(clean_completion(tokenizer.decode(completion_ids))))


def clean_router_completion(text: str) -> str:
    for key in ["route", "expert", "confidence", "reason"]:
        text = text.replace(f'" {key} "', f'"{key}"')
        text = text.replace(f'" {key}"', f'"{key}"')
        text = text.replace(f'"{key} "', f'"{key}"')
    for route in ["tool_protocol", "knowledge", "persona", "casual", "social_cue", "boundary"]:
        text = text.replace(route.replace("_", " "), route)
        text = text.replace(f'" {route} "', f'"{route}"')
    return text


def extract_route(output: str) -> str | None:
    try:
        parsed = json.loads(output)
        route = parsed.get("route")
        if isinstance(route, str):
            return normalize_route(route)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\b(tool_protocol|knowledge|persona|casual|social_cue|boundary)\b", normalize_route(output))
    return match.group(1) if match else None


def normalize_route(value: str) -> str:
    return re.sub(r"[\s-]+", "_", value.strip().lower())


def load_cases(path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    with path.open("r", encoding="utf8") as handle:
        for line in handle:
            if line.strip():
                cases.append(json.loads(line))
    return cases


if __name__ == "__main__":
    main()
