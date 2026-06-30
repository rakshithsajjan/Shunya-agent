#!/usr/bin/env python3
"""Estimate cache-first savings from compressing large Codex tool outputs.

The model here assumes old tool outputs are already cached. By default, the
next model call still sees the raw output once, then compression starts. When
an output is compressed, its summary is paid as uncached/cache-write input on
the first compressed model call, then as cached input on later model calls.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
from dataclasses import dataclass, field
from typing import Iterable


DEFAULT_PRESETS = {
    # Prices are dollars per 1M tokens.
    "gpt-5.5": {
        "input": 5.00,
        "cached_input": 0.50,
        "output": 30.00,
        "summary_write": 5.00,
    },
    "gpt-5.4-mini": {
        "input": 0.75,
        "cached_input": 0.075,
        "output": 4.50,
        "summary_write": 0.75,
    },
    "claude-sonnet-4.6-5m": {
        "input": 3.00,
        "cached_input": 0.30,
        "output": 15.00,
        "summary_write": 3.75,
    },
    "claude-sonnet-4.6-1h": {
        "input": 3.00,
        "cached_input": 0.30,
        "output": 15.00,
        "summary_write": 6.00,
    },
    "gemini-2.5-flash": {
        "input": 0.30,
        "cached_input": 0.03,
        "output": 2.50,
        "summary_write": 0.30,
    },
    "grok-build-0.1": {
        "input": 1.00,
        "cached_input": 0.20,
        "output": 2.00,
        "summary_write": 1.00,
    },
}

ORIGINAL_TOKEN_RE = re.compile(r"Original token count:\s*(\d+)")


@dataclass
class Prices:
    input: float
    cached_input: float
    output: float
    summary_write: float


@dataclass
class EligibleOutput:
    session: pathlib.Path
    context_index: int
    future_contexts: int
    compressed_contexts: int
    tokens: int
    summary_tokens: int
    tool_name: str
    command: str = ""


@dataclass
class Totals:
    sessions: int = 0
    context_replays: int = 0
    tool_outputs: int = 0
    eligible_outputs: int = 0
    eligible_tokens: int = 0
    summary_tokens: int = 0
    future_contexts: int = 0
    compressed_contexts: int = 0
    baseline_cached_cost: float = 0.0
    compressed_local_cost: float = 0.0
    compressed_model_cost: float = 0.0
    local_savings: float = 0.0
    model_savings: float = 0.0
    by_session: dict[pathlib.Path, "Totals"] = field(default_factory=dict)


def normalize_output(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def estimated_tokens(text: str, use_original_count: bool) -> int:
    if use_original_count:
        match = ORIGINAL_TOKEN_RE.search(text)
        if match:
            return int(match.group(1))
    return max(0, round(len(text) / 3.6))


def parse_call_args(value: object) -> dict:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def default_session_paths() -> list[pathlib.Path]:
    codex_home = pathlib.Path.home() / ".codex"
    paths: list[pathlib.Path] = []
    paths.extend((codex_home / "sessions").rglob("*.jsonl"))
    paths.extend((codex_home / "archived_sessions").glob("*.jsonl"))
    return sorted(paths)


def iter_session_paths(inputs: list[str]) -> list[pathlib.Path]:
    if not inputs:
        return default_session_paths()

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
    use_original_count: bool,
    raw_use_replays: int,
) -> tuple[int, int, list[EligibleOutput]]:
    calls: dict[str, tuple[str, dict]] = {}
    outputs: list[tuple[int, int, str, str]] = []
    context_replays = 0
    tool_outputs = 0

    with path.open(errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            if record.get("type") == "turn_context":
                context_replays += 1
                continue

            if record.get("type") != "response_item":
                continue

            payload = record.get("payload") or {}
            payload_type = payload.get("type")

            if payload_type in {"function_call", "custom_tool_call", "tool_search_call"}:
                call_id = payload.get("call_id")
                if not call_id:
                    continue
                raw_args = (
                    payload.get("arguments")
                    if payload_type == "function_call"
                    else payload.get("input") or payload.get("arguments")
                )
                calls[call_id] = (
                    payload.get("name") or payload_type,
                    parse_call_args(raw_args),
                )
                continue

            if payload_type not in {
                "function_call_output",
                "custom_tool_call_output",
                "tool_search_output",
            }:
                continue

            tool_outputs += 1
            call_id = payload.get("call_id")
            tool_name, args = calls.get(call_id, (payload_type, {}))
            command = args.get("cmd", "") if isinstance(args, dict) else ""
            output = payload.get("output") if "output" in payload else payload
            token_count = estimated_tokens(normalize_output(output), use_original_count)
            if token_count >= threshold:
                outputs.append((context_replays, token_count, tool_name, command))

    eligible = [
        EligibleOutput(
            session=path,
            context_index=context_index,
            future_contexts=future_contexts,
            compressed_contexts=max(0, future_contexts - raw_use_replays),
            tokens=tokens,
            summary_tokens=min(summary_tokens, tokens),
            tool_name=tool_name,
            command=command,
        )
        for context_index, tokens, tool_name, command in outputs
        for future_contexts in [context_replays - context_index]
        if future_contexts - raw_use_replays > 0
    ]
    return context_replays, tool_outputs, eligible


def cost_for_output(output: EligibleOutput, prices: Prices) -> tuple[float, float, float]:
    """Return baseline, compressed-local, compressed-model costs."""
    million = 1_000_000
    future = output.future_contexts
    compressed_future = output.compressed_contexts
    raw_use_future = future - compressed_future
    raw_mtok = output.tokens / million
    summary_mtok = output.summary_tokens / million

    baseline = future * raw_mtok * prices.cached_input

    # The first raw_use_future contexts still read the raw output from cache.
    # Then the first compressed context sees the summary as uncached/cache-write
    # input. Later compressed contexts read that smaller summary from cache.
    local = raw_use_future * raw_mtok * prices.cached_input
    local += summary_mtok * prices.summary_write
    if compressed_future > 1:
        local += (compressed_future - 1) * summary_mtok * prices.cached_input

    # If a model creates the summary, add one cached read of the old output and
    # generated output tokens for the summary.
    model_generated = (
        local
        + raw_mtok * prices.cached_input
        + summary_mtok * prices.output
    )
    return baseline, local, model_generated


def build_totals(
    paths: Iterable[pathlib.Path],
    threshold: int,
    summary_tokens: int,
    use_original_count: bool,
    raw_use_replays: int,
    prices: Prices,
) -> Totals:
    totals = Totals()
    for path in paths:
        contexts, tool_outputs, eligible = scan_session(
            path,
            threshold=threshold,
            summary_tokens=summary_tokens,
            use_original_count=use_original_count,
            raw_use_replays=raw_use_replays,
        )

        session_totals = Totals(sessions=1, context_replays=contexts, tool_outputs=tool_outputs)
        for output in eligible:
            baseline, local, model = cost_for_output(output, prices)
            session_totals.eligible_outputs += 1
            session_totals.eligible_tokens += output.tokens
            session_totals.summary_tokens += output.summary_tokens
            session_totals.future_contexts += output.future_contexts
            session_totals.compressed_contexts += output.compressed_contexts
            session_totals.baseline_cached_cost += baseline
            session_totals.compressed_local_cost += local
            session_totals.compressed_model_cost += model

        session_totals.local_savings = (
            session_totals.baseline_cached_cost - session_totals.compressed_local_cost
        )
        session_totals.model_savings = (
            session_totals.baseline_cached_cost - session_totals.compressed_model_cost
        )

        totals.sessions += 1
        totals.context_replays += contexts
        totals.tool_outputs += tool_outputs
        totals.eligible_outputs += session_totals.eligible_outputs
        totals.eligible_tokens += session_totals.eligible_tokens
        totals.summary_tokens += session_totals.summary_tokens
        totals.future_contexts += session_totals.future_contexts
        totals.compressed_contexts += session_totals.compressed_contexts
        totals.baseline_cached_cost += session_totals.baseline_cached_cost
        totals.compressed_local_cost += session_totals.compressed_local_cost
        totals.compressed_model_cost += session_totals.compressed_model_cost
        totals.by_session[path] = session_totals

    totals.local_savings = totals.baseline_cached_cost - totals.compressed_local_cost
    totals.model_savings = totals.baseline_cached_cost - totals.compressed_model_cost
    return totals


def money(value: float) -> str:
    return f"${value:,.2f}"


def pct(part: float, whole: float) -> str:
    if whole == 0:
        return "0.0%"
    return f"{100 * part / whole:.1f}%"


def print_report(args: argparse.Namespace, prices: Prices, totals: Totals) -> None:
    print("Tool output compression cache math")
    print("=" * 40)
    print(f"preset: {args.preset}")
    print(f"threshold: {args.threshold:,} tokens")
    print(f"summary_tokens: {args.summary_tokens:,}")
    print(f"raw_use_replays before compression: {args.raw_use_replays:,}")
    print(f"token source: {'Original token count when present' if args.use_original_count else 'stored payload estimate'}")
    print(f"sessions: {totals.sessions:,}")
    print(f"context replays: {totals.context_replays:,}")
    print(f"tool outputs: {totals.tool_outputs:,}")
    print(f"compressible outputs after raw-use replays: {totals.eligible_outputs:,}")
    print(f"eligible raw tokens: {totals.eligible_tokens:,}")
    print(f"replacement summary tokens: {totals.summary_tokens:,}")
    print(f"raw-to-summary token reduction: {totals.eligible_tokens - totals.summary_tokens:,}")
    print(f"future raw replays retained before compression: {totals.future_contexts - totals.compressed_contexts:,}")
    print(f"future compressed replays: {totals.compressed_contexts:,}")
    print()

    print("Prices ($/1M tokens)")
    print(f"input/first summary: {prices.summary_write:g}")
    print(f"cached input: {prices.cached_input:g}")
    print(f"summary output: {prices.output:g}")
    print()

    print("Actual future-context simulation")
    print(f"keep raw cached cost: {money(totals.baseline_cached_cost)}")
    print(f"compress with local/extractive summaries: {money(totals.compressed_local_cost)}")
    print(f"local/extractive savings: {money(totals.local_savings)} ({pct(totals.local_savings, totals.baseline_cached_cost)})")
    print(f"compress with model-generated summaries: {money(totals.compressed_model_cost)}")
    print(f"model-generated savings: {money(totals.model_savings)} ({pct(totals.model_savings, totals.baseline_cached_cost)})")
    print()

    if totals.eligible_outputs:
        avg_future = totals.future_contexts / totals.eligible_outputs
        avg_compressed_future = totals.compressed_contexts / totals.eligible_outputs
        avg_tokens = totals.eligible_tokens / totals.eligible_outputs
        print(f"average eligible output: {avg_tokens:,.0f} tokens")
        print(f"average future context replays per eligible output: {avg_future:.2f}")
        print(f"average compressed replays per eligible output: {avg_compressed_future:.2f}")
        print()

    top = sorted(
        totals.by_session.items(),
        key=lambda item: item[1].local_savings,
        reverse=True,
    )[: args.top_sessions]
    if top:
        print(f"Top {len(top)} sessions by local/extractive savings")
        for path, item in top:
            if item.eligible_outputs == 0:
                continue
            print(
                f"- {money(item.local_savings)} local, "
                f"{money(item.model_savings)} model, "
                f"{item.eligible_outputs:,} outputs, "
                f"{item.context_replays:,} replays: {path}"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="Session JSONL files or directories. Defaults to ~/.codex sessions.")
    parser.add_argument("--threshold", type=int, default=2000, help="Only compress outputs at or above this token count.")
    parser.add_argument("--summary-tokens", type=int, default=300, help="Replacement summary token count.")
    parser.add_argument(
        "--raw-use-replays",
        type=int,
        default=1,
        help="Number of future context replays that still keep the raw output before compression starts.",
    )
    parser.add_argument("--preset", default="gpt-5.5", choices=sorted(DEFAULT_PRESETS), help="Pricing preset.")
    parser.add_argument("--input-price", type=float, help="Override uncached input price per 1M tokens.")
    parser.add_argument("--cached-input-price", type=float, help="Override cached input price per 1M tokens.")
    parser.add_argument("--output-price", type=float, help="Override output price per 1M tokens.")
    parser.add_argument("--summary-write-price", type=float, help="Override first summary input/cache-write price per 1M tokens.")
    parser.add_argument("--use-original-count", action="store_true", help="Use shell Original token count when present instead of stored payload estimate.")
    parser.add_argument("--top-sessions", type=int, default=10, help="Number of top sessions to print.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.threshold < 0:
        raise SystemExit("--threshold must be non-negative")
    if args.summary_tokens < 0:
        raise SystemExit("--summary-tokens must be non-negative")
    if args.raw_use_replays < 0:
        raise SystemExit("--raw-use-replays must be non-negative")
    preset = DEFAULT_PRESETS[args.preset]
    prices = Prices(
        input=args.input_price if args.input_price is not None else preset["input"],
        cached_input=(
            args.cached_input_price
            if args.cached_input_price is not None
            else preset["cached_input"]
        ),
        output=args.output_price if args.output_price is not None else preset["output"],
        summary_write=(
            args.summary_write_price
            if args.summary_write_price is not None
            else preset["summary_write"]
        ),
    )
    paths = iter_session_paths(args.paths)
    totals = build_totals(
        paths,
        threshold=args.threshold,
        summary_tokens=args.summary_tokens,
        use_original_count=args.use_original_count,
        raw_use_replays=args.raw_use_replays,
        prices=prices,
    )
    print_report(args, prices, totals)


if __name__ == "__main__":
    main()
