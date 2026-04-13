# Contributing to MergeWire Action

## Commit Convention

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). Commit messages drive automatic semver versioning on release.

| Prefix                                                          | Effect                  | Example                          |
| --------------------------------------------------------------- | ----------------------- | -------------------------------- |
| `fix:`                                                          | patch release (1.0.x)   | `fix: handle empty plan JSON`    |
| `feat:`                                                         | minor release (1.x.0)   | `feat: add post-comment input`   |
| any `type!:` (e.g. `feat!:`) or `BREAKING CHANGE:` in footer    | major release (x.0.0)   | `feat!: remove api-secret input` |
| all other types (`chore:`, `docs:`, `test:`, `refactor:`, etc.) | patch release (default) | `chore: update dependencies`     |

## Releasing

Releases are created manually from the GitHub Actions UI:

1. Go to **Actions → Release → Run workflow**
2. Click **Run workflow**
3. The workflow will:
   - Detect the correct semver bump from commits since the last release
   - Bump `package.json`
   - Rebuild `dist-packed/`
   - Commit, tag, and push
   - Update the floating major version tag (e.g. `v1`, `v2`)
   - Create a GitHub Release with auto-generated notes

No manual tagging or version editing required.

## Setup

```bash
npm ci
npm test
npm run typecheck
npm run lint
```

## Building locally

```bash
npm run release
```

This runs `tsc` then `ncc` and writes the bundle to `dist-packed/index.js`.
