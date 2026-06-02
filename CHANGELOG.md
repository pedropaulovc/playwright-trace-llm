# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-06-01

### Added

- Initial release: `playwright-trace-llm <trace.zip> -o <dir>` CLI and
  `exportTraceToMarkdown()` API.
- Exports `index.md`, `timeline.md`, `timeline-log.md`, `errors.md`,
  `console.md`, `network.md`, `metadata.md`, `filmstrip.md`, `attachments.md`,
  plus DOM snapshots (HTML), resources, and attachments under `assets/`.
- Extracted from the Playwright `feat/export-trace` fork; runtime dependency is
  `yauzl` only.

[Unreleased]: https://github.com/pedropaulovc/playwright-trace-llm/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pedropaulovc/playwright-trace-llm/releases/tag/v0.1.0
