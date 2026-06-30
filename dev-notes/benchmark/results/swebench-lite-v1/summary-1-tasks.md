# SWE-bench Lite Pi Native vs Shunya Comparison

Generated from local SWE-bench experiments-style artifacts for 1 task(s).

## Inputs

- Benchmark: swe-bench-lite
- Model: gpt-5.4-mini
- Goal plugin: @narumitw/pi-goal@0.9.2
- Tasks: django__django-10914

## Variant Totals

| Variant | Tasks | Successes | Success Rate | Cost USD | Cost / Success | Tokens | Runtime sec |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pi-native | 1 | 1 | 100.0% | 0.188296 | 0.188296 | 1334806 | 0.0 |
| shunya | 1 | 1 | 100.0% | 0.101714 | 0.101714 | 554998 | 0.0 |

## Per-Task Rows

| Task | Variant | Success | Cost USD | Tokens | Tool Calls | Failure Reason |
| --- | --- | --- | ---: | ---: | ---: | --- |
| django__django-10914 | pi-native | true | 0.188296 | 1334806 | 0 |  |
| django__django-10914 | shunya | true | 0.101714 | 554998 | 0 |  |

## Verification

- All expected predictions, logs, reports, patches, trajectories, and traces were present.
