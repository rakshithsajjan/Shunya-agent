# Session Context Profile

Generated from local Codex JSONL sessions.

- Sessions scanned: 617
- Sessions with tool output: 314
- Total estimated context-item tokens: 89,928,325
- Median total tokens per tool-use session: 67,583
- P75 total tokens per tool-use session: 178,939
- P90 total tokens per tool-use session: 573,122
- P99 total tokens per tool-use session: 4,331,731

## Aggregate Composition

![Aggregate stacked bar](analysis/session_context_profile/session_context_stacked_bar.svg)

| Category | Total Tokens | Share |
| --- | --- | --- |
| Setup/System | 10,914,729 | 12.1% |
| User Input | 21,967,832 | 24.4% |
| Assistant Output | 2,498,719 | 2.8% |
| Edit/Diff Input | 1,680,757 | 1.9% |
| Other Tool Calls | 1,964,808 | 2.2% |
| Tool Output | 46,063,285 | 51.2% |
| Reasoning Summary | 198,024 | 0.2% |
| Compaction Summary | 4,583,713 | 5.1% |
| Other | 56,458 | 0.1% |

## Per Tool-Use Session Category Stats

| Category | Avg | P50 | P75 | P90 | P95 | P99 | Max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Setup/System | 26,816 | 16,744 | 22,659 | 45,884 | 83,788 | 195,780 | 408,642 |
| User Input | 68,531 | 541 | 2,650 | 11,409 | 95,106 | 1,455,070 | 8,408,804 |
| Assistant Output | 7,869 | 2,522 | 8,701 | 23,140 | 39,007 | 56,403 | 68,314 |
| Edit/Diff Input | 5,353 | 113 | 5,262 | 17,135 | 30,288 | 49,047 | 67,148 |
| Other Tool Calls | 6,257 | 2,210 | 5,465 | 17,307 | 29,796 | 56,071 | 95,947 |
| Tool Output | 146,698 | 38,830 | 98,378 | 332,921 | 442,201 | 3,045,406 | 5,367,258 |
| Reasoning Summary | 625 | 44 | 321 | 1,481 | 3,023 | 7,949 | 28,537 |
| Compaction Summary | 14,598 | 0 | 0 | 20,886 | 53,001 | 244,305 | 1,170,777 |
| Other | 154 | 0 | 45 | 476 | 976 | 1,869 | 2,862 |

## Percentile Curves

![Percentile curves](analysis/session_context_profile/session_context_percentiles.svg)

CSV files:

- `analysis/session_context_profile/session_context_by_session.csv`
- `analysis/session_context_profile/session_context_percentiles.csv`

Notes:

- Token counts use an approximate `chars / 3.6` estimator.
- `Setup/System` includes developer/system messages, base instructions, AGENTS instructions, and environment context.
- `User Input` excludes AGENTS and environment context.
- `Edit/Diff Input` is mostly `apply_patch` or edit/write tool-call input, not the resulting tool output.
- `Tool Output` includes shell, connector, browser, image, and other tool results.
