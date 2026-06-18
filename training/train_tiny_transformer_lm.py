#!/usr/bin/env python3
"""Tiny tokenized Transformer LM trained from random weights.

This is the first scalable architecture baseline after the NumPy char smoke
model. It intentionally uses a simple local tokenizer and PyTorch CPU/GPU
autodiff so the training loop stays inspectable and reproducible.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import time
from collections import Counter
from pathlib import Path
from typing import Iterable

import torch
import torch.nn as nn
import torch.nn.functional as F


SPECIAL_TOKENS = ["<pad>", "<unk>", "<bos>", "<eos>", "<|system|>", "<|user|>", "<|assistant|>", "<|end|>"]
BYTE_TOKENS = [f"<byte:{index:02x}>" for index in range(256)]
TOKEN_RE = re.compile(r"<\|[^|]+\|>|[A-Za-z]+(?:'[A-Za-z]+)?|\d+|[^\sA-Za-z\d]", re.UNICODE)
BYTE_TOKEN_RE = re.compile(r"^<byte:([0-9a-f]{2})>$")


def main() -> None:
    args = parse_args()
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    device = torch.device(args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    train_texts = load_chatml_texts(Path(args.train), limit=args.max_train_records)
    val_texts = load_chatml_texts(Path(args.val), limit=args.max_val_records)
    vocab = build_vocab(train_texts, args.vocab_size, args.tokenizer_mode)
    tokenizer = SimpleTokenizer(vocab, tokenizer_mode=args.tokenizer_mode)
    train_token_ids, train_loss_mask_values = encode_chatml_records(
        Path(args.train),
        tokenizer,
        loss_scope=args.loss_scope,
        limit=args.max_train_records,
    )
    val_token_ids, val_loss_mask_values = encode_chatml_records(
        Path(args.val),
        tokenizer,
        loss_scope=args.loss_scope,
        limit=args.max_val_records,
    )
    train_ids = torch.tensor(train_token_ids, dtype=torch.long)
    val_ids = torch.tensor(val_token_ids, dtype=torch.long)
    train_loss_mask = torch.tensor(train_loss_mask_values, dtype=torch.float32)
    val_loss_mask = torch.tensor(val_loss_mask_values, dtype=torch.float32)
    if train_ids.numel() <= args.block_size + 1:
        raise ValueError(f"Training token stream too small: {train_ids.numel()} tokens")
    if args.loss_scope == "assistant" and train_loss_mask.sum().item() <= 0:
        raise ValueError("Assistant-loss training found no assistant target tokens in the training split")

    model = TinyTransformerLM(
        vocab_size=len(vocab),
        block_size=args.block_size,
        n_embd=args.n_embd,
        n_head=args.n_head,
        n_layer=args.n_layer,
        dropout=args.dropout,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    history: list[dict[str, float | int]] = []
    best_val_loss = float("inf")
    best_checkpoint_step = 0
    best_checkpoint_path = out_dir / "tiny_transformer_lm.best.pt"
    start_time = time.time()
    for step in range(1, args.steps + 1):
        model.train()
        xb, yb, mb = sample_batch(
            train_ids,
            train_loss_mask,
            args.block_size,
            args.batch_size,
            device,
            require_loss_tokens=args.loss_scope == "assistant",
        )
        _, loss = model(xb, yb, mb)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
        optimizer.step()

        if step == 1 or step % args.eval_every == 0 or step == args.steps:
            losses = estimate_losses(model, train_ids, train_loss_mask, val_ids, val_loss_mask, args, device)
            history.append({"step": step, "train_loss": losses["train"], "val_loss": losses["val"]})
            if losses["val"] < best_val_loss:
                best_val_loss = losses["val"]
                best_checkpoint_step = step
                torch.save(checkpoint_payload(model, vocab, args), best_checkpoint_path)
            print(f"step={step:04d} train_loss={losses['train']:.4f} val_loss={losses['val']:.4f}")

    sample_prompt = "<|user|> Can you explain what this bot does? <|assistant|>"
    sample = tokenizer.decode(
        generate(
            model,
            encode_generation_prompt(tokenizer, sample_prompt),
            max_new_tokens=args.sample_tokens,
            block_size=args.block_size,
            temperature=args.temperature,
            top_k=args.top_k,
            suppress_token_ids=[tokenizer.unk] if args.suppress_unk else [],
            device=device,
        ),
    )

    checkpoint_path = out_dir / "tiny_transformer_lm.pt"
    torch.save(checkpoint_payload(model, vocab, args), checkpoint_path)
    vocab_path = out_dir / "vocab.json"
    vocab_path.write_text(json.dumps({"tokens": vocab}, indent=2), encoding="utf8")
    tokenizer_path = out_dir / "tokenizer_config.json"
    tokenizer_path.write_text(
        json.dumps(
            {
                "type": "regex_wordpunct",
                "mode": args.tokenizer_mode,
                "pattern": TOKEN_RE.pattern,
                "special_tokens": SPECIAL_TOKENS,
                "byte_tokens": BYTE_TOKENS if args.tokenizer_mode == "byte-fallback" else [],
            },
            indent=2,
        ),
        encoding="utf8",
    )

    metrics = {
        "model": "tiny_pytorch_transformer_lm",
        "seed": args.seed,
        "device": str(device),
        "train_path": args.train,
        "val_path": args.val,
        "train_sha256": sha256_file(Path(args.train)),
        "val_sha256": sha256_file(Path(args.val)),
        "train_records": len(train_texts),
        "val_records": len(val_texts),
        "train_tokens": int(train_ids.numel()),
        "val_tokens": int(val_ids.numel()),
        "train_loss_tokens": int(train_loss_mask.sum().item()),
        "val_loss_tokens": int(val_loss_mask.sum().item()),
        "vocab_size": len(vocab),
        "parameters": sum(p.numel() for p in model.parameters()),
        "elapsed_seconds": round(time.time() - start_time, 3),
        "best_checkpoint_step": best_checkpoint_step,
        "best_checkpoint_val_loss": best_val_loss,
        "config": {
            "block_size": args.block_size,
            "n_embd": args.n_embd,
            "n_head": args.n_head,
            "n_layer": args.n_layer,
            "dropout": args.dropout,
            "batch_size": args.batch_size,
            "steps": args.steps,
            "lr": args.lr,
            "eval_every": args.eval_every,
            "vocab_size": args.vocab_size,
            "tokenizer_mode": args.tokenizer_mode,
            "suppress_unk": args.suppress_unk,
            "loss_scope": args.loss_scope,
        },
        "history": history,
        "sample": sample,
        "artifacts": {
            "checkpoint": str(checkpoint_path),
            "bestCheckpoint": str(best_checkpoint_path),
            "vocab": str(vocab_path),
            "tokenizer": str(tokenizer_path),
        },
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf8")
    (out_dir / "sample.txt").write_text(sample, encoding="utf8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a tiny tokenized Transformer LM from scratch.")
    parser.add_argument("--train", default="training/data/processed/sft.train.jsonl")
    parser.add_argument("--val", default="training/data/processed/sft.validation.jsonl")
    parser.add_argument("--out-dir", default="training/runs/tiny-transformer-iter1")
    parser.add_argument("--steps", type=int, default=400)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--block-size", type=int, default=64)
    parser.add_argument("--n-embd", type=int, default=96)
    parser.add_argument("--n-head", type=int, default=4)
    parser.add_argument("--n-layer", type=int, default=2)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--eval-every", type=int, default=100)
    parser.add_argument("--eval-batches", type=int, default=12)
    parser.add_argument("--grad-clip", type=float, default=1.0)
    parser.add_argument("--vocab-size", type=int, default=8192)
    parser.add_argument("--max-train-records", type=int, default=2500)
    parser.add_argument("--max-val-records", type=int, default=345)
    parser.add_argument("--sample-tokens", type=int, default=120)
    parser.add_argument("--temperature", type=float, default=0.9)
    parser.add_argument("--top-k", type=int, default=40)
    parser.add_argument("--tokenizer-mode", default="wordpunct", choices=["wordpunct", "byte-fallback"])
    parser.add_argument("--suppress-unk", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--loss-scope", default="all", choices=["all", "assistant"])
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    return parser.parse_args()


def checkpoint_payload(model: "TinyTransformerLM", vocab: list[str], args: argparse.Namespace) -> dict:
    return {
        "model_state_dict": model.state_dict(),
        "config": model.config,
        "vocab": vocab,
        "args": vars(args),
    }


def load_chatml_texts(path: Path, limit: int | None = None) -> list[str]:
    texts: list[str] = []
    with path.open("r", encoding="utf8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            pieces: list[str] = []
            for message in row.get("messages", []):
                role = message.get("role", "unknown")
                content = str(message.get("content", "")).strip()
                if content:
                    pieces.append(f"<|{role}|> {content}")
            pieces.append("<|end|>")
            texts.append(" ".join(pieces))
            if limit is not None and len(texts) >= limit:
                break
    return texts


def encode_chatml_records(
    path: Path,
    tokenizer: "SimpleTokenizer",
    loss_scope: str,
    limit: int | None = None,
) -> tuple[list[int], list[float]]:
    ids: list[int] = []
    loss_mask: list[float] = []
    records = 0
    with path.open("r", encoding="utf8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            record_ids, record_mask = encode_chatml_record(row, tokenizer, loss_scope)
            ids.extend(record_ids)
            loss_mask.extend(record_mask)
            records += 1
            if limit is not None and records >= limit:
                break

    if len(ids) != len(loss_mask):
        raise ValueError(f"Internal loss-mask mismatch for {path}: ids={len(ids)} mask={len(loss_mask)}")
    return ids, loss_mask


def encode_chatml_record(row: dict, tokenizer: "SimpleTokenizer", loss_scope: str) -> tuple[list[int], list[float]]:
    all_loss = loss_scope == "all"
    ids = [tokenizer.bos]
    loss_mask = [1.0 if all_loss else 0.0]
    last_role = ""

    for message in row.get("messages", []):
        role = str(message.get("role", "unknown"))
        content = str(message.get("content", "")).strip()
        if not content:
            continue
        last_role = role
        marker_ids = tokenizer.encode_tokens(f"<|{role}|>")
        content_ids = tokenizer.encode_tokens(content)
        ids.extend(marker_ids)
        loss_mask.extend([1.0 if all_loss else 0.0] * len(marker_ids))
        ids.extend(content_ids)
        content_loss = all_loss or role == "assistant"
        loss_mask.extend([1.0 if content_loss else 0.0] * len(content_ids))

    terminal_loss = all_loss or (loss_scope == "assistant" and last_role == "assistant")
    end_ids = tokenizer.encode_tokens("<|end|>")
    ids.extend(end_ids)
    loss_mask.extend([1.0 if terminal_loss else 0.0] * len(end_ids))
    ids.append(tokenizer.eos)
    loss_mask.append(1.0 if terminal_loss else 0.0)
    return ids, loss_mask


def build_vocab(texts: Iterable[str], vocab_size: int, tokenizer_mode: str) -> list[str]:
    counts: Counter[str] = Counter()
    for text in texts:
        counts.update(tokenize(text))
    vocab = list(SPECIAL_TOKENS)
    if tokenizer_mode == "byte-fallback":
        vocab.extend(BYTE_TOKENS)
    if vocab_size < len(vocab):
        raise ValueError(f"vocab_size={vocab_size} is too small for required tokenizer tokens: {len(vocab)}")
    for token, _ in counts.most_common(max(0, vocab_size - len(vocab))):
        if token not in vocab:
            vocab.append(token)
    return vocab


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text)


class SimpleTokenizer:
    def __init__(self, vocab: list[str], tokenizer_mode: str) -> None:
        self.vocab = vocab
        self.stoi = {token: index for index, token in enumerate(vocab)}
        self.itos = {index: token for token, index in self.stoi.items()}
        self.unk = self.stoi["<unk>"]
        self.bos = self.stoi["<bos>"]
        self.eos = self.stoi["<eos>"]
        self.byte_fallback = tokenizer_mode == "byte-fallback"
        self.byte_ids = {index: self.stoi[token] for index, token in enumerate(BYTE_TOKENS) if token in self.stoi}
        if self.byte_fallback and len(self.byte_ids) != len(BYTE_TOKENS):
            raise ValueError("byte-fallback tokenizer requires all byte tokens in the vocabulary")

    def encode(self, text: str) -> list[int]:
        ids = [self.bos]
        ids.extend(self.encode_tokens(text))
        ids.append(self.eos)
        return ids

    def encode_tokens(self, text: str) -> list[int]:
        ids: list[int] = []
        for token in tokenize(text):
            ids.extend(self.encode_token(token))
        return ids

    def encode_token(self, token: str) -> list[int]:
        if token in self.stoi:
            return [self.stoi[token]]
        if self.byte_fallback:
            return [self.byte_ids[item] for item in token.encode("utf8")]
        return [self.unk]

    def encode_many(self, texts: Iterable[str]) -> list[int]:
        ids: list[int] = []
        for text in texts:
            ids.extend(self.encode(text))
        return ids

    def decode(self, ids: Iterable[int]) -> str:
        tokens = [self.itos.get(int(item), "<unk>") for item in ids]
        out: list[str] = []
        byte_buffer: list[int] = []
        no_space_before = set(".,!?;:)]}%")
        no_space_after = set("([{")

        def append_piece(piece: str) -> None:
            if piece.startswith("<|") and piece.endswith("|>"):
                out.append(f"\n{piece} ")
            elif not out or piece in no_space_before:
                out.append(piece)
            elif out[-1] in no_space_after:
                out.append(piece)
            else:
                out.append(f" {piece}")

        def flush_bytes() -> None:
            if not byte_buffer:
                return
            append_piece(bytearray(byte_buffer).decode("utf8", errors="replace"))
            byte_buffer.clear()

        for token in tokens:
            if token in {"<bos>", "<eos>", "<pad>"}:
                continue
            byte_match = BYTE_TOKEN_RE.match(token)
            if byte_match:
                byte_buffer.append(int(byte_match.group(1), 16))
                continue
            flush_bytes()
            append_piece(token)
        flush_bytes()
        return "".join(out).strip()


def encode_generation_prompt(tokenizer: SimpleTokenizer, text: str) -> list[int]:
    return [tokenizer.bos, *tokenizer.encode_tokens(text)]


class CausalSelfAttention(nn.Module):
    def __init__(self, n_embd: int, n_head: int, dropout: float) -> None:
        super().__init__()
        if n_embd % n_head != 0:
            raise ValueError("n_embd must be divisible by n_head")
        self.n_head = n_head
        self.head_dim = n_embd // n_head
        self.qkv = nn.Linear(n_embd, 3 * n_embd)
        self.proj = nn.Linear(n_embd, n_embd)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        batch, time_steps, channels = x.shape
        qkv = self.qkv(x)
        q, k, v = qkv.split(channels, dim=2)
        q = q.view(batch, time_steps, self.n_head, self.head_dim).transpose(1, 2)
        k = k.view(batch, time_steps, self.n_head, self.head_dim).transpose(1, 2)
        v = v.view(batch, time_steps, self.n_head, self.head_dim).transpose(1, 2)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        mask = torch.triu(torch.ones(time_steps, time_steps, device=x.device, dtype=torch.bool), diagonal=1)
        att = att.masked_fill(mask, float("-inf"))
        att = self.dropout(F.softmax(att, dim=-1))
        y = att @ v
        y = y.transpose(1, 2).contiguous().view(batch, time_steps, channels)
        return self.proj(y)


class Block(nn.Module):
    def __init__(self, n_embd: int, n_head: int, dropout: float) -> None:
        super().__init__()
        self.ln1 = nn.LayerNorm(n_embd)
        self.attn = CausalSelfAttention(n_embd, n_head, dropout)
        self.ln2 = nn.LayerNorm(n_embd)
        self.mlp = nn.Sequential(
            nn.Linear(n_embd, 4 * n_embd),
            nn.GELU(),
            nn.Linear(4 * n_embd, n_embd),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        return x + self.mlp(self.ln2(x))


class TinyTransformerLM(nn.Module):
    def __init__(self, vocab_size: int, block_size: int, n_embd: int, n_head: int, n_layer: int, dropout: float) -> None:
        super().__init__()
        self.config = {
            "vocab_size": vocab_size,
            "block_size": block_size,
            "n_embd": n_embd,
            "n_head": n_head,
            "n_layer": n_layer,
            "dropout": dropout,
        }
        self.block_size = block_size
        self.token_embedding = nn.Embedding(vocab_size, n_embd)
        self.position_embedding = nn.Embedding(block_size, n_embd)
        self.blocks = nn.Sequential(*[Block(n_embd, n_head, dropout) for _ in range(n_layer)])
        self.ln_f = nn.LayerNorm(n_embd)
        self.lm_head = nn.Linear(n_embd, vocab_size)

    def forward(
        self,
        idx: torch.Tensor,
        targets: torch.Tensor | None = None,
        target_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor | None]:
        batch, time_steps = idx.shape
        if time_steps > self.block_size:
            raise ValueError(f"Sequence length {time_steps} exceeds block size {self.block_size}")
        pos = torch.arange(0, time_steps, device=idx.device)
        x = self.token_embedding(idx) + self.position_embedding(pos)[None, :, :]
        x = self.blocks(x)
        logits = self.lm_head(self.ln_f(x))
        loss = None
        if targets is not None:
            token_losses = F.cross_entropy(
                logits.reshape(batch * time_steps, -1),
                targets.reshape(batch * time_steps),
                reduction="none",
            )
            if target_mask is None:
                loss = token_losses.mean()
            else:
                flat_mask = target_mask.reshape(batch * time_steps).to(dtype=token_losses.dtype)
                loss = (token_losses * flat_mask).sum() / flat_mask.sum().clamp_min(1.0)
        return logits, loss


def sample_batch(
    ids: torch.Tensor,
    loss_mask: torch.Tensor,
    block_size: int,
    batch_size: int,
    device: torch.device,
    require_loss_tokens: bool = False,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    if ids.numel() != loss_mask.numel():
        raise ValueError(f"ids/loss_mask length mismatch: {ids.numel()} vs {loss_mask.numel()}")
    max_start = ids.numel() - block_size - 1
    if max_start < 0:
        raise ValueError(f"Token stream too small for block_size={block_size}: {ids.numel()} tokens")
    starts: list[int] = []
    for _ in range(batch_size):
        start = int(torch.randint(0, max_start + 1, (1,)).item())
        if require_loss_tokens:
            for _ in range(100):
                candidate = int(torch.randint(0, max_start + 1, (1,)).item())
                if loss_mask[candidate + 1 : candidate + block_size + 1].sum().item() > 0:
                    start = candidate
                    break
        starts.append(start)
    x = torch.stack([ids[start : start + block_size] for start in starts]).to(device)
    y = torch.stack([ids[start + 1 : start + block_size + 1] for start in starts]).to(device)
    target_mask = torch.stack([loss_mask[start + 1 : start + block_size + 1] for start in starts]).to(device)
    return x, y, target_mask


@torch.no_grad()
def estimate_losses(
    model: TinyTransformerLM,
    train_ids: torch.Tensor,
    train_loss_mask: torch.Tensor,
    val_ids: torch.Tensor,
    val_loss_mask: torch.Tensor,
    args: argparse.Namespace,
    device: torch.device,
) -> dict[str, float]:
    model.eval()
    out: dict[str, float] = {}
    for split, ids, loss_mask in [("train", train_ids, train_loss_mask), ("val", val_ids, val_loss_mask)]:
        losses = []
        for _ in range(args.eval_batches):
            xb, yb, mb = sample_batch(
                ids,
                loss_mask,
                args.block_size,
                args.batch_size,
                device,
                require_loss_tokens=args.loss_scope == "assistant",
            )
            _, loss = model(xb, yb, mb)
            if loss is not None:
                losses.append(float(loss.item()))
        out[split] = float(sum(losses) / len(losses))
    return out


@torch.no_grad()
def generate(
    model: TinyTransformerLM,
    seed_ids: list[int],
    max_new_tokens: int,
    block_size: int,
    temperature: float,
    top_k: int,
    suppress_token_ids: list[int],
    device: torch.device,
) -> list[int]:
    model.eval()
    ids = torch.tensor([seed_ids], dtype=torch.long, device=device)
    for _ in range(max_new_tokens):
        context = ids[:, -block_size:]
        logits, _ = model(context)
        logits = logits[:, -1, :] / max(temperature, 1e-4)
        for token_id in suppress_token_ids:
            if 0 <= token_id < logits.size(-1):
                logits[:, token_id] = -float("inf")
        if top_k > 0:
            values, _ = torch.topk(logits, min(top_k, logits.size(-1)))
            logits[logits < values[:, [-1]]] = -float("inf")
        probs = F.softmax(logits, dim=-1)
        next_id = torch.multinomial(probs, num_samples=1)
        ids = torch.cat((ids, next_id), dim=1)
    return ids[0].tolist()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
