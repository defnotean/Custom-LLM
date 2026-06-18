#!/usr/bin/env python3
"""Run a trained tiny Transformer checkpoint against the protocol/tool eval suite.

This evaluates the scratch model directly, not an OpenAI-compatible server. The
output JSONL matches the TypeScript protocol eval runner:
{"id": "...", "output": "...", "model": "...", "latencyMs": 123}
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
from train_tiny_transformer_lm import SimpleTokenizer, TinyTransformerLM, encode_generation_prompt, generate


DEFAULT_SYSTEM_PROMPT = (
    "You are a Discord assistant with tool access. "
    "Respond ONLY as JSON using one of: message / tool_call / confirmation_request / clarification."
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
                case=case,
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
    parser = argparse.ArgumentParser(description="Evaluate a tiny Transformer checkpoint on protocol/tool eval JSONL.")
    parser.add_argument("--checkpoint", default="training/runs/tiny-transformer-iter4-byte/tiny_transformer_lm.pt")
    parser.add_argument("--suite", default="training/evals/tool-routing.eval.jsonl")
    parser.add_argument("--out", default="training/evals/tiny-transformer-tool.predictions.jsonl")
    parser.add_argument("--max-cases", type=int, default=None)
    parser.add_argument("--sample-tokens", type=int, default=96)
    parser.add_argument("--temperature", type=float, default=0.3)
    parser.add_argument("--top-k", type=int, default=25)
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
    candidate_tools = case.get("candidateTools", [])
    tools_text = ", ".join(str(tool) for tool in candidate_tools) if candidate_tools else "none"
    eval_context = build_eval_context(case)
    tool_contract = build_candidate_tool_contract(case)
    seed_text = (
        f"<|system|> {DEFAULT_SYSTEM_PROMPT} "
        f"Candidate tools: {tools_text}. "
        "Only use candidate tools listed here; never call a tool outside this list. "
        f"{tool_contract} "
        f"{eval_context} "
        f"<|user|> {prompt} "
        f"<|assistant|>"
    )
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
    return clean_protocol_completion(clean_completion(tokenizer.decode(completion_ids)))


def build_candidate_tool_contract(case: dict[str, Any]) -> str:
    metadata = case.get("metadata", {})
    candidate_tools = case.get("candidateTools", [])
    tool = metadata.get("tool") if isinstance(metadata, dict) else None
    if not isinstance(tool, str) and isinstance(candidate_tools, list) and candidate_tools:
        tool = str(candidate_tools[0])
    if isinstance(tool, str) and isinstance(candidate_tools, list) and tool in candidate_tools:
        return (
            "Candidate tool contract: when a tool_call or confirmation_request is allowed for this prompt, "
            f"copy the tool name exactly as {tool}."
        )
    return ""


def build_eval_context(case: dict[str, Any]) -> str:
    metadata = case.get("metadata", {})
    if not isinstance(metadata, dict):
        return ""
    lines: list[str] = []
    candidate_tools = case.get("candidateTools", [])
    if isinstance(candidate_tools, list) and len(candidate_tools) == 0:
        lines.append("No candidate tools are available. Return message, not tool_call.")
    tool = metadata.get("tool")
    if not isinstance(tool, str) and isinstance(candidate_tools, list) and candidate_tools:
        tool = str(candidate_tools[0])
    required_args = string_list(metadata.get("requiredArgs"))
    missing_arg = metadata.get("missingArg")
    provided_args = metadata.get("providedArgs")
    if isinstance(tool, str) and required_args:
        lines.append(
            f"Required arguments for {tool}: {', '.join(required_args)}. "
            "If required details are missing, return clarification; if they are present, tool_call may be allowed."
        )
        if isinstance(provided_args, dict) and all(key in provided_args for key in required_args):
            lines.append(
                "This request provides "
                f"{arguments_prompt_text(provided_args)}. Treat required details as present; "
                "do not ask for clarification unless another required detail is absent."
            )
        elif isinstance(missing_arg, str):
            lines.append(
                f"This request is missing required argument {missing_arg}. Return clarification, not tool_call."
            )
    required_permissions = string_list(metadata.get("requiredPermissions"))
    member_permissions = string_list(metadata.get("memberPermissions"))
    lacks_required_permissions = len(required_permissions) > 0 and len(member_permissions) == 0
    if required_permissions:
        if lacks_required_permissions:
            lines.append(
                "Invoking member lacks required permissions: "
                f"{', '.join(required_permissions)}. Return message, not tool_call or confirmation_request."
            )
        else:
            lines.append(
                f"Invoking member has required permissions: {', '.join(member_permissions)}. Do not refuse for permissions."
            )
    if metadata.get("requiresConfirmation") is True and not lacks_required_permissions:
        if metadata.get("confirmed") is True:
            lines.append("User already confirmed this risky action; tool_call is allowed. Do not ask for confirmation again.")
        else:
            lines.append("This risky tool requires confirmation before execution. Return confirmation_request, not tool_call.")
    return " ".join(lines)


def string_list(value: Any) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def arguments_prompt_text(args: dict[str, Any]) -> str:
    return ", ".join(f"{key}={format_prompt_value(value)}" for key, value in args.items())


def format_prompt_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return str(value).lower()
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def load_cases(path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    with path.open("r", encoding="utf8") as handle:
        for line in handle:
            if line.strip():
                cases.append(json.loads(line))
    return cases


def clean_protocol_completion(text: str) -> str:
    """Undo scratch-tokenizer spacing that breaks JSON key/value literals."""
    text = normalize_quoted_json_tokens(text)
    for key in ["type", "tool", "arguments", "content", "pending_tool_call", "pendingtoolcall"]:
        text = text.replace(f'"{key}"{key}":', f'"{key}":')
        text = text.replace(f'"{key}" "{key}":', f'"{key}":')
        text = text.replace(f'"{key}" "{key}" :', f'"{key}":')
        text = re.sub(rf'"{re.escape(key)}"\s*{re.escape(key)}\s*"\s*:', f'"{key}":', text)
        text = re.sub(rf'"{re.escape(key)}"\s*"?\s*{re.escape(key)}\s*"?\s*:', f'"{key}":', text)
    text = normalize_quoted_json_tokens(text)
    text = re.sub(
        r'("type"\s*:\s*"(?:message|clarification)"\s*,)[^{}]*?("content"\s*:)',
        r"\1 \2",
        text,
    )
    for key in ["type", "tool", "arguments", "content", "pendingtoolcall"]:
        text = text.replace(f'" {key} "', f'"{key}"')
        text = text.replace(f'" {key}"', f'"{key}"')
        text = text.replace(f'"{key} "', f'"{key}"')
    for value in ["message", "toolcall", "confirmationrequest", "clarification"]:
        text = text.replace(f'" {value} "', f'"{value}"')
        text = text.replace(f'" {value}"', f'"{value}"')
        text = text.replace(f'"{value} "', f'"{value}"')
    text = text.replace('"toolcall"', '"tool_call"')
    text = text.replace('"tool _ call"', '"tool_call"')
    text = text.replace('"tool_ call"', '"tool_call"')
    text = text.replace('"tool _call"', '"tool_call"')
    text = text.replace('"confirmationrequest"', '"confirmation_request"')
    text = text.replace('"confirmation _ request"', '"confirmation_request"')
    text = text.replace('"confirmation_ request"', '"confirmation_request"')
    text = text.replace('"confirmation _request"', '"confirmation_request"')
    text = text.replace('"pendingtoolcall"', '"pending_tool_call"')
    text = text.replace('"pending _ tool _ call"', '"pending_tool_call"')
    text = text.replace('"pending_ tool_ call"', '"pending_tool_call"')
    return text


def normalize_quoted_json_tokens(text: str) -> str:
    return re.sub(r'"([^"\\]*(?:\\.[^"\\]*)*)"', normalize_quoted_json_token, text)


def normalize_quoted_json_token(match: re.Match[str]) -> str:
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError:
        value = match.group(1)
    if not isinstance(value, str):
        return match.group(0)
    value = " ".join(value.split())
    value = re.sub(r"\s*_\s*", "_", value).strip()
    return json.dumps(value, ensure_ascii=False)


if __name__ == "__main__":
    main()
