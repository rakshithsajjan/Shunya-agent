#!/usr/bin/env python3
"""Profile Codex session context composition by token category.

Outputs:
- Markdown summary report
- Per-session CSV
- Percentile CSV from p0 to p100
- SVG charts: aggregate stacked bar and percentile curves
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import pathlib
from dataclasses import dataclass, field
from statistics import mean, median


CATEGORIES = [
    "setup_context",
    "user_input",
    "assistant_output",
    "edit_diff_input",
    "other_tool_call_input",
    "tool_output",
    "reasoning_summary",
    "compaction_summary",
    "other",
]

CATEGORY_LABELS = {
    "setup_context": "Setup/System",
    "user_input": "User Input",
    "assistant_output": "Assistant Output",
    "edit_diff_input": "Edit/Diff Input",
    "other_tool_call_input": "Other Tool Calls",
    "tool_output": "Tool Output",
    "reasoning_summary": "Reasoning Summary",
    "compaction_summary": "Compaction Summary",
    "other": "Other",
}

CATEGORY_COLORS = {
    "setup_context": "#5067A8",
    "user_input": "#2E8B57",
    "assistant_output": "#D98A24",
    "edit_diff_input": "#B84A62",
    "other_tool_call_input": "#7B61B5",
    "tool_output": "#4AA3A2",
    "reasoning_summary": "#8A8F98",
    "compaction_summary": "#C4A83A",
    "other": "#A0A0A0",
}

TOOL_OUTPUT_TYPES = {
    "function_call_output",
    "custom_tool_call_output",
    "tool_search_output",
}

TOOL_CALL_TYPES = {
    "function_call",
    "custom_tool_call",
    "tool_search_call",
}

EDIT_TOOL_NAMES = {
    "apply_patch",
    "edit",
    "write",
    "write_file",
    "replace",
    "multi_edit",
}


@dataclass
class SessionProfile:
    path: pathlib.Path
    counts: dict[str, int] = field(default_factory=lambda: {key: 0 for key in CATEGORIES})
    tool_outputs: int = 0
    tool_calls: int = 0
    real_user_messages: int = 0

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    @property
    def has_tool_output(self) -> bool:
        return self.tool_outputs > 0


def normalize(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def token_count(value: object) -> int:
    return max(0, round(len(normalize(value)) / 3.6))


def content_text(payload: dict) -> str:
    parts: list[str] = []
    for item in payload.get("content") or []:
        if isinstance(item, dict):
            parts.append(item.get("text") or "")
    return "\n".join(parts)


def is_synthetic_user_context(payload: dict) -> bool:
    text = content_text(payload).strip()
    return text.startswith("# AGENTS.md instructions") or text.startswith("<environment_context>")


def is_setup_message(payload: dict) -> bool:
    role = payload.get("role")
    if role in {"system", "developer"}:
        return True
    if role == "user" and is_synthetic_user_context(payload):
        return True
    return False


def tool_call_tokens(payload: dict) -> int:
    payload_type = payload.get("type")
    if payload_type == "function_call":
        return token_count(payload.get("arguments") or "")
    if payload_type == "custom_tool_call":
        return token_count(payload.get("input") or payload.get("arguments") or "")
    if payload_type == "tool_search_call":
        return token_count(payload.get("arguments") or payload)
    return token_count(payload)


def is_edit_tool_call(payload: dict) -> bool:
    name = payload.get("name") or ""
    if name in EDIT_TOOL_NAMES:
        return True
    if payload.get("type") == "custom_tool_call" and name == "apply_patch":
        return True
    return False


def classify_response_item(payload: dict) -> tuple[str, int, dict[str, int]]:
    payload_type = payload.get("type")
    extras = {"tool_calls": 0, "tool_outputs": 0, "real_user_messages": 0}

    if payload_type == "message":
        role = payload.get("role")
        if is_setup_message(payload):
            return "setup_context", token_count(payload), extras
        if role == "user":
            extras["real_user_messages"] = 1
            return "user_input", token_count(payload), extras
        if role == "assistant":
            return "assistant_output", token_count(payload), extras
        return "other", token_count(payload), extras

    if payload_type == "reasoning":
        summary = payload.get("summary")
        return "reasoning_summary", token_count(summary if summary is not None else payload), extras

    if payload_type in TOOL_OUTPUT_TYPES:
        extras["tool_outputs"] = 1
        value = payload.get("output") if "output" in payload else payload
        return "tool_output", token_count(value), extras

    if payload_type in TOOL_CALL_TYPES:
        extras["tool_calls"] = 1
        category = "edit_diff_input" if is_edit_tool_call(payload) else "other_tool_call_input"
        return category, tool_call_tokens(payload), extras

    return "other", token_count(payload), extras


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


def scan_session(path: pathlib.Path) -> SessionProfile:
    profile = SessionProfile(path=path)
    with path.open(errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            record_type = record.get("type")
            if record_type == "response_item":
                payload = record.get("payload") or {}
                category, tokens, extras = classify_response_item(payload)
                profile.counts[category] += tokens
                profile.tool_calls += extras["tool_calls"]
                profile.tool_outputs += extras["tool_outputs"]
                profile.real_user_messages += extras["real_user_messages"]
            elif record_type == "compacted":
                replacement = (record.get("payload") or {}).get("replacement_history")
                if replacement:
                    profile.counts["compaction_summary"] += token_count(replacement)
            elif record_type == "session_meta":
                payload = record.get("payload") or {}
                base = payload.get("base_instructions") or {}
                if base:
                    profile.counts["setup_context"] += token_count(base)
    return profile


def percentile(values: list[float], p: int) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    k = (len(values) - 1) * p / 100
    lower = math.floor(k)
    upper = math.ceil(k)
    if lower == upper:
        return values[lower]
    return values[lower] * (upper - k) + values[upper] * (k - lower)


def moneyish(value: float) -> str:
    return f"{value:,.0f}"


def write_session_csv(path: pathlib.Path, profiles: list[SessionProfile]) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["session", "total", "tool_calls", "tool_outputs", "real_user_messages", *CATEGORIES])
        for profile in profiles:
            writer.writerow(
                [
                    str(profile.path),
                    profile.total,
                    profile.tool_calls,
                    profile.tool_outputs,
                    profile.real_user_messages,
                    *[profile.counts[key] for key in CATEGORIES],
                ]
            )


def write_percentile_csv(path: pathlib.Path, profiles: list[SessionProfile]) -> dict[str, list[float]]:
    percentile_data: dict[str, list[float]] = {}
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["percentile", "total", *CATEGORIES])
        for p in range(101):
            total_value = percentile([profile.total for profile in profiles], p)
            row = [p, round(total_value)]
            for key in CATEGORIES:
                value = percentile([profile.counts[key] for profile in profiles], p)
                percentile_data.setdefault(key, []).append(value)
                row.append(round(value))
            writer.writerow(row)
    return percentile_data


def svg_text(x: float, y: float, text: str, size: int = 12, anchor: str = "start") -> str:
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-family="Arial, sans-serif" '
        f'font-size="{size}" text-anchor="{anchor}" fill="#222">{html.escape(text)}</text>'
    )


def write_stacked_bar_svg(path: pathlib.Path, totals: dict[str, int]) -> None:
    width = 1200
    height = 360
    margin_x = 60
    bar_y = 120
    bar_h = 58
    bar_w = width - 2 * margin_x
    total = sum(totals.values())

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#fbfbf8"/>',
        svg_text(margin_x, 48, "Aggregate Session Context Composition", 24),
        svg_text(margin_x, 76, f"Total estimated tokens: {moneyish(total)}", 14),
    ]

    x = margin_x
    legend_y = 220
    legend_x = margin_x
    for key in CATEGORIES:
        value = totals[key]
        if value <= 0 or total <= 0:
            continue
        segment_w = bar_w * value / total
        parts.append(
            f'<rect x="{x:.2f}" y="{bar_y}" width="{segment_w:.2f}" height="{bar_h}" '
            f'fill="{CATEGORY_COLORS[key]}"/>'
        )
        if segment_w > 68:
            pct = 100 * value / total
            parts.append(svg_text(x + segment_w / 2, bar_y + 36, f"{pct:.1f}%", 13, "middle"))
        x += segment_w

        if legend_x > width - 260:
            legend_x = margin_x
            legend_y += 34
        parts.append(f'<rect x="{legend_x}" y="{legend_y - 14}" width="14" height="14" fill="{CATEGORY_COLORS[key]}"/>')
        pct = 100 * value / total
        parts.append(svg_text(legend_x + 22, legend_y - 2, f"{CATEGORY_LABELS[key]}: {pct:.1f}% ({moneyish(value)})", 12))
        legend_x += 265

    parts.append("</svg>")
    path.write_text("\n".join(parts))


def write_percentile_svg(path: pathlib.Path, profiles: list[SessionProfile]) -> None:
    width = 1200
    height = 680
    left = 82
    right = 28
    top = 70
    bottom = 82
    plot_w = width - left - right
    plot_h = height - top - bottom

    percentile_data = {
        key: [percentile([profile.counts[key] for profile in profiles], p) for p in range(101)]
        for key in CATEGORIES
    }
    max_value = max(max(values) for values in percentile_data.values()) if profiles else 1
    max_log = math.log10(max(10, max_value + 1))

    def px(p: int) -> float:
        return left + plot_w * p / 100

    def py(value: float) -> float:
        scaled = math.log10(max(1, value)) / max_log
        return top + plot_h * (1 - scaled)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#fbfbf8"/>',
        svg_text(left, 42, "Per-Session Category Percentiles (p0 to p100)", 24),
        svg_text(left, 62, "Y axis is log-scaled estimated tokens", 13),
        f'<line x1="{left}" y1="{top}" x2="{left}" y2="{top + plot_h}" stroke="#444"/>',
        f'<line x1="{left}" y1="{top + plot_h}" x2="{left + plot_w}" y2="{top + plot_h}" stroke="#444"/>',
    ]

    for tick in [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 5_000_000]:
        if tick > max_value * 1.1:
            continue
        y = py(tick)
        parts.append(f'<line x1="{left - 4}" y1="{y:.1f}" x2="{left + plot_w}" y2="{y:.1f}" stroke="#e0dfd8"/>')
        parts.append(svg_text(left - 10, y + 4, moneyish(tick), 11, "end"))

    for p in [0, 25, 50, 75, 100]:
        x = px(p)
        parts.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + plot_h + 4}" stroke="#e8e6de"/>')
        parts.append(svg_text(x, top + plot_h + 24, f"p{p}", 11, "middle"))

    for key in CATEGORIES:
        points = " ".join(f"{px(p):.2f},{py(value):.2f}" for p, value in enumerate(percentile_data[key]))
        parts.append(
            f'<polyline fill="none" stroke="{CATEGORY_COLORS[key]}" stroke-width="2.2" points="{points}"/>'
        )

    legend_x = left
    legend_y = height - 32
    for key in CATEGORIES:
        parts.append(f'<rect x="{legend_x}" y="{legend_y - 12}" width="12" height="12" fill="{CATEGORY_COLORS[key]}"/>')
        parts.append(svg_text(legend_x + 18, legend_y - 1, CATEGORY_LABELS[key], 11))
        legend_x += 128

    parts.append("</svg>")
    path.write_text("\n".join(parts))


def stats(values: list[int]) -> dict[str, float]:
    if not values:
        return {key: 0.0 for key in ["avg", "p50", "p75", "p90", "p95", "p99", "max"]}
    return {
        "avg": mean(values),
        "p50": median(values),
        "p75": percentile(values, 75),
        "p90": percentile(values, 90),
        "p95": percentile(values, 95),
        "p99": percentile(values, 99),
        "max": max(values),
    }


def markdown_table(rows: list[list[str]]) -> str:
    header = rows[0]
    sep = ["---"] * len(header)
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join(sep) + " |"]
    for row in rows[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def write_report(path: pathlib.Path, profiles: list[SessionProfile], output_dir: pathlib.Path) -> None:
    totals = {key: sum(profile.counts[key] for profile in profiles) for key in CATEGORIES}
    total_tokens = sum(totals.values())
    tool_profiles = [profile for profile in profiles if profile.has_tool_output]

    composition_rows = [["Category", "Total Tokens", "Share"]]
    for key in CATEGORIES:
        share = 100 * totals[key] / total_tokens if total_tokens else 0
        composition_rows.append([CATEGORY_LABELS[key], moneyish(totals[key]), f"{share:.1f}%"])

    stats_rows = [["Category", "Avg", "P50", "P75", "P90", "P95", "P99", "Max"]]
    for key in CATEGORIES:
        values = [profile.counts[key] for profile in tool_profiles]
        item = stats(values)
        stats_rows.append(
            [
                CATEGORY_LABELS[key],
                moneyish(item["avg"]),
                moneyish(item["p50"]),
                moneyish(item["p75"]),
                moneyish(item["p90"]),
                moneyish(item["p95"]),
                moneyish(item["p99"]),
                moneyish(item["max"]),
            ]
        )

    total_stats = stats([profile.total for profile in tool_profiles])

    output_prefix = output_dir.as_posix()

    report = f"""# Session Context Profile

