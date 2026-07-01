# SWE-bench Lite Pi Native vs Shunya Comparison

Generated from local SWE-bench experiments-style artifacts for 20 task(s).

## Inputs

- Benchmark: swe-bench-lite
- Model: gpt-5.4-mini
- Goal plugin: @narumitw/pi-goal@0.9.2
- Tasks: astropy__astropy-12907, astropy__astropy-14182, astropy__astropy-14365, astropy__astropy-14995, astropy__astropy-6938, astropy__astropy-7746, django__django-10914, django__django-10924, django__django-11001, django__django-11019, django__django-11039, django__django-11049, django__django-11099, django__django-11133, django__django-11179, django__django-11283, django__django-11422, django__django-11564, django__django-11583, django__django-11620

## Variant Totals

| Variant | Tasks | Successes | Success Rate | Cost USD | Cost / Success | Tokens | Runtime sec |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pi-native | 20 | 15 | 75.0% | 1.538622 | 0.102575 | 7498916 | 4959.4 |
| shunya | 20 | 13 | 65.0% | 1.691311 | 0.130101 | 8132697 | 2154.8 |

## Per-Task Rows

| Task | Variant | Success | Cost USD | Tokens | Tool Calls | Failure Reason |
| --- | --- | --- | ---: | ---: | ---: | --- |
| astropy__astropy-12907 | pi-native | true | 0.021440 | 68804 | 13 |  |
| astropy__astropy-14182 | pi-native | true | 0.098829 | 385537 | 22 |  |
| astropy__astropy-14365 | pi-native | true | 0.060766 | 287409 | 18 |  |
| astropy__astropy-14995 | pi-native | true | 0.056742 | 229420 | 21 |  |
| astropy__astropy-6938 | pi-native | true | 0.076681 | 387127 | 38 |  |
| astropy__astropy-7746 | pi-native | false | 0.012034 | 31405 | 9 | SWE-bench evaluator unresolved |
| django__django-10914 | pi-native | true | 0.078188 | 334786 | 42 |  |
| django__django-10924 | pi-native | true | 0.092329 | 431134 | 38 |  |
| django__django-11001 | pi-native | true | 0.046027 | 180857 | 19 |  |
| django__django-11019 | pi-native | false | 0.101668 | 364546 | 30 | SWE-bench evaluator unresolved |
| django__django-11039 | pi-native | true | 0.031701 | 116655 | 17 |  |
| django__django-11049 | pi-native | true | 0.092971 | 393694 | 30 |  |
| django__django-11099 | pi-native | true | 0.017343 | 58052 | 14 |  |
| django__django-11133 | pi-native | true | 0.059216 | 311059 | 24 |  |
| django__django-11179 | pi-native | true | 0.032933 | 146497 | 18 |  |
| django__django-11283 | pi-native | false | 0.100301 | 340704 | 32 | SWE-bench evaluator unresolved |
| django__django-11422 | pi-native | false | 0.079545 | 400286 | 29 | SWE-bench evaluator unresolved |
| django__django-11564 | pi-native | false | 0.338481 | 2336580 | 83 | SWE-bench evaluator unresolved |
| django__django-11583 | pi-native | true | 0.054367 | 190463 | 15 |  |
| django__django-11620 | pi-native | true | 0.087061 | 503901 | 36 |  |
| astropy__astropy-12907 | shunya | true | 0.018646 | 49592 | 11 |  |
| astropy__astropy-14182 | shunya | false | 0.068523 | 262928 | 18 | SWE-bench evaluator unresolved |
| astropy__astropy-14365 | shunya | false | 0.032265 | 125523 | 15 | SWE-bench evaluator unresolved |
| astropy__astropy-14995 | shunya | true | 0.061285 | 269632 | 19 |  |
| astropy__astropy-6938 | shunya | true | 0.057184 | 216428 | 21 |  |
| astropy__astropy-7746 | shunya | false | 0.046788 | 125697 | 15 | SWE-bench evaluator unresolved |
| django__django-10914 | shunya | true | 0.109657 | 646358 | 41 |  |
| django__django-10924 | shunya | true | 0.100406 | 489386 | 42 |  |
| django__django-11001 | shunya | true | 0.059610 | 219518 | 24 |  |
| django__django-11019 | shunya | false | 0.096770 | 291107 | 21 | SWE-bench evaluator unresolved |
| django__django-11039 | shunya | true | 0.037006 | 134043 | 20 |  |
| django__django-11049 | shunya | true | 0.089635 | 365006 | 35 |  |
| django__django-11099 | shunya | true | 0.030602 | 124296 | 21 |  |
| django__django-11133 | shunya | true | 0.060646 | 280145 | 22 |  |
| django__django-11179 | shunya | true | 0.031240 | 109031 | 18 |  |
| django__django-11283 | shunya | false | 0.133097 | 369170 | 32 | SWE-bench evaluator unresolved |
| django__django-11422 | shunya | false | 0.061993 | 266383 | 19 | SWE-bench evaluator unresolved |
| django__django-11564 | shunya | false | 0.329203 | 2201994 | 80 | SWE-bench evaluator unresolved |
| django__django-11583 | shunya | true | 0.058460 | 268781 | 22 |  |
| django__django-11620 | shunya | true | 0.208295 | 1317679 | 57 |  |

## Verification

- All expected predictions, logs, reports, patches, trajectories, and traces were present.
