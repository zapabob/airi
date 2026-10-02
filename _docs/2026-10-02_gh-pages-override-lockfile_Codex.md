# gh-pages override and lockfile remediation

## Overview
Moved the gh-pages security override from the root package manifest to pnpm-workspace.yaml, where pnpm 11 reads workspace-wide overrides, and regenerated the lockfile.

## Background / requirements
PR #2511 attempted to upgrade gh-pages for CVE-2022-37611, but the package.json pnpm field was ignored by pnpm 11 and the lockfile remained on gh-pages 4.0.0. The acceptance condition is that the committed lockfile resolves gh-pages 5.0.0.

## Assumptions / decisions
- Preserved the existing repository package manager version: pnpm 11.24.0.
- Used the existing workspace-level overrides block rather than adding a second configuration surface.
- Regenerated only the lockfile with scripts disabled.

## Changed files
- `package.json`: removed the ineffective `pnpm.overrides` block.
- `pnpm-workspace.yaml`: added `gh-pages: 5.0.0` to `overrides`.
- `pnpm-lock.yaml`: regenerated with pnpm 11.24.0; gh-pages and its affected transitive snapshots now resolve to 5.0.0-era dependencies.
- `_docs/2026-10-02_gh-pages-override-lockfile_Codex.md`: this implementation record.

## Implementation details
The workspace override is now parsed by pnpm 11. The lockfile records `gh-pages@5.0.0`, its integrity, the override, and the dependent snapshot reference. The vulnerable `gh-pages@4.0.0` entry is absent.

## Commands run
- `pnpm install --lockfile-only --ignore-scripts`
- `pnpm why gh-pages --depth 0`
- `pnpm list gh-pages --depth 0`
- `git diff --check`

## Test / verification results
- pnpm install completed successfully with pnpm v11.24.0; pnpm reported the lockfile passed repository supply-chain policies.
- `pnpm why gh-pages --depth 0` reported `gh-pages@5.0.0` through `pixi-live2d-display@0.4.0`.
- `pnpm list gh-pages --depth 0` found one version: 5.0.0.
- Lockfile inspection confirmed no `gh-pages@4.0.0` entry and `gh-pages: 5.0.0` in the override and dependent snapshot.
- `git diff --check` passed.

## Residual risk
The full monorepo test, lint, and build suites were not run because this change only affects dependency configuration and lockfile resolution. Existing deprecation and peer-dependency warnings were emitted by pnpm and are unrelated to this remediation.

## Next recommended action
Run the PR's normal CI checks and confirm the updated head SHA on PR #2511 after push.

## Selected controls
Applied: project `AGENTS.md`, PC implementation-start gate, PC security SOP, deep-research defense standard, MILSPEC baseline, GitHub operations, code review, and Windows verification guidance.
