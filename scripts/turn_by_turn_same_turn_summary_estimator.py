#!/usr/bin/env python3
"""Turn-by-turn estimator for same-turn tool-output retention summaries.

This is the stricter full-context estimator with one extra mode:

- normal: keep raw tool outputs
- local: replace large tool outputs with local/extractive summaries
- same-turn: the main model emits the retention summary during the raw-use turn,
  so we pay summary output tokens once, but no separate raw-output reread
- separate: a later model call creates the summary, paying a raw reread plus
  summary output tokens
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
class ActiveItem:
    tokens: int
    summary_tokens: int
    eligible_tool_output: bool
    replay_count: int = 0


@dataclass
class SessionResult:
    path: pathlib.Path
    turns: int = 0
    tool_outputs: int = 0
    eligible_outputs: int = 0
    non_tool_items: int = 0
    compactions: int = 0
    normal: float = 0.0
    local: float = 0.0
    same_turn: float = 0.0
    separate: float = 0.0
    tool_tokens: int = 0
    eligible_tool_tokens: int = 0
    non_tool_tokens: int = 0

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


def dollars(tokens: int, price_per_million: float) -> float:
    return tokens * price_per_million / 1_000_000


def cost_for_turn(
    active: list[ActiveItem],
    prices: Prices,
    raw_use_replays: int,
) -> tuple[float, float, float, float]:
    normal = 0.0
    local = 0.0
    same_turn = 0.0
    separate = 0.0

    for item in active:
        raw_price = prices.write if item.replay_count == 0 else prices.cached
        raw_cost = dollars(item.tokens, raw_price)
        normal += raw_cost

        if not item.eligible_tool_output:
            local += raw_cost
            same_turn += raw_cost
            separate += raw_cost
            continue

        if item.replay_count < raw_use_replays:
            local += raw_cost
            same_turn += raw_cost
            separate += raw_cost
            if item.replay_count == raw_use_replays - 1:
                same_turn += dollars(item.summary_tokens, prices.output)
            continue

        summary_replay = item.replay_count - raw_use_replays
        summary_price = prices.write if summary_replay == 0 else prices.cached
        summary_cost = dollars(item.summary_tokens, summary_price)
        local += summary_cost
        same_turn += summary_cost
        separate += summary_cost

        if summary_replay == 0:
            # Separate summarization must reread the raw output. Same-turn
            # summary already happened during the previous raw-use turn.
            separate += dollars(item.tokens, raw_price)
            separate += dollars(item.summary_tokens, prices.output)

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
    raw_use_replays: int,
    prices: Prices,
    use_original_count: bool,
    reset_on_compaction: bool,
) -> SessionResult:
    result = SessionResult(path=path)
    active: list[ActiveItem] = []

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
                        result.non_tool_tokens += tokens
                        active.append(
                            ActiveItem(
                                tokens=tokens,
                                summary_tokens=tokens,
                                eligible_tool_output=False,
                            )
                        )
                continue

            if record_type == "turn_context":
                result.turns += 1
                normal, local, same_turn, separate = cost_for_turn(
                    active,
                    prices=prices,
                    raw_use_replays=raw_use_replays,
                )
                result.normal += normal
                result.local += local
                result.same_turn += same_turn
                result.separate += separate
                for item in active:
                    item.replay_count += 1
                continue

            if record_type != "response_item":
                continue

            payload = record.get("payload") or {}
            payload_type = payload.get("type")
            if payload_type in TOOL_OUTPUT_TYPES:
                value = payload.get("output") if "output" in payload else payload
                tokens = token_count(value, use_original_count)
                eligible = tokens >= threshold
                result.tool_outputs += 1
                result.tool_tokens += tokens
                if eligible:
                    result.eligible_outputs += 1
                    result.eligible_tool_tokens += tokens
                active.append(
                    ActiveItem(
                        tokens=tokens,
                        summary_tokens=min(summary_tokens, tokens),
                        eligible_tool_output=eligible,
                    )
                )
            elif payload:
                tokens = token_count(payload, use_original_count=False)
                result.non_tool_items += 1
                result.non_tool_tokens += tokens
                active.append(
                    ActiveItem(
                        tokens=tokens,
                        summary_tokens=tokens,
                        eligible_tool_output=False,
                    )
                )

    return result


def money(value: float) -> str:
    return f"${value:,.2f}"


def percent(savings: float, total: float) -> str:
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


def print_report(args: argparse.Namespace, prices: Prices, results: list[SessionResult]) -> None:
    if args.only_tool_sessions:
        results = [result for result in results if result.tool_outputs > 0]

    normal = sum(result.normal for result in results)
    local = sum(result.local for result in results)
    same_turn = sum(result.same_turn for result in results)
    separate = sum(result.separate for result in results)
    tool_outputs = sum(result.tool_outputs for result in results)
    eligible_outputs = sum(result.eligible_outputs for result in results)
    non_tool_items = sum(result.non_tool_items for result in results)

    print("Same-turn summary cache estimator")
    print("=" * 38)
    print(f"preset: {args.preset}")
    print(f"threshold: {args.threshold:,} tokens")
    print(f"summary_tokens: {args.summary_tokens:,}")
    print(f"raw_use_replays before compression: {args.raw_use_replays:,}")
    print(f"reset_on_compaction: {not args.no_reset_on_compaction}")
    print(f"sessions: {len(results):,}")
    print(f"turns charged: {sum(result.turns for result in results):,}")
    print(f"tool outputs: {tool_outputs:,}")
    print(f"eligible tool outputs: {eligible_outputs:,}")
    print(f"non-tool context items: {non_tool_items:,}")
    print()
    print("Overall cost")
    print(f"normal, raw outputs with caching: {money(normal)}")
    print(f"local/extractive summaries: {money(local)}")
    print(f"local savings: {money(normal - local)} ({percent(normal - local, normal)})")
    print(f"same-turn model summaries: {money(same_turn)}")
    print(f"same-turn savings: {money(normal - same_turn)} ({percent(normal - same_turn, normal)})")
    print(f"separate model summaries: {money(separate)}")
    print(f"separate savings: {money(normal - separate)} ({percent(normal - separate, normal)})")
    print()

    tool_sessions = [result for result in results if result.tool_outputs > 0]
    if tool_sessions:
        same_turn_savings = [result.same_turn_savings for result in tool_sessions]
        print("Per tool-use session same-turn savings")
        print(f"mean: {money(mean(same_turn_savings))}")
        for p in [50, 75, 90, 99]:
            print(f"p{p}: {money(percentile(same_turn_savings, p))}")
        print()

    top = sorted(results, key=lambda result: result.same_turn_savings, reverse=True)[
        : args.top_sessions
    ]
    if top:
        print(f"Top {len(top)} sessions by same-turn savings")
        for result in top:
            if result.tool_outputs == 0:
                continue
            print(
                f"- {money(result.same_turn_savings)} same-turn, "
                f"{money(result.local_savings)} local, "
                f"{money(result.separate_savings)} separate, "
                f"{result.eligible_outputs:,} eligible outputs: {result.path}"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="Session JSONL files or directories. Defaults to ~/.codex sessions.")
    parser.add_argument("--threshold", type=int, default=2000)
    parser.add_argument("--summary-tokens", type=int, default=300)
    parser.add_argument("--raw-use-replays", type=int, default=1)
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
    if args.raw_use_replays < 1:
        raise SystemExit("--raw-use-replays must be at least 1 for same-turn summaries")

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
    print_report(args, prices, results)


if __name__ == "__main__":
    main()
