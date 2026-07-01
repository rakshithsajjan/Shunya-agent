# Development Rules

## Start Here For Shunya Work

This fork is `Shunya-agent`: a Pi-derived research harness for testing
measurement-first, token-efficient coding-agent behavior. Preserve Pi's working
coding-agent surface and make Shunya changes narrow, replayable, and justified
by benchmark evidence.

Read these first, in order:

1. `GOAL.md` for the research north star.
2. `dev-notes/benchmark/INDEX.md` for current benchmark state and next work.
3. `dev-notes/benchmark/EXPERIMENT_PROTOCOL.md` before running or moving benchmark artifacts.
4. `progress.md` for chronological work history.

Context-compression references:

- `dev-notes/context-compression/tool-output-compression-research.md`
- `dev-notes/context-compression/session-context-profile.md`
- `dev-notes/context-compression/roadmap.md`
- `scripts/*compression*.py` and `scripts/session_context_profile.py`
- `analysis/session_context_profile/`

When adding retention, compaction, or context accounting, make the token math explicit:

- first-seen user, tool, and assistant content is uncached or cache-write input
- later replay of the same content is cached-read input
- new summaries are uncached or cache-write input on first use and cached after
- tool-output compression must be measured at internal tool-call boundaries, not only final replies

Update `progress.md` after meaningful work with scope, files touched,
verification commands, outcomes, and follow-up work.

## Communication

- Keep replies short, direct, and technical.
- No emojis in commits, issues, PR comments, docs, or code.
- No fluff or cheerful filler.
- Answer user questions before implementation.
- When responding to feedback or analysis, explicitly say whether you agree or disagree before describing changes.

## Code Quality

- Read files in full before broad changes or audits.
- Match existing style and patterns.
- Check installed libraries and external API types before using them.
- No `any` unless unavoidable.
- Inline single-line helpers with only one call site.
- No inline imports or dynamic type imports. Use top-level imports.
- Use only erasable TypeScript syntax in root-configured TS files: no parameter properties, `enum`, `namespace`, `module`, `import =`, or `export =`.
- Never remove or downgrade code or dependencies to silence type errors. Fix the root cause.
- Ask before removing intentional functionality.
- Do not preserve backward compatibility unless requested.
- Never hardcode key checks. Add configurable defaults instead.
- Never edit `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts`, then regenerate.

## Validation Commands

- After code changes, run `npm run check` with full output and fix all diagnostics.
- Do not run `npm run build` or `npm test` unless requested.
- Do not run the full Vitest suite directly. Use `./test.sh` for non-e2e tests, or run specific tests from the package root with `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run that test and iterate until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` and the faux provider only.
- Put issue regressions under `packages/coding-agent/test/suite/regressions/` as `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, write them to `/tmp`, run, edit if needed, then remove. Do not embed multi-line scripts in shell commands.
- Documentation-only changes do not require `npm run check`; verify by reading the edited files.

## Dependency Security

- Treat npm dependency and lockfile changes as reviewed code.
- Direct external dependencies stay pinned to exact versions.
- Hydrate/update with `npm install --ignore-scripts`.
- Use `npm ci --ignore-scripts` for clean installs.
- Do not run lifecycle scripts unless requested.
- For dep metadata changes, refresh lockfiles with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regeneration, run `node scripts/generate-coding-agent-shrinkwrap.mjs` and verify with `--check` or `npm run check`.
- New deps with lifecycle scripts require review and an explicit allowlist entry. Never add one silently.

## Git Safety

Multiple sessions may share this worktree. Do not stomp other work.

- Never commit unless requested.
- Only commit files changed in the current session.
- Stage explicit paths only. Never use `git add -A` or `git add .`.
- Before committing, run `git status`, `git diff --cached`, and inspect for secrets.
- Commit format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <message>`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`.
- If rebase conflicts touch files you did not modify, abort and ask.
- Never force push.

## Benchmark Discipline

Before touching benchmark scripts, results, or VPS artifacts, read
`dev-notes/benchmark/INDEX.md` and `dev-notes/benchmark/EXPERIMENT_PROTOCOL.md`.

Rules:

- Every run needs a unique run directory.
- Do not reuse trace, session, evaluation, or experiments roots across runs.
- Record exact commands, git state, model, provider, goal plugin, task list, and hypothesis.
- Keep raw heavy artifacts separate from concise canonical summaries when possible.
- Do not treat missing-artifact summaries or contaminated retry outputs as benchmark evidence.

## Issues, PRs, And Changelogs

- See `CONTRIBUTING.md` for contributor gate rules.
- Do not check out PR branches unless explicitly asked.
- Inspect PRs with `gh pr view`, `gh pr diff`, `gh api`, or `git show` without moving branches.
- For issue creation, add relevant `pkg:*` labels.
- Post issue/PR comments from a temp file with `--body-file`.
- End AI-posted comments with the disclaimer required by the originating prompt.
- Changelogs live in `packages/*/CHANGELOG.md`; only edit `[Unreleased]` sections.

## Interactive Testing

Run the TUI in tmux from repo root:

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape
tmux kill-session -t pi-test
```

## Releasing

Only release when explicitly asked.

- Ask whether `/cl` was run on latest `main`; if not, the user must run it first.
- Releases are lockstep across packages. `patch` is fixes/additions, `minor` is breaking changes.
- Run local release smoke tests from outside the repo before release.
- Release commands use `PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0` only for the release command.
- The release script commits, tags, and pushes. Do not rerun it after a tag was pushed.

## User Override

If user instructions conflict with these rules, ask for explicit confirmation before overriding.
