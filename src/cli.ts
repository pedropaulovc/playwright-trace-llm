#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';

import { exportTraceToMarkdown } from './traceExporter';

const USAGE = `playwright-trace-llm — export a Playwright trace to LLM-friendly Markdown and HTML

Usage:
  playwright-trace-llm <trace.zip> [-o <dir>]

Arguments:
  <trace.zip>            Path to a Playwright trace ZIP (recorded with trace: 'on')

Options:
  -o, --output <dir>     Output directory (default: ./trace-export)
  -h, --help             Show this help

Examples:
  npx playwright-trace-llm trace.zip
  npx playwright-trace-llm trace.zip -o ./my-export`;

function parseArgs(argv: string[]): { trace?: string; output: string; help: boolean } {
  let output = './trace-export';
  let trace: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      output = argv[++i];
      continue;
    }
    if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
      continue;
    }
    if (!trace && !arg.startsWith('-')) {
      trace = arg;
      continue;
    }
  }

  return { trace, output, help };
}

async function main() {
  const { trace, output, help } = parseArgs(process.argv.slice(2));

  if (help || !trace) {
    console.log(USAGE);
    process.exit(help ? 0 : 1);
  }

  const traceFile = path.resolve(trace!);
  try {
    await exportTraceToMarkdown(traceFile, { outputDir: path.resolve(output) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log(`Trace exported to ${output}`);
}

void main();
