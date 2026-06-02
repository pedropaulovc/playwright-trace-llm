# playwright-trace-llm

Standalone CLI/library that converts a Playwright trace ZIP into LLM-friendly
Markdown + HTML. The export logic is extracted from the Playwright
`feat/export-trace` fork.

## Project Structure

```
src/traceExporter.ts            # Core: exportTraceToMarkdown() — the payload
src/cli.ts                      # bin entry (playwright-trace-llm)
src/index.ts                    # Public API re-exports
src/zipFile.ts                  # ZipFile wrapper over yauzl (vendored)
src/stringUtils.ts              # escapeHTML / escapeHTMLAttribute (vendored)
src/snapshot.ts                 # Trace snapshot types (vendored, type-only)
test/trace-exporter.spec.ts     # Playwright test suite
test/assets/*.zip               # Trace fixtures
lib/                            # tsc build output (published, gitignored)
tsconfig.json                   # Typecheck config (src + test)
tsconfig.build.json             # Emit config (src -> lib)
playwright.config.ts            # Test runner config
CHANGELOG.md                    # Keep a Changelog format
.github/workflows/ci.yml        # CI: typecheck + build + test on PRs and main
.github/workflows/auto-tag.yml  # Auto-creates v* tag from package.json on main push
.github/workflows/publish.yml   # Release + publish on v* tag push
```

## Commands

- `npm run build` — Compile `src/` to `lib/`
- `npm run typecheck` — Typecheck `src/` and `test/` (no emit)
- `npm test` — Run the Playwright test suite (needs `npx playwright install chromium`)

## Relationship to the Playwright Fork

`src/traceExporter.ts` is original work (Copyright © 2026 Pedro Paulo Vezza
Campos), developed as the `export-trace` feature on
[pedropaulovc/playwright `feat/export-trace`](https://github.com/pedropaulovc/playwright/tree/feat/export-trace).
`src/zipFile.ts`, `src/stringUtils.ts`, and `src/snapshot.ts` are small helpers
vendored from Playwright (Copyright © Microsoft / Google). When the fork's
feature changes, re-copy `traceExporter.ts` (and the helpers if they changed)
and re-apply the import rewrites:

- `../../utils/zipFile` → `./zipFile` (and point `zipFile.ts` at the `yauzl` npm package)
- `../../../utils/isomorphic/stringUtils` → `./stringUtils`
- `@trace/snapshot` → `./snapshot`

The cross-file `attribute sync` test from the fork is intentionally dropped here
(it parses monorepo-internal files that don't exist standalone).

## Publishing a New Version

The publish workflow runs on `v*` tag push: it typechecks, builds, tests,
creates a GitHub Release from the CHANGELOG entry, and publishes to npm with
provenance.

### Steps

1. Make your changes under `src/`
2. Run `npm run typecheck`, `npm run build`, and `npm test` locally
3. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` (above `[Unreleased]` contents)
4. Update the comparison links at the bottom of `CHANGELOG.md`
5. Bump `version` in `package.json`
6. Open a PR and merge to `main`
7. `auto-tag` creates a `v*` tag if one doesn't exist for the version
8. `publish` triggers on the new tag: verify version match -> extract changelog -> create GitHub Release -> publish to npm

### Version Semantics

This project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

- **Patch**: bug fixes, output formatting tweaks
- **Minor**: new output sections, new CLI flags, new exported API
- **Major**: breaking changes to the CLI interface or exported API

### If the Workflow Fails

- **Version mismatch**: `package.json` version must match the tag (tag `v0.2.0` -> `"0.2.0"`)
- **Missing changelog**: Add a `## [x.y.z]` section to `CHANGELOG.md` for the version
- **npm auth**: Uses trusted publishing (OIDC). `NPM_TOKEN` is injected into the `npm` GitHub environment

## Setup After Creating From Template

1. Configure npm trusted publishing for the package
2. Create an `npm` environment in the GitHub repo
3. Create a tag ruleset to make `v*` tags immutable (block update + deletion)
