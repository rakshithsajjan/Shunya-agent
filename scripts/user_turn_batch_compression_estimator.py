#!/usr/bin/env python3
"""Estimate compression when a whole user-turn tool batch is summarized.

Policy:
- Keep raw tool outputs while the agent is working on the current user turn.
- When the next real user request arrives, finalize the previous tool batch.
- If that batch's combined tool-output tokens exceed the threshold, replace the
  entire batch with one fixed-size summary for future turns.

This compares normal caching, local/extractive summaries, same-turn model
summaries, and separate later model summaries.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
from dataclasses import dataclass, field
from statistics import mean


PRESETS = {
    "gpt-5.5": {"write": 5.00, "cached": 0.50, "output": 30.00},
    "gpt-5.4-mini": {"write": 0.75, "cached": 0.075, "output": 4.50},
    "claude-sonnet-4.6-5m": {"write": 3.75, "cached": 0.30, "output": 15.00},
    "claude-sonnet-4.6-1h": {"write": 6.00, "cached": 0.30, "output": 15.00},
    "gemini-2.5-flash": {"write": 0.30, "cached": 0.03, "output": 2.50},
    "grok-build-0.1": {"write": 1.00, "cached": 0.20, "output": 2.00},
}

ORIGINAL_TOKEN_RE = re.compile(r"Original token count:\s*(\d+)")
TOOL_OUTPUT_TYPES = {
    "function_call_output",
    "custom_tool_call_output",
    "tool_search_output",
}


@dataclass
class Prices:
    write: float
    cached: float
    output: float


@dataclass
class ContextItem:
    tokens: int
    replay_count: int = 0


@dataclass
class ToolBatch:
    raw_items: list[ContextItem] = field(default_factory=list)
    finalized: bool = False
    eligible: bool = False
    summary_tokens: int = 0
    summary_replay_count: int = 0
    same_turn_output_charged: bool = False
    separate_output_charged: bool = False

    @property
    def total_tokens(self) -> int:
        return sum(item.tokens for item in self.raw_items)

    @property
    def output_count(self) -> int:
        return len(self.raw_items)


@dataclass
class SessionResult:
    path: pathlib.Path
    turns: int = 0
    real_user_turns: int = 0
    tool_outputs: int = 0
    batches: int = 0
    eligible_batches: int = 0
    non_tool_items: int = 0
    compactions: int = 0
    tool_tokens: int = 0
    eligible_batch_tokens: int = 0
    non_tool_tokens: int = 0
    normal: float = 0.0
    local: float = 0.0
    same_turn: float = 0.0
    separate: float = 0.0

    @property
    def local_savings(self) -> float:
        return self.normal - self.local

    @property
    def same_turn_savings(self) -> float:
        return self.normal - self.same_turn

    @property
    def separate_savings(self) -> float:
        return self.normal - self.separate


def normalize(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def token_count(value: object, use_original_count: bool) -> int:
    text = normalize(value)
    if use_original_count:
        match = ORIGINAL_TOKEN_RE.search(text)
        if match:
            return int(match.group(1))
    return max(0, round(len(text) / 3.6))


def dollars(tokens: int, price: float) -> float:
    return tokens * price / 1_000_000


def message_text(payload: dict) -> str:
    parts: list[str] = []
    for item in payload.get("content") or []:
        if isinstance(item, dict):
            parts.append(item.get("text") or "")
    return "\n".join(parts).strip()


def is_real_user_message(payload: dict) -> bool:
    if payload.get("type") != "message" or payload.get("role") != "user":
        return False
    text = message_text(payload)
    if not text:
        return False
    if text.startswith("# AGENTS.md instructions"):
        return False
    if text.startswith("<environment_context>"):
        return False
    return True


def finalize_batch(
    batch: ToolBatch | None,
    threshold: int,
    summary_tokens: int,
    result: SessionResult,
) -> None:
    if batch is None or batch.finalized:
        return
    batch.finalized = True
    result.batches += 1
    if batch.total_tokens > threshold:
        batch.eligible = True
        batch.summary_tokens = min(summary_tokens, batch.total_tokens)
        result.eligible_batches += 1
        result.eligible_batch_tokens += batch.total_tokens


def raw_items_cost(items: list[ContextItem], prices: Prices) -> float:
    total = 0.0
    for item in items:
        price = prices.write if item.replay_count == 0 else prices.cached
        total += dollars(item.tokens, price)
    return total


def summary_cost(batch: ToolBatch, prices: Prices) -> float:
    price = prices.write if batch.summary_replay_count == 0 else prices.cached
    return dollars(batch.summary_tokens, price)


def charge_turn(
    non_tool_items: list[ContextItem],
    batches: list[ToolBatch],
    prices: Prices,
) -> tuple[float, float, float, float]:
    shared = raw_items_cost(non_tool_items, prices)
    normal = shared
    local = shared
    same_turn = shared
    separate = shared

    for batch in batches:
        raw_cost = raw_items_cost(batch.raw_items, prices)
        normal += raw_cost

        if not batch.finalized or not batch.eligible:
            local += raw_cost
            same_turn += raw_cost
            separate += raw_cost
            continue

        local += summary_cost(batch, prices)
        same_turn += summary_cost(batch, prices)
        separate += summary_cost(batch, prices)

        if not batch.same_turn_output_charged:
            same_turn += dollars(batch.summary_tokens, prices.output)
            batch.same_turn_output_charged = True

        if not batch.separate_output_charged:
            # Separate summary call rereads raw outputs once before writing the
            # summary. Raw items have already appeared in earlier turns, so this
            # is a cached read in the default after-user-turn policy.
            separate += sum(dollars(item.tokens, prices.cached) for item in batch.raw_items)
            separate += dollars(batch.summary_tokens, prices.output)
            batch.separate_output_charged = True

    for item in non_tool_items:
        item.replay_count += 1
    for batch in batches:
        for item in batch.raw_items:
            item.replay_count += 1
        if batch.finalized and batch.eligible:
            batch.summary_replay_count += 1

    return normal, local, same_turn, separate


def session_paths(inputs: list[str]) -> list[pathlib.Path]:
    if not inputs:
        codex_home = pathlib.Path.home() / ".codex"
        paths = list((codex_home / "sessions").rglob("*.jsonl"))
        paths.extend((codex_home / "archived_sessions").glob("*.jsonl"))
        return sorted(paths)

    paths: list[pathlib.Path] = []
    for raw in inputs:
        path = pathlib.Path(raw).expanduser()
        if path.is_dir():
            paths.extend(path.rglob("*.jsonl"))
        elif path.is_file():
            paths.append(path)
    return sorted(set(paths))


def scan_session(
    path: pathlib.Path,
    threshold: int,
    summary_tokens: int,
    prices: Prices,
    use_original_count: bool,
    reset_on_compaction: bool,
) -> SessionResult:
    result = SessionResult(path=path)
    non_tool_items: list[ContextItem] = []
    batches: list[ToolBatch] = []
    current_batch: ToolBatch | None = None

    with path.open(errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            record_type = record.get("type")
            if record_type == "compacted":
                result.compactions += 1
                if reset_on_compaction:
                    non_tool_items.clear()
                    batches.clear()
                    current_batch = None
                    replacement = (record.get("payload") or {}).get("replacement_history")
                    if replacement:
                        tokens = token_count(replacement, use_original_count=False)
                        result.non_tool_items += 1
                        result.non_tool_tokens += tokens
                        non_tool_items.append(ContextItem(tokens=tokens))
                continue

            if record_type == "turn_context":
                result.turns += 1
                normal, local, same_turn, separate = charge_turn(
                    non_tool_items,
                    batches,
                    prices,
                )
                result.normal += normal
                result.local += local
                result.same_turn += same_turn
                result.separate += separate
                continue

            if record_type != "response_item":
                continue

            payload = record.get("payload") or {}
            payload_type = payload.get("type")

            if is_real_user_message(payload):
                finalize_batch(current_batch, threshold, summary_tokens, result)
                current_batch = ToolBatch()
                batches.append(current_batch)
                result.real_user_turns += 1

            if payload_type in TOOL_OUTPUT_TYPES:
                value = payload.get("output") if "output" in payload else payload
                tokens = token_count(value, use_original_count)
                result.tool_outputs += 1
                result.tool_tokens += tokens
                if current_batch is None:
                    current_batch = ToolBatch()
                    batches.append(current_batch)
                current_batch.raw_items.append(ContextItem(tokens=tokens))
                continue

            if payload:
                tokens = token_count(payload, use_original_count=False)
                result.non_tool_items += 1
                result.non_tool_tokens += tokens
                non_tool_items.append(ContextItem(tokens=tokens))

    return result


def money(value: float) -> str:
    return f"${value:,.2f}"


def pct(savings: float, total: float) -> str:
    if total == 0:
        return "0.0%"
    return f"{100 * savings / total:.1f}%"


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    k = (len(values) - 1) * p / 100
    lower = int(k)
    upper = min(lower + 1, len(values) - 1)
    if lower == upper:
        return values[lower]
    return values[lower] * (upper - k) + values[upper] * (k - lower)


def print_report(args: argparse.Namespace, results: list[SessionResult]) -> None:
    if args.only_tool_sessions:
        results = [item for item in results if item.tool_outputs > 0]

    normal = sum(item.normal for item in results)
    local = sum(item.local for item in results)
    same_turn = sum(item.same_turn for item in results)
    separate = sum(item.separate for item in results)

    print("User-turn batch compression estimator")
    print("=" * 42)
    print(f"preset: {args.preset}")
    print(f"batch_threshold: {args.threshold:,} combined tool-output tokens")
    print(f"summary_tokens_per_batch: {args.summary_tokens:,}")
    print(f"reset_on_compaction: {not args.no_reset_on_compaction}")
    print(f"sessions: {len(results):,}")
    print(f"turns charged: {sum(item.turns for item in results):,}")
    print(f"real user turns: {sum(item.real_user_turns for item in results):,}")
    print(f"tool outputs: {sum(item.tool_outputs for item in results):,}")
    print(f"tool batches: {sum(item.batches for item in results):,}")
    print(f"eligible batches: {sum(item.eligible_batches for item in results):,}")
    print(f"tool tokens: {sum(item.tool_tokens for item in results):,}")
    print(f"eligible batch tool tokens: {sum(item.eligible_batch_tokens for item in results):,}")
    print()
    print("Overall cost")
    print(f"normal, raw outputs with caching: {money(normal)}")
    print(f"local/extractive batch summaries: {money(local)}")
    print(f"local savings: {money(normal - local)} ({pct(normal - local, normal)})")
    print(f"same-turn batch summaries: {money(same_turn)}")
    print(f"same-turn savings: {money(normal - same_turn)} ({pct(normal - same_turn, normal)})")
    print(f"separate batch summaries: {money(separate)}")
    print(f"separate savings: {money(normal - separate)} ({pct(normal - separate, normal)})")
    print()

    tool_sessions = [item for item in results if item.tool_outputs > 0]
    if tool_sessions:
        values = [item.same_turn_savings for item in tool_sessions]
        print("Per tool-use session same-turn batch savings")
        print(f"mean: {money(mean(values))}")
        for p in [50, 75, 90, 99]:
            print(f"p{p}: {money(percentile(values, p))}")
        print()

    top = sorted(results, key=lambda item: item.same_turn_savings, reverse=True)[
        : args.top_sessions
    ]
    if top:
        print(f"Top {len(top)} sessions by same-turn batch savings")
        for item in top:
            if item.tool_outputs == 0:
                continue
            print(
                f"- {money(item.same_turn_savings)} same-turn, "
                f"{money(item.local_savings)} local, "
                f"{money(item.separate_savings)} separate, "
                f"{item.eligible_batches:,} eligible batches: {item.path}"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="Session JSONL files or directories. Defaults to ~/.codex sessions.")
    parser.add_argument("--threshold", type=int, default=2000)
    parser.add_argument("--summary-tokens", type=int, default=300)
    parser.add_argument("--preset", choices=sorted(PRESETS), default="gpt-5.5")
    parser.add_argument("--write-price", type=float)
    parser.add_argument("--cached-price", type=float)
    parser.add_argument("--output-price", type=float)
    parser.add_argument("--use-original-count", action="store_true")
    parser.add_argument("--no-reset-on-compaction", action="store_true")
    parser.add_argument("--only-tool-sessions", action="store_true")
    parser.add_argument("--top-sessions", type=int, default=10)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.threshold < 0:
        raise SystemExit("--threshold must be non-negative")
    if args.summary_tokens < 0:
        raise SystemExit("--summary-tokens must be non-negative")
    preset = PRESETS[args.preset]
    prices = Prices(
        write=args.write_price if args.write_price is not None else preset["write"],
        cached=args.cached_price if args.cached_price is not None else preset["cached"],
        output=args.output_price if args.output_price is not None else preset["output"],
    )
    results = [
        scan_session(
            path,
            threshold=args.threshold,
            summary_tokens=args.summary_tokens,
            prices=prices,
            use_original_count=args.use_original_count,
            reset_on_compaction=not args.no_reset_on_compaction,
        )
        for path in session_paths(args.paths)
    ]
    print_report(args, results)


if __name__ == "__main__":
    main()
