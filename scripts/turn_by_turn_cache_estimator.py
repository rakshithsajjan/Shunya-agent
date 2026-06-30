#!/usr/bin/env python3
"""Turn-by-turn cache cost estimator for Codex tool-output compression.

This compares two worlds with caching enabled:

1. normal: every tool output stays raw
2. compressed: large tool outputs stay raw for N model calls, then become a
   fixed-size summary

Costs are charged at each `turn_context` as the session log is replayed.
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib
import re
from dataclasses import dataclass, field
from statistics import mean


PRESETS = {
    # Dollars per 1M tokens.
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
class ActiveOutput:
    tokens: int
    summary_tokens: int
    eligible: bool
    tool_output: bool
    replay_count: int = 0


@dataclass
class TurnCost:
    session: pathlib.Path
    turn_index: int
    normal: float
    compressed_local: float
    compressed_model: float
    active_outputs: int
    eligible_active_outputs: int


@dataclass
class SessionResult:
    path: pathlib.Path
    turns: int = 0
    tool_outputs: int = 0
    eligible_outputs: int = 0
    non_tool_items: int = 0
    compactions: int = 0
    total_tool_tokens: int = 0
    eligible_tool_tokens: int = 0
    total_non_tool_tokens: int = 0
    normal: float = 0.0
    compressed_local: float = 0.0
    compressed_model: float = 0.0
    turn_costs: list[TurnCost] = field(default_factory=list)

    @property
    def local_savings(self) -> float:
        return self.normal - self.compressed_local

    @property
    def model_savings(self) -> float:
        return self.normal - self.compressed_model


def normalize_output(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def token_count(value: object, use_original_count: bool) -> int:
    text = normalize_output(value)
    if use_original_count:
        match = ORIGINAL_TOKEN_RE.search(text)
        if match:
            return int(match.group(1))
    return max(0, round(len(text) / 3.6))


def dollars(tokens: int, price_per_million: float) -> float:
    return tokens * price_per_million / 1_000_000


def cost_for_turn(
    active: list[ActiveOutput],
    prices: Prices,
    raw_use_replays: int,
) -> tuple[float, float, float]:
    normal = 0.0
    local = 0.0
    model = 0.0

    for output in active:
        raw_price = prices.write if output.replay_count == 0 else prices.cached
        normal += dollars(output.tokens, raw_price)

        if not output.tool_output or not output.eligible:
            local += dollars(output.tokens, raw_price)
            model += dollars(output.tokens, raw_price)
            continue

        if output.replay_count < raw_use_replays:
            raw_cost = dollars(output.tokens, raw_price)
            local += raw_cost
            model += raw_cost
            continue

        summary_replay_count = output.replay_count - raw_use_replays
        summary_price = prices.write if summary_replay_count == 0 else prices.cached
        summary_cost = dollars(output.summary_tokens, summary_price)
        local += summary_cost
        model += summary_cost

        if summary_replay_count == 0:
            # If a model creates the summary, it must read the raw output once
            # and emit summary tokens. With the default raw_use_replays=1, that
            # raw read is cached; with immediate compression it is a write.
            summarize_read_price = (
                prices.write if output.replay_count == 0 else prices.cached
            )
            model += dollars(output.tokens, summarize_read_price)
            model += dollars(output.summary_tokens, prices.output)

    return normal, local, model


def scan_session(
    path: pathlib.Path,
    threshold: int,
    summary_tokens: int,
    raw_use_replays: int,
    prices: Prices,
    use_original_count: bool,
    reset_on_compaction: bool,
) -> SessionResult:
    result = SessionResult(path=path)
    active: list[ActiveOutput] = []

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
                    active.clear()
                    replacement = (record.get("payload") or {}).get("replacement_history")
                    if replacement:
                        tokens = token_count(replacement, use_original_count=False)
                        result.non_tool_items += 1
                        result.total_non_tool_tokens += tokens
                        active.append(
                            ActiveOutput(
                                tokens=tokens,
                                summary_tokens=tokens,
                                eligible=False,
                                tool_output=False,
                            )
                        )
                continue

            if record_type == "turn_context":
                result.turns += 1
                normal, local, model = cost_for_turn(
                    active,
                    prices=prices,
                    raw_use_replays=raw_use_replays,
                )
                result.normal += normal
                result.compressed_local += local
                result.compressed_model += model
                result.turn_costs.append(
                    TurnCost(
                        session=path,
                        turn_index=result.turns,
                        normal=normal,
                        compressed_local=local,
                        compressed_model=model,
                        active_outputs=len(active),
                        eligible_active_outputs=sum(1 for item in active if item.eligible),
                    )
                )
                for output in active:
                    output.replay_count += 1
                continue

            if record_type != "response_item":
                continue

            payload = record.get("payload") or {}
            if payload.get("type") not in TOOL_OUTPUT_TYPES:
                if payload:
                    tokens = token_count(payload, use_original_count=False)
                    result.non_tool_items += 1
                    result.total_non_tool_tokens += tokens
                    active.append(
                        ActiveOutput(
                            tokens=tokens,
                            summary_tokens=tokens,
                            eligible=False,
                            tool_output=False,
                        )
                    )
                continue

            output_value = payload.get("output") if "output" in payload else payload
            tokens = token_count(output_value, use_original_count)
            eligible = tokens >= threshold
            result.tool_outputs += 1
            result.total_tool_tokens += tokens
            if eligible:
                result.eligible_outputs += 1
                result.eligible_tool_tokens += tokens

            active.append(
                ActiveOutput(
                    tokens=tokens,
                    summary_tokens=min(summary_tokens, tokens),
                    eligible=eligible,
                    tool_output=True,
                )
            )

    return result


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


def fmt_money(value: float) -> str:
    return f"${value:,.2f}"


def pct(part: float, whole: float) -> str:
    if whole == 0:
        return "0.0%"
    return f"{100 * part / whole:.1f}%"


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


def write_turn_csv(path: pathlib.Path, results: list[SessionResult]) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "session",
                "turn_index",
                "normal_cost",
                "compressed_local_cost",
                "compressed_model_cost",
                "local_savings",
                "model_savings",
                "active_outputs",
                "eligible_active_outputs",
            ]
        )
        for result in results:
            for turn in result.turn_costs:
                writer.writerow(
                    [
                        str(turn.session),
                        turn.turn_index,
                        f"{turn.normal:.10f}",
                        f"{turn.compressed_local:.10f}",
                        f"{turn.compressed_model:.10f}",
                        f"{turn.normal - turn.compressed_local:.10f}",
                        f"{turn.normal - turn.compressed_model:.10f}",
                        turn.active_outputs,
                        turn.eligible_active_outputs,
                    ]
                )


def print_report(args: argparse.Namespace, prices: Prices, results: list[SessionResult]) -> None:
    if args.only_tool_sessions:
        results = [item for item in results if item.tool_outputs > 0]

    normal = sum(item.normal for item in results)
    local = sum(item.compressed_local for item in results)
    model = sum(item.compressed_model for item in results)
    turns = sum(item.turns for item in results)
    tool_outputs = sum(item.tool_outputs for item in results)
    eligible_outputs = sum(item.eligible_outputs for item in results)
    non_tool_items = sum(item.non_tool_items for item in results)
    compactions = sum(item.compactions for item in results)
    total_tokens = sum(item.total_tool_tokens for item in results)
    eligible_tokens = sum(item.eligible_tool_tokens for item in results)
    total_non_tool_tokens = sum(item.total_non_tool_tokens for item in results)

    print("Turn-by-turn tool-output cache estimator")
    print("=" * 44)
    print(f"preset: {args.preset}")
    print(f"threshold: {args.threshold:,} tokens")
    print(f"summary_tokens: {args.summary_tokens:,}")
    print(f"raw_use_replays before compression: {args.raw_use_replays:,}")
    print(f"reset_on_compaction: {not args.no_reset_on_compaction}")
    print(f"token source: {'Original token count when present' if args.use_original_count else 'stored payload estimate'}")
    print(f"sessions: {len(results):,}")
    print(f"turns charged: {turns:,}")
    print(f"tool outputs: {tool_outputs:,}")
    print(f"eligible outputs: {eligible_outputs:,}")
    print(f"non-tool context items: {non_tool_items:,}")
    print(f"compactions observed: {compactions:,}")
    print(f"total tool-output tokens: {total_tokens:,}")
    print(f"eligible tool-output tokens: {eligible_tokens:,}")
    print(f"total non-tool context tokens: {total_non_tool_tokens:,}")
    print()
    print("Prices ($/1M tokens)")
    print(f"first appearance/cache write: {prices.write:g}")
    print(f"cached read: {prices.cached:g}")
    print(f"summary output: {prices.output:g}")
    print()
    print("Overall cost")
    print(f"normal, raw outputs with caching: {fmt_money(normal)}")
    print(f"our tech, local/extractive summaries: {fmt_money(local)}")
    print(f"local/extractive savings: {fmt_money(normal - local)} ({pct(normal - local, normal)})")
    print(f"our tech, model-generated summaries: {fmt_money(model)}")
    print(f"model-generated savings: {fmt_money(normal - model)} ({pct(normal - model, normal)})")
    print()

    nonzero = [item for item in results if item.tool_outputs]
    session_local_savings = [item.local_savings for item in nonzero]
    if session_local_savings:
        print("Per tool-use session local savings")
        print(f"mean: {fmt_money(mean(session_local_savings))}")
        for p in [50, 75, 90, 99]:
            print(f"p{p}: {fmt_money(percentile(session_local_savings, p))}")
        print()

    top = sorted(results, key=lambda item: item.local_savings, reverse=True)[: args.top_sessions]
    if top:
        print(f"Top {len(top)} sessions by local/extractive savings")
        for item in top:
            if item.tool_outputs == 0:
                continue
            print(
                f"- {fmt_money(item.local_savings)} local, "
                f"{fmt_money(item.model_savings)} model, "
                f"{item.eligible_outputs:,} eligible outputs, "
                f"{item.turns:,} turns: {item.path}"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="Session JSONL files or directories. Defaults to ~/.codex sessions.")
    parser.add_argument("--threshold", type=int, default=2000)
    parser.add_argument("--summary-tokens", type=int, default=300)
    parser.add_argument("--raw-use-replays", type=int, default=1)
    parser.add_argument("--preset", choices=sorted(PRESETS), default="gpt-5.5")
    parser.add_argument("--write-price", type=float, help="Override first appearance/cache-write price per 1M tokens.")
    parser.add_argument("--cached-price", type=float, help="Override cached-read price per 1M tokens.")
    parser.add_argument("--output-price", type=float, help="Override summary output price per 1M tokens.")
    parser.add_argument("--use-original-count", action="store_true")
    parser.add_argument("--no-reset-on-compaction", action="store_true")
    parser.add_argument("--only-tool-sessions", action="store_true")
    parser.add_argument("--top-sessions", type=int, default=10)
    parser.add_argument("--write-turn-csv", type=pathlib.Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.threshold < 0:
        raise SystemExit("--threshold must be non-negative")
    if args.summary_tokens < 0:
        raise SystemExit("--summary-tokens must be non-negative")
    if args.raw_use_replays < 0:
        raise SystemExit("--raw-use-replays must be non-negative")

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
            raw_use_replays=args.raw_use_replays,
            prices=prices,
            use_original_count=args.use_original_count,
            reset_on_compaction=not args.no_reset_on_compaction,
        )
        for path in session_paths(args.paths)
    ]

    if args.write_turn_csv:
        write_turn_csv(args.write_turn_csv, results)
    print_report(args, prices, results)


if __name__ == "__main__":
    main()