Generated from local Codex JSONL sessions.

- Sessions scanned: {len(profiles):,}
- Sessions with tool output: {len(tool_profiles):,}
- Total estimated context-item tokens: {moneyish(total_tokens)}
- Median total tokens per tool-use session: {moneyish(total_stats["p50"])}
- P75 total tokens per tool-use session: {moneyish(total_stats["p75"])}
- P90 total tokens per tool-use session: {moneyish(total_stats["p90"])}
- P99 total tokens per tool-use session: {moneyish(total_stats["p99"])}

## Aggregate Composition

![Aggregate stacked bar]({output_prefix}/session_context_stacked_bar.svg)

{markdown_table(composition_rows)}

## Per Tool-Use Session Category Stats

{markdown_table(stats_rows)}

## Percentile Curves

![Percentile curves]({output_prefix}/session_context_percentiles.svg)

CSV files:

- `{output_prefix}/session_context_by_session.csv`
- `{output_prefix}/session_context_percentiles.csv`

Notes:

- Token counts use an approximate `chars / 3.6` estimator.
- `Setup/System` includes developer/system messages, base instructions, AGENTS instructions, and environment context.
- `User Input` excludes AGENTS and environment context.
- `Edit/Diff Input` is mostly `apply_patch` or edit/write tool-call input, not the resulting tool output.
- `Tool Output` includes shell, connector, browser, image, and other tool results.
"""
    path.write_text(report)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="Session JSONL files or directories. Defaults to ~/.codex sessions.")
    parser.add_argument("--out-dir", type=pathlib.Path, default=pathlib.Path("analysis/session_context_profile"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    profiles = [scan_session(path) for path in session_paths(args.paths)]
    args.out_dir.mkdir(parents=True, exist_ok=True)

    session_csv = args.out_dir / "session_context_by_session.csv"
    percentile_csv = args.out_dir / "session_context_percentiles.csv"
    stacked_svg = args.out_dir / "session_context_stacked_bar.svg"
    percentile_svg = args.out_dir / "session_context_percentiles.svg"
    report = pathlib.Path("session-context-profile.md")

    write_session_csv(session_csv, profiles)
    write_percentile_csv(percentile_csv, profiles)
    totals = {key: sum(profile.counts[key] for profile in profiles) for key in CATEGORIES}
    write_stacked_bar_svg(stacked_svg, totals)
    write_percentile_svg(percentile_svg, [profile for profile in profiles if profile.has_tool_output])
    write_report(report, profiles, args.out_dir)

    print(f"Wrote {report}")
    print(f"Wrote {session_csv}")
    print(f"Wrote {percentile_csv}")
    print(f"Wrote {stacked_svg}")
    print(f"Wrote {percentile_svg}")


if __name__ == "__main__":
    main()
