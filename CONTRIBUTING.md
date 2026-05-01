# Contributing to standdown-sdk

## Prerequisites

- Node.js ≥ 20.0.0
- pnpm ≥ 9.0.0 (`npm install -g pnpm`)

## Getting started

```bash
git clone <repo-url>
cd standdown-sdk
pnpm install
```

## Branch naming

```
feat/<short-description>      # New feature
fix/<short-description>       # Bug fix
chore/<short-description>     # Non-functional change (deps, config, CI)
docs/<short-description>      # Documentation only
```

## Commit convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/).
A Husky `commit-msg` hook enforces the format.

```
<type>(<optional scope>): <description>

feat(matcher): support glob patterns in domain field
fix(tracker): clear tab chain on tab replace event
docs: add JSDoc to PolicyLoader.load()
chore: bump tsup to 8.3.0
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

## Running tests locally

```bash
pnpm test              # Unit + integration tests (single run)
pnpm test:watch        # Watch mode
pnpm test:coverage     # Coverage report → coverage/lcov-report/index.html
pnpm test:e2e          # Playwright smoke tests (requires built dist/)
```

Before running E2E tests, build the SDK first:

```bash
pnpm build && pnpm test:e2e
```

## Quality gates

All of the following must pass before merging:

```bash
pnpm typecheck    # TypeScript strict mode
pnpm lint         # ESLint
pnpm test         # All unit + integration tests
pnpm build        # tsup dual ESM+CJS bundle
pnpm size         # Bundle size < 10 KB minified
```

These are enforced automatically by `ci.yml` on every PR and push to `main`.

## Pull requests

- Target branch: `main`
- Every PR must pass the full CI gate (ci.yml) before merging
- Squash-merge preferred to keep `main` history linear
- PR title must follow the commit convention (it becomes the squash commit message)

## Code style

Prettier and ESLint are configured and enforced by CI. Run auto-fix locally:

```bash
pnpm lint:fix
pnpm format
```
