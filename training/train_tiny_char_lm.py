#!/usr/bin/env python3
"""Tiny from-scratch character LM for pipeline smoke tests.

This is intentionally small: a NumPy n-gram neural language model with manual
backprop. It proves the repo can acquire data, prepare splits, train a model,
measure validation loss, and save reproducible artifacts before spending GPU
time on QLoRA or larger from-scratch experiments.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Iterable

import numpy as np


def main() -> None:
    args = parse_args()
    rng = np.random.default_rng(args.seed)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    train_text = load_chatml_text(Path(args.train))
    val_text = load_chatml_text(Path(args.val))
    if len(train_text) < args.context + 2:
        raise ValueError(f"Training text is too small for context={args.context}: {len(train_text)} chars")

    chars = sorted(set(train_text + val_text))
    stoi = {ch: i for i, ch in enumerate(chars)}
    itos = {i: ch for ch, i in stoi.items()}
    train_ids = np.array([stoi[ch] for ch in train_text], dtype=np.int64)
    val_ids = np.array([stoi[ch] for ch in val_text], dtype=np.int64) if val_text else train_ids

    params = init_model(len(chars), args.context, args.d_model, args.hidden, rng)
    optimizer = init_adam(params)

    history: list[dict[str, float | int]] = []
    for step in range(1, args.steps + 1):
        x, y = sample_batch(train_ids, args.context, args.batch_size, rng)
        loss, grads = loss_and_grads(params, x, y)
        clip_grads(grads, args.grad_clip)
        adam_step(params, grads, optimizer, args.lr, step)

        if step == 1 or step % args.eval_every == 0 or step == args.steps:
            val_loss = estimate_loss(params, val_ids, args.context, args.batch_size, args.eval_batches, rng)
            history.append({"step": step, "train_loss": float(loss), "val_loss": float(val_loss)})
            print(f"step={step:04d} train_loss={loss:.4f} val_loss={val_loss:.4f}")

    seed_text = "<|user|>\nCan you explain what this bot does?\n<|assistant|>\n"
    sample = generate(params, seed_text, stoi, itos, args.context, args.sample_chars, rng, args.temperature)

    checkpoint_path = out_dir / "tiny_char_lm.npz"
    np.savez_compressed(checkpoint_path, **params)

    vocab_path = out_dir / "vocab.json"
    vocab_path.write_text(json.dumps({"itos": [itos[i] for i in range(len(itos))]}, indent=2), encoding="utf8")

    metrics = {
        "model": "tiny_numpy_char_ngram_lm",
        "seed": args.seed,
        "train_path": args.train,
        "val_path": args.val,
        "train_sha256": sha256_file(Path(args.train)),
        "val_sha256": sha256_file(Path(args.val)),
        "train_chars": len(train_text),
        "val_chars": len(val_text),
        "vocab_size": len(chars),
        "parameters": parameter_count(params),
        "config": {
            "context": args.context,
            "d_model": args.d_model,
            "hidden": args.hidden,
            "batch_size": args.batch_size,
            "steps": args.steps,
            "lr": args.lr,
            "eval_every": args.eval_every,
        },
        "history": history,
        "sample": sample,
        "artifacts": {
            "checkpoint": str(checkpoint_path),
            "vocab": str(vocab_path),
        },
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf8")
    (out_dir / "sample.txt").write_text(sample, encoding="utf8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a tiny NumPy character LM from scratch.")
    parser.add_argument("--train", default="training/data/processed/sft.train.jsonl")
    parser.add_argument("--val", default="training/data/processed/sft.validation.jsonl")
    parser.add_argument("--out-dir", default="training/runs/tiny-char-lm")
    parser.add_argument("--steps", type=int, default=300)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--context", type=int, default=64)
    parser.add_argument("--d-model", type=int, default=32)
    parser.add_argument("--hidden", type=int, default=128)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--eval-every", type=int, default=50)
    parser.add_argument("--eval-batches", type=int, default=8)
    parser.add_argument("--grad-clip", type=float, default=1.0)
    parser.add_argument("--sample-chars", type=int, default=400)
    parser.add_argument("--temperature", type=float, default=0.85)
    parser.add_argument("--seed", type=int, default=1337)
    return parser.parse_args()


def load_chatml_text(path: Path) -> str:
    chunks: list[str] = []
    if not path.exists():
        return ""
    with path.open("r", encoding="utf8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            messages = row.get("messages", [])
            for message in messages:
                role = message.get("role", "unknown")
                content = str(message.get("content", "")).strip()
                if content:
                    chunks.append(f"<|{role}|>\n{content}\n")
            chunks.append("<|end|>\n")
    return "".join(chunks)


def init_model(vocab_size: int, context: int, d_model: int, hidden: int, rng: np.random.Generator) -> dict[str, np.ndarray]:
    scale = 0.02
    return {
        "E": rng.normal(0.0, scale, size=(vocab_size, d_model)).astype(np.float32),
        "W1": rng.normal(0.0, scale, size=(context * d_model, hidden)).astype(np.float32),
        "b1": np.zeros(hidden, dtype=np.float32),
        "W2": rng.normal(0.0, scale, size=(hidden, vocab_size)).astype(np.float32),
        "b2": np.zeros(vocab_size, dtype=np.float32),
    }


def init_adam(params: dict[str, np.ndarray]) -> dict[str, dict[str, np.ndarray]]:
    return {
        name: {"m": np.zeros_like(value), "v": np.zeros_like(value)}
        for name, value in params.items()
    }


def sample_batch(ids: np.ndarray, context: int, batch_size: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    max_start = len(ids) - context - 1
    starts = rng.integers(0, max_start, size=batch_size)
    x = np.stack([ids[start : start + context] for start in starts])
    y = np.array([ids[start + context] for start in starts], dtype=np.int64)
    return x, y


def forward(params: dict[str, np.ndarray], x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    emb = params["E"][x]
    flat = emb.reshape(x.shape[0], -1)
    hidden = np.tanh(flat @ params["W1"] + params["b1"])
    logits = hidden @ params["W2"] + params["b2"]
    return logits, hidden, flat


def loss_and_grads(params: dict[str, np.ndarray], x: np.ndarray, y: np.ndarray) -> tuple[float, dict[str, np.ndarray]]:
    logits, hidden, flat = forward(params, x)
    probs = softmax(logits)
    batch = x.shape[0]
    loss = -np.log(probs[np.arange(batch), y] + 1e-12).mean()

    dlogits = probs
    dlogits[np.arange(batch), y] -= 1.0
    dlogits /= batch

    grads: dict[str, np.ndarray] = {}
    grads["W2"] = hidden.T @ dlogits
    grads["b2"] = dlogits.sum(axis=0)
    dhidden = dlogits @ params["W2"].T
    dz = dhidden * (1.0 - hidden * hidden)
    grads["W1"] = flat.T @ dz
    grads["b1"] = dz.sum(axis=0)
    dflat = dz @ params["W1"].T
    demb = dflat.reshape(x.shape[0], x.shape[1], params["E"].shape[1])
    grads["E"] = np.zeros_like(params["E"])
    np.add.at(grads["E"], x, demb)
    return float(loss), grads


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def clip_grads(grads: dict[str, np.ndarray], max_norm: float) -> None:
    total = math.sqrt(sum(float((grad * grad).sum()) for grad in grads.values()))
    if total > max_norm:
        scale = max_norm / (total + 1e-8)
        for grad in grads.values():
            grad *= scale


def adam_step(
    params: dict[str, np.ndarray],
    grads: dict[str, np.ndarray],
    optimizer: dict[str, dict[str, np.ndarray]],
    lr: float,
    step: int,
) -> None:
    beta1 = 0.9
    beta2 = 0.999
    eps = 1e-8
    for name, param in params.items():
        state = optimizer[name]
        grad = grads[name]
        state["m"] = beta1 * state["m"] + (1.0 - beta1) * grad
        state["v"] = beta2 * state["v"] + (1.0 - beta2) * (grad * grad)
        m_hat = state["m"] / (1.0 - beta1**step)
        v_hat = state["v"] / (1.0 - beta2**step)
        param -= lr * m_hat / (np.sqrt(v_hat) + eps)


def estimate_loss(
    params: dict[str, np.ndarray],
    ids: np.ndarray,
    context: int,
    batch_size: int,
    batches: int,
    rng: np.random.Generator,
) -> float:
    if len(ids) <= context + 1:
        return float("nan")
    losses = []
    for _ in range(batches):
        x, y = sample_batch(ids, context, batch_size, rng)
        logits, _, _ = forward(params, x)
        probs = softmax(logits)
        losses.append(float(-np.log(probs[np.arange(batch_size), y] + 1e-12).mean()))
    return float(np.mean(losses))


def generate(
    params: dict[str, np.ndarray],
    seed_text: str,
    stoi: dict[str, int],
    itos: dict[int, str],
    context: int,
    max_new: int,
    rng: np.random.Generator,
    temperature: float,
) -> str:
    fallback = 0
    ids = [stoi.get(ch, fallback) for ch in seed_text]
    for _ in range(max_new):
        ctx = ([fallback] * context + ids)[-context:]
        logits, _, _ = forward(params, np.array([ctx], dtype=np.int64))
        probs = softmax(logits / max(temperature, 1e-4))[0]
        next_id = int(rng.choice(len(probs), p=probs))
        ids.append(next_id)
    return "".join(itos[i] for i in ids)


def parameter_count(params: dict[str, np.ndarray]) -> int:
    return int(sum(value.size for value in params.values()))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
