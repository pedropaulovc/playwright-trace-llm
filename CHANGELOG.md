# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-06-02

### Changed

- Promoted to a stable 1.0.0 release. No code changes from 0.1.2 — verified
  end to end against a real-world production trace (a failing parallel-run
  trace: 49 actions, 2 errors, 28 DOM snapshots, 99 network requests) with the
  test name, FAILED status, error diffs, hierarchical timeline, and assets all
  exported correctly.

## [0.1.2] - 2026-06-02

### Changed

- Corrected copyright attribution: `traceExporter.ts`, `cli.ts`, and `index.ts`
  are original work (Copyright © 2026 Pedro Paulo Vezza Campos). Only the
  vendored helpers (`zipFile.ts`, `stringUtils.ts`, `snapshot.ts`) carry the
  Playwright (Microsoft/Google) attribution. Updated NOTICE, LICENSE, README,
  and source headers accordingly.

## [0.1.1] - 2026-06-02

### Fixed

- Normalized the `bin` target (`lib/cli.js`) and `repository.url` (`git+https`)
  in package.json, removing the npm publish auto-correction warnings. No
  functional change from 0.1.0. First release through the automated
  trusted-publishing flow.

## [0.1.0] - 2026-06-01

### Added

- Initial release: `playwright-trace-llm <trace.zip> -o <dir>` CLI and
  `exportTraceToMarkdown()` API.
- Exports `index.md`, `timeline.md`, `timeline-log.md`, `errors.md`,
  `console.md`, `network.md`, `metadata.md`, `filmstrip.md`, `attachments.md`,
  plus DOM snapshots (HTML), resources, and attachments under `assets/`.
- Extracted from the Playwright `feat/export-trace` fork; runtime dependency is
  `yauzl` only.

[Unreleased]: https://github.com/pedropaulovc/playwright-trace-llm/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/pedropaulovc/playwright-trace-llm/compare/v0.1.2...v1.0.0
[0.1.2]: https://github.com/pedropaulovc/playwright-trace-llm/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/pedropaulovc/playwright-trace-llm/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/pedropaulovc/playwright-trace-llm/releases/tag/v0.1.0
