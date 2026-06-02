# playwright-trace-llm

[![npm](https://img.shields.io/npm/v/playwright-trace-llm)](https://www.npmjs.com/package/playwright-trace-llm)

Export a Playwright trace ZIP into LLM-friendly **Markdown and HTML** for AI-assisted debugging. Same information as the [Trace Viewer](https://playwright.dev/docs/trace-viewer) GUI, in a form an LLM can read directly.

## Usage

No install needed:

```bash
npx playwright-trace-llm path/to/trace.zip -o ./trace-export
```

| Option | Description |
| --- | --- |
| `-o, --output <dir>` | Output directory (default: `./trace-export`) |
| `-h, --help` | Show help |

Record a trace by setting `trace: 'on'` in your Playwright config, or `await context.tracing.start({ screenshots: true, snapshots: true })`.

## What it produces

```
trace-export/
├── index.md          # Test summary: status, duration, viewport, actions
├── timeline.md       # Hierarchical action tree with snapshot links
├── timeline-log.md   # Detailed per-action Playwright processing logs
├── errors.md         # Errors and stack traces
├── console.md        # Browser console messages
├── network.md        # Network requests
├── metadata.md       # Browser/environment/timing
├── filmstrip.md      # Screencast frames
├── attachments.md    # Test attachments
└── assets/
    ├── snapshots/    # DOM snapshots as standalone HTML (CSS preserved)
    ├── resources/    # Screenshots and captured resources
    └── attachments/  # Extracted attachments
```

DOM snapshots use relative paths, so serve them over HTTP to view:

```bash
cd trace-export && npx serve
# open http://localhost:3000/assets/snapshots/after@call@123.html
```

## Programmatic API

```ts
import { exportTraceToMarkdown } from 'playwright-trace-llm';

await exportTraceToMarkdown('path/to/trace.zip', { outputDir: './trace-export' });
```

## How it relates to Playwright

The export logic is extracted from a [fork of Playwright](https://github.com/pedropaulovc/playwright) (the `feat/export-trace` branch), packaged to run standalone without a full Playwright install. It reads `.trace` and `.network` files from the ZIP directly — its only runtime dependency is `yauzl`. See [NOTICE](NOTICE) for attribution.

## Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

See [AGENTS.md](AGENTS.md) for publishing instructions and project conventions.

## License

Apache-2.0
