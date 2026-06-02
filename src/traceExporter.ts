/**
 * Copyright (c) 2026 Pedro Paulo Vezza Campos.
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

import fs from 'fs';
import path from 'path';

import { ZipFile } from './zipFile';
import { escapeHTMLAttribute, escapeHTML } from './stringUtils';

import type { FrameSnapshot, NodeSnapshot, NodeNameAttributesChildNodesSnapshot, SubtreeReferenceSnapshot, ResourceOverride } from './snapshot';

export interface TraceExportOptions {
  outputDir: string;
}

// Simplified types for trace parsing
interface TraceContextOptions {
  baseURL?: string;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  isMobile?: boolean;
  userAgent?: string;
}

interface TraceContext {
  title?: string;
  browserName: string;
  channel?: string;
  platform?: string;
  playwrightVersion?: string;
  wallTime: number;
  startTime: number;
  endTime: number;
  sdkLanguage?: string;
  options: TraceContextOptions;
  actions: TraceAction[];
  events: TraceEvent[];
  errors: TraceError[];
  resources: TraceResource[];
  pages: TracePage[];
  snapshots: TraceFrameSnapshot[];
  // URL -> SHA1 map from network resources
  networkResourceMap: Map<string, string>;
}

interface TraceAttachment {
  name: string;
  contentType: string;
  path?: string;
  sha1?: string;
}

interface TraceAction {
  callId: string;
  class: string;
  method: string;
  params: Record<string, any>;
  startTime: number;
  endTime: number;
  log: Array<{ time: number; message: string }>;
  error?: { message: string; name?: string; stack?: string };
  result?: any;
  stack?: Array<{ file: string; line: number; column: number; function?: string }>;
  beforeSnapshot?: string;
  afterSnapshot?: string;
  inputSnapshot?: string;  // Snapshot with target highlight for click actions
  point?: { x: number; y: number };  // Click coordinates
  pageId?: string;
  parentId?: string;
  title?: string;
  group?: string;
  stepId?: string;  // Links API actions to Test actions
  attachments?: TraceAttachment[];
}

interface ActionTreeItem {
  action: TraceAction;
  children: ActionTreeItem[];
  parent?: ActionTreeItem;
}

interface TraceEvent {
  type: string;
  time: number;
  messageType?: string;
  text?: string;
  location?: { url: string; lineNumber: number; columnNumber: number };
}

interface TraceError {
  message: string;
  stack?: Array<{ file: string; line: number; column: number; function?: string }>;
}

interface TraceResource {
  request: {
    method: string;
    url: string;
  };
  response: {
    status: number;
    content?: {
      size?: number;
      text?: string;
      _sha1?: string;
    };
    _failureText?: string;
  };
}

interface TracePage {
  pageId: string;
  screencastFrames: Array<{ sha1: string; timestamp: number }>;
}

interface TraceFrameSnapshot {
  snapshotName: string;
  callId: string;
  pageId: string;
  frameId: string;
  frameUrl: string;
  html: NodeSnapshot;
  timestamp: number;
  resourceOverrides: ResourceOverride[];
  doctype?: string;
  viewport?: { width: number; height: number };
}

export async function exportTraceToMarkdown(
  traceFile: string,
  options: TraceExportOptions
): Promise<void> {
  const context = await parseTrace(traceFile);

  // Create output directories
  const outputDir = options.outputDir;
  const assetsDir = path.join(outputDir, 'assets');
  const snapshotsDir = path.join(assetsDir, 'snapshots');

  await fs.promises.mkdir(outputDir, { recursive: true });

  // Extract assets
  await fs.promises.mkdir(snapshotsDir, { recursive: true });
  const assetMap = await extractAssets(traceFile, context, outputDir);

  // Generate Markdown files
  const files = [
    { name: 'README.md', content: generateReadmeMarkdown() },
    { name: 'index.md', content: generateIndexMarkdown(context, traceFile) },
    { name: 'metadata.md', content: generateMetadataMarkdown(context) },
    { name: 'timeline.md', content: generateTimelineMarkdown(context.actions, assetMap, buildStepSnapshotMap(context.actions)) },
    { name: 'timeline-log.md', content: generateTimelineLogMarkdown(context.actions) },
    { name: 'errors.md', content: generateErrorsMarkdown(context.errors, context.actions) },
    { name: 'console.md', content: generateConsoleMarkdown(context.events) },
    { name: 'network.md', content: generateNetworkMarkdown(context.resources) },
    { name: 'filmstrip.md', content: generateFilmstripMarkdown(context.pages, context.startTime, assetMap) },
    { name: 'attachments.md', content: generateAttachmentsMarkdown(context.actions, assetMap) },
  ];

  for (const file of files)
    await fs.promises.writeFile(path.join(outputDir, file.name), file.content);
}

async function parseTrace(traceFile: string): Promise<TraceContext> {
  const zipFile = new ZipFile(traceFile);
  const entries = await zipFile.entries();

  const context: TraceContext = {
    browserName: 'Unknown',
    wallTime: 0,
    startTime: Number.MAX_SAFE_INTEGER,
    endTime: 0,
    options: {},
    actions: [],
    events: [],
    errors: [],
    resources: [],
    pages: [],
    snapshots: [],
    networkResourceMap: new Map(),
  };

  const actionMap = new Map<string, TraceAction>();
  const pageMap = new Map<string, TracePage>();

  // Find and parse trace files
  const traceEntries = entries.filter(name => name.endsWith('.trace'));
  const networkEntries = entries.filter(name => name.endsWith('.network'));

  for (const entryName of [...traceEntries, ...networkEntries]) {
    const content = await zipFile.read(entryName);
    const lines = content.toString('utf-8').split('\n');

    for (const line of lines) {
      if (!line.trim())
        continue;

      try {
        const event = JSON.parse(line);
        processTraceEvent(event, context, actionMap, pageMap);
      } catch {
        // Skip invalid JSON lines
      }
    }
  }

  context.actions = [...actionMap.values()].sort((a, b) => a.startTime - b.startTime);
  context.pages = [...pageMap.values()];

  // Calculate end time
  for (const action of context.actions) {
    if (action.endTime > context.endTime)
      context.endTime = action.endTime;
  }

  zipFile.close();
  return context;
}

function processTraceEvent(
  event: any,
  context: TraceContext,
  actionMap: Map<string, TraceAction>,
  pageMap: Map<string, TracePage>
) {
  switch (event.type) {
    case 'context-options':
      context.browserName = event.browserName || 'Unknown';
      context.channel = event.channel;
      context.title = event.title;
      context.platform = event.platform;
      context.playwrightVersion = event.playwrightVersion;
      context.wallTime = event.wallTime || 0;
      context.startTime = event.monotonicTime || 0;
      context.sdkLanguage = event.sdkLanguage;
      context.options = event.options || {};
      break;

    case 'before':
      actionMap.set(event.callId, {
        callId: event.callId,
        class: event.class,
        method: event.method,
        params: event.params || {},
        startTime: event.startTime || 0,
        endTime: 0,
        log: [],
        stack: event.stack,
        beforeSnapshot: event.beforeSnapshot,
        pageId: event.pageId,
        parentId: event.parentId,
        title: event.title,
        group: event.group,
        stepId: event.stepId,
      });
      break;

    case 'after':
      const action = actionMap.get(event.callId);
      if (action) {
        action.endTime = event.endTime || action.startTime;
        action.error = event.error;
        action.result = event.result;
        action.afterSnapshot = event.afterSnapshot;
        if (event.attachments?.length) {
          action.attachments = event.attachments.map((a: any) => ({
            name: a.name,
            contentType: a.contentType,
            path: a.path,
            sha1: a.sha1,
          }));
        }
      }
      break;

    case 'input':
      const inputAction = actionMap.get(event.callId);
      if (inputAction) {
        inputAction.inputSnapshot = event.inputSnapshot;
        inputAction.point = event.point;
      }
      break;

    case 'log':
      const logAction = actionMap.get(event.callId);
      if (logAction) {
        logAction.log.push({
          time: event.time || 0,
          message: event.message || '',
        });
      }
      break;

    case 'console':
      context.events.push({
        type: 'console',
        time: event.time || 0,
        messageType: event.messageType,
        text: event.text,
        location: event.location,
      });
      break;

    case 'error':
      context.errors.push({
        message: event.message || 'Unknown error',
        stack: event.stack,
      });
      break;

    case 'resource-snapshot':
      if (event.snapshot) {
        const url = event.snapshot.request?.url || '';
        const sha1 = event.snapshot.response?.content?._sha1;

        context.resources.push({
          request: {
            method: event.snapshot.request?.method || 'GET',
            url,
          },
          response: {
            status: event.snapshot.response?.status || 0,
            content: event.snapshot.response?.content,
            _failureText: event.snapshot.response?._failureText,
          },
        });

        // Build URL -> SHA1 map for resource resolution
        if (url && sha1)
          context.networkResourceMap.set(url, sha1);
      }
      break;

    case 'screencast-frame':
      let page = pageMap.get(event.pageId);
      if (!page) {
        page = { pageId: event.pageId, screencastFrames: [] };
        pageMap.set(event.pageId, page);
      }
      page.screencastFrames.push({
        sha1: event.sha1,
        timestamp: event.timestamp || 0,
      });
      break;

    case 'frame-snapshot':
      if (event.snapshot) {
        context.snapshots.push({
          snapshotName: event.snapshot.snapshotName || '',
          callId: event.snapshot.callId || '',
          pageId: event.snapshot.pageId || '',
          frameId: event.snapshot.frameId || '',
          frameUrl: event.snapshot.frameUrl || '',
          html: event.snapshot.html,
          timestamp: event.snapshot.timestamp || 0,
          resourceOverrides: event.snapshot.resourceOverrides || [],
          doctype: event.snapshot.doctype,
          viewport: event.snapshot.viewport,
        });
      }
      break;
  }
}

async function extractAssets(
  traceFile: string,
  context: TraceContext,
  outputDir: string
): Promise<Map<string, string>> {
  const assetMap = new Map<string, string>();
  const zipFile = new ZipFile(traceFile);
  const entries = await zipFile.entries();

  const resourcesDir = path.join(outputDir, 'assets', 'resources');
  await fs.promises.mkdir(resourcesDir, { recursive: true });

  // Group snapshots by frameId to build snapshot chains for subtree reference resolution
  const snapshotsByFrame = new Map<string, TraceFrameSnapshot[]>();
  for (const snapshot of context.snapshots) {
    let frameSnapshots = snapshotsByFrame.get(snapshot.frameId);
    if (!frameSnapshots) {
      frameSnapshots = [];
      snapshotsByFrame.set(snapshot.frameId, frameSnapshots);
    }
    frameSnapshots.push(snapshot);
  }

  // Build map of snapshot names to highlight info (for click target highlighting)
  const snapshotHighlightInfo = new Map<string, { callId: string; point?: { x: number; y: number } }>();
  for (const action of context.actions) {
    if (action.inputSnapshot && action.point) {
      snapshotHighlightInfo.set(action.inputSnapshot, {
        callId: action.callId,
        point: action.point,
      });
    }
  }

  // Collect all SHA1s we need to extract
  const neededSha1s = new Set<string>();

  // 1. From resourceOverrides in snapshots (resolving ref chains)
  for (const snapshot of context.snapshots) {
    const frameSnapshots = snapshotsByFrame.get(snapshot.frameId) || [];
    const snapshotIndex = frameSnapshots.indexOf(snapshot);

    for (const override of snapshot.resourceOverrides) {
      if (override.sha1) {
        neededSha1s.add(override.sha1);
      } else if (override.ref !== undefined && snapshotIndex >= 0) {
        // Resolve ref chain
        const refIndex = snapshotIndex - override.ref;
        if (refIndex >= 0 && refIndex < frameSnapshots.length) {
          const refSnapshot = frameSnapshots[refIndex];
          const refOverride = refSnapshot.resourceOverrides.find(o => o.url === override.url);
          if (refOverride?.sha1)
            neededSha1s.add(refOverride.sha1);
        }
      }
    }
  }

  // 2. From screencast frames (screenshots)
  for (const page of context.pages) {
    for (const frame of page.screencastFrames)
      neededSha1s.add(frame.sha1);
  }

  // 3. From network resources (CSS, JS, images captured via HAR)
  for (const sha1 of context.networkResourceMap.values())
    neededSha1s.add(sha1);

  // 4. Build attachment sha1 -> name map (extracted separately below)
  const attachmentMap = new Map<string, string>(); // sha1 -> filename
  for (const action of context.actions) {
    if (action.attachments) {
      for (const attachment of action.attachments) {
        if (attachment.sha1)
          attachmentMap.set(attachment.sha1, attachment.name);
      }
    }
  }

  // Extract all needed resources (excluding attachments which are handled separately)
  for (const sha1 of neededSha1s) {
    // Skip attachments - they're extracted with friendly names below
    if (attachmentMap.has(sha1))
      continue;

    const resourcePath = `resources/${sha1}`;
    if (!entries.includes(resourcePath))
      continue;

    try {
      const buffer = await zipFile.read(resourcePath);
      const fullPath = path.join(resourcesDir, sha1);
      await fs.promises.writeFile(fullPath, buffer);
      assetMap.set(sha1, `./assets/resources/${sha1}`);
    } catch {
      // Skip files that fail to read
    }
  }

  // Extract attachments with friendly filenames
  const attachmentsDir = path.join(outputDir, 'assets', 'attachments');
  await fs.promises.mkdir(attachmentsDir, { recursive: true });

  for (const [sha1, filename] of attachmentMap) {
    const resourcePath = `resources/${sha1}`;
    if (!entries.includes(resourcePath))
      continue;

    try {
      const buffer = await zipFile.read(resourcePath);
      // Sanitize filename to prevent path traversal
      const safeName = filename.replace(/[/\\:*?"<>|]/g, '_');
      const fullPath = path.join(attachmentsDir, safeName);
      await fs.promises.writeFile(fullPath, buffer);
      assetMap.set(sha1, `./assets/attachments/${safeName}`);
    } catch {
      // Skip files that fail to read
    }
  }

  // Render frame snapshots to HTML
  const snapshotsDir = path.join(outputDir, 'assets', 'snapshots');
  await fs.promises.mkdir(snapshotsDir, { recursive: true });

  for (const snapshot of context.snapshots) {
    if (!snapshot.html || !snapshot.snapshotName)
      continue;

    try {
      const frameSnapshots = snapshotsByFrame.get(snapshot.frameId) || [];
      const snapshotIndex = frameSnapshots.indexOf(snapshot);
      const highlightInfo = snapshotHighlightInfo.get(snapshot.snapshotName);
      const renderer = new ExportSnapshotRenderer(frameSnapshots, snapshotIndex, context.networkResourceMap, highlightInfo);
      const html = renderer.render();

      // Extract any additional SHA1s discovered during rendering
      for (const sha1 of renderer.getUsedSha1s()) {
        if (!assetMap.has(sha1)) {
          const resourcePath = `resources/${sha1}`;
          if (entries.includes(resourcePath)) {
            try {
              const buffer = await zipFile.read(resourcePath);
              const fullPath = path.join(resourcesDir, sha1);
              await fs.promises.writeFile(fullPath, buffer);
              assetMap.set(sha1, `./assets/resources/${sha1}`);
            } catch {
              // Skip files that fail to read
            }
          }
        }
      }

      const safeName = snapshot.snapshotName.replace(/[^a-zA-Z0-9@_-]/g, '_');
      const relativePath = `assets/snapshots/${safeName}.html`;
      const fullPath = path.join(outputDir, relativePath);
      await fs.promises.writeFile(fullPath, html);
      assetMap.set(snapshot.snapshotName, `./${relativePath}`);
    } catch {
      // Skip snapshots that fail to render
    }
  }

  zipFile.close();
  return assetMap;
}

function generateReadmeMarkdown(): string {
  return `# Playwright Trace Export

This folder contains a Playwright trace exported to LLM-friendly Markdown format.

## Contents

- **index.md** - Overview with test status and error summary
- **timeline.md** - Step-by-step action timeline with links to DOM snapshots
- **timeline-log.md** - Detailed Playwright processing logs for each action
- **metadata.md** - Browser and environment information
- **errors.md** - Full error details with stack traces
- **console.md** - Browser console output
- **network.md** - HTTP request log
- **filmstrip.md** - Screenshot timeline
- **attachments.md** - Test attachments

## Viewing DOM Snapshots

The exported DOM snapshots include CSS and can be viewed in a browser. Since snapshots use relative paths, you need to serve them via HTTP:

\`\`\`bash
# Using npx serve
npx serve

# Or using Python
python -m http.server 8000
\`\`\`

Then open the snapshot URLs from \`timeline.md\`, for example:
- http://localhost:3000/assets/snapshots/after@call@123.html (npx serve)
- http://localhost:8000/assets/snapshots/after@call@123.html (Python)

## Loading Snapshots with Playwright

You can load exported snapshots into Playwright for automated DOM inspection:

\`\`\`js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Serve the export directory first, then:
  await page.goto('http://localhost:3000/assets/snapshots/after@call@123.html');

  // Inspect the DOM
  const title = await page.title();
  const buttons = await page.locator('button').all();
  console.log(\`Page has \${buttons.length} buttons\`);

  await browser.close();
})();
\`\`\`

This is useful for LLM-based analysis where the AI can navigate and inspect the captured page state.
`;
}

function generateIndexMarkdown(context: TraceContext, traceFile: string): string {
  const title = context.title || 'Trace Export';
  const duration = Math.round(context.endTime - context.startTime);
  const actionCount = context.actions.length;
  const errorCount = context.errors.length + context.actions.filter(a => a.error).length;
  const hasErrors = errorCount > 0;

  const errorSummary = collectErrorSummary(context);

  const viewport = context.options.viewport;
  const viewportStr = viewport ? `${viewport.width}x${viewport.height}` : 'Unknown';

  let md = `# Trace Export: ${title}\n\n`;
  md += `**Test:** \`${title}\`\n`;
  md += `**Source:** \`${traceFile}\`\n\n`;
  md += `**Status:** ${hasErrors ? 'FAILED' : 'PASSED'} | **Duration:** ${duration}ms | **Viewport:** ${viewportStr} | **Actions:** ${actionCount} | **Errors:** ${errorCount}\n\n`;

  if (errorSummary.length > 0) {
    md += `## Error Summary\n`;
    for (const error of errorSummary)
      md += `- ${error}\n`;
    md += '\n';
  }

  md += `## Sections\n`;
  md += `- [Timeline](./timeline.md) - Step-by-step action timeline\n`;
  md += `- [Timeline Log](./timeline-log.md) - Detailed Playwright processing logs\n`;
  md += `- [Metadata](./metadata.md) - Browser/environment info\n`;
  md += `- [Errors](./errors.md) - Full error details with stack traces\n`;
  md += `- [Console](./console.md) - Browser console output\n`;
  md += `- [Network](./network.md) - HTTP request log\n`;
  md += `- [Filmstrip](./filmstrip.md) - Screenshot timeline\n`;
  md += `- [Attachments](./attachments.md) - Test attachments\n`;

  return md;
}

function collectErrorSummary(context: TraceContext): string[] {
  const errors: string[] = [];

  for (const error of context.errors)
    errors.push(truncateString(stripAnsi(error.message), 100));

  for (const action of context.actions) {
    if (action.error)
      errors.push(truncateString(stripAnsi(action.error.message), 100));
  }

  return errors.slice(0, 10);
}

function generateMetadataMarkdown(context: TraceContext): string {
  let md = `# Trace Metadata\n\n`;

  md += `## Environment\n\n`;
  md += `| Property | Value |\n`;
  md += `|----------|-------|\n`;
  md += `| Browser | ${context.browserName || 'Unknown'} |\n`;
  if (context.channel)
    md += `| Channel | ${context.channel} |\n`;
  if (context.platform)
    md += `| Platform | ${context.platform} |\n`;
  if (context.playwrightVersion)
    md += `| Playwright Version | ${context.playwrightVersion} |\n`;
  if (context.sdkLanguage)
    md += `| SDK Language | ${context.sdkLanguage} |\n`;

  md += `\n## Context Options\n\n`;
  md += `| Property | Value |\n`;
  md += `|----------|-------|\n`;
  if (context.options.viewport)
    md += `| Viewport | ${context.options.viewport.width}x${context.options.viewport.height} |\n`;
  if (context.options.deviceScaleFactor)
    md += `| Device Scale Factor | ${context.options.deviceScaleFactor} |\n`;
  if (context.options.isMobile !== undefined)
    md += `| Mobile | ${context.options.isMobile} |\n`;
  if (context.options.userAgent)
    md += `| User Agent | ${truncateString(context.options.userAgent, 80)} |\n`;
  if (context.options.baseURL)
    md += `| Base URL | ${context.options.baseURL} |\n`;

  md += `\n## Timing\n\n`;
  md += `| Property | Value |\n`;
  md += `|----------|-------|\n`;
  md += `| Wall Time | ${new Date(context.wallTime).toISOString()} |\n`;
  md += `| Duration | ${Math.round(context.endTime - context.startTime)}ms |\n`;

  return md;
}

function buildActionTree(actions: TraceAction[]): ActionTreeItem {
  const itemMap = new Map<string, ActionTreeItem>();

  // Create tree items for each action
  for (const action of actions) {
    itemMap.set(action.callId, {
      action,
      children: [],
      parent: undefined,
    });
  }

  // Create root item
  const rootItem: ActionTreeItem = {
    action: {
      callId: 'root',
      class: 'Root',
      method: '',
      params: {},
      startTime: actions[0]?.startTime || 0,
      endTime: actions[actions.length - 1]?.endTime || 0,
      log: [],
    },
    children: [],
    parent: undefined,
  };

  // Link parent-child relationships
  for (const item of itemMap.values()) {
    const parent = item.action.parentId ? itemMap.get(item.action.parentId) || rootItem : rootItem;
    parent.children.push(item);
    item.parent = parent;
  }

  // Sort children by start time
  const sortChildren = (item: ActionTreeItem) => {
    item.children.sort((a, b) => a.action.startTime - b.action.startTime);
    for (const child of item.children)
      sortChildren(child);
  };
  sortChildren(rootItem);

  return rootItem;
}

function getActionTitle(action: TraceAction): string {
  // Use title if available (e.g., "Before Hooks", "Fixture: context")
  if (action.title)
    return action.title;

  // Fallback to class.method
  return `${action.class}.${action.method}`;
}

// Build a map from stepId (Test action callId) to snapshots (from API actions)
function buildStepSnapshotMap(actions: TraceAction[]): Map<string, { before?: string; input?: string; after?: string }> {
  const map = new Map<string, { before?: string; input?: string; after?: string }>();
  for (const action of actions) {
    if (action.stepId && (action.beforeSnapshot || action.inputSnapshot || action.afterSnapshot)) {
      const existing = map.get(action.stepId) || {};
      if (action.beforeSnapshot)
        existing.before = action.beforeSnapshot;
      if (action.inputSnapshot)
        existing.input = action.inputSnapshot;
      if (action.afterSnapshot)
        existing.after = action.afterSnapshot;
      map.set(action.stepId, existing);
    }
  }
  return map;
}

function generateTimelineMarkdown(actions: TraceAction[], assetMap: Map<string, string>, stepSnapshotMap: Map<string, { before?: string; input?: string; after?: string }>): string {
  if (actions.length === 0)
    return `# Actions Timeline\n\nNo actions recorded.\n`;

  // Only show Test-class actions (the hierarchical test steps), not API-level calls
  const filteredActions = actions.filter(action => action.class === 'Test');

  const startTime = filteredActions[0]?.startTime || 0;
  const totalDuration = filteredActions.length > 0 ? (filteredActions[filteredActions.length - 1].endTime || filteredActions[filteredActions.length - 1].startTime) - startTime : 0;

  // Build tree structure
  const rootItem = buildActionTree(filteredActions);

  // Generate table of contents for top-level items
  const tocEntries: string[] = [];
  for (let i = 0; i < rootItem.children.length; i++) {
    const item = rootItem.children[i];
    const number = `${i + 1}`;
    const title = getActionTitle(item.action);
    const hasError = !!item.action.error;
    const headingText = `${number}. ${title}${hasError ? ' - ERROR' : ''}`;
    const anchor = headingText.toLowerCase().replace(/[^\w\s-]/g, '').replace(/ /g, '-');
    tocEntries.push(`- [${headingText}](#${anchor})`);
  }

  let md = `# Actions Timeline\n\n`;
  md += `Total actions: ${filteredActions.length} | Duration: ${Math.round(totalDuration)}ms\n\n`;

  if (tocEntries.length > 0) {
    md += `## Contents\n\n`;
    md += tocEntries.join('\n') + '\n\n';
  }

  // Render tree with hierarchical numbering
  const renderItem = (item: ActionTreeItem, prefix: string, index: number, depth: number) => {
    const action = item.action;
    if (action.callId === 'root')
      return;

    const number = prefix ? `${prefix}.${index}` : `${index}`;
    const relativeTime = action.startTime - startTime;
    const duration = (action.endTime || action.startTime) - action.startTime;
    const hasError = !!action.error;
    const title = getActionTitle(action);

    // Use heading level based on depth (h2-h6, then stay at h6)
    const headingLevel = Math.min(depth + 1, 6);
    const heading = '#'.repeat(headingLevel);

    md += `${heading} ${number}. ${title}${hasError ? ' - ERROR' : ''}\n\n`;

    // Time and duration as list items
    md += `- **Start:** ${Math.round(relativeTime)}ms\n`;
    md += `- **Duration:** ${Math.round(duration)}ms\n`;

    // Parameters (skip internal ones)
    if (action.params && Object.keys(action.params).length > 0 && action.group !== 'internal') {
      const paramsStr = formatParams(action.params);
      if (paramsStr !== '{}')
        md += `- **Params:** \`${paramsStr}\`\n`;
    }

    // Result or error
    if (hasError)
      md += `- **Error:** ${stripAnsi(action.error!.message)}\n`;
    else if (action.result !== undefined && action.group !== 'internal')
      md += `- **Result:** ${formatResult(action.result)}\n`;

    // Source location
    if (action.stack && action.stack.length > 0) {
      const frame = action.stack[0];
      md += `- **Source:** \`${frame.file}:${frame.line}\`\n`;
    }

    // Snapshots - check action's own snapshots or lookup via stepSnapshotMap
    const stepSnapshots = stepSnapshotMap.get(action.callId);
    const beforeSnapshotName = action.beforeSnapshot || stepSnapshots?.before;
    const inputSnapshotName = action.inputSnapshot || stepSnapshots?.input;
    const afterSnapshotName = action.afterSnapshot || stepSnapshots?.after;
    const beforeSnapshot = beforeSnapshotName ? resolveSnapshotLink(beforeSnapshotName, assetMap) : null;
    const inputSnapshot = inputSnapshotName ? resolveSnapshotLink(inputSnapshotName, assetMap) : null;
    const afterSnapshot = afterSnapshotName ? resolveSnapshotLink(afterSnapshotName, assetMap) : null;
    if (beforeSnapshot || inputSnapshot || afterSnapshot) {
      const links: string[] = [];
      if (beforeSnapshot)
        links.push(`[before](${beforeSnapshot})`);
      if (inputSnapshot)
        links.push(`[input](${inputSnapshot})`);
      if (afterSnapshot)
        links.push(`[after](${afterSnapshot})`);
      md += `- **Snapshots:** ${links.join(' | ')}\n`;
    }

    // Attachments
    if (action.attachments && action.attachments.length > 0) {
      const attachmentLinks = action.attachments
        .filter(a => a.sha1)
        .map(a => {
          const resourcePath = assetMap.get(a.sha1!) || `./assets/resources/${a.sha1}`;
          return `[${a.name}](${resourcePath})`;
        });
      if (attachmentLinks.length > 0)
        md += `- **Attachments:** ${attachmentLinks.join(' | ')}\n`;
    }

    // Action log
    if (action.log && action.log.length > 0) {
      md += `\n<details><summary>Action Log</summary>\n\n`;
      for (const entry of action.log)
        md += `- ${entry.message}\n`;
      md += `\n</details>\n`;
    }

    // Stack trace for errors
    if (hasError && action.stack && action.stack.length > 0) {
      md += `\n<details><summary>Stack Trace</summary>\n\n`;
      md += '```\n';
      md += `Error: ${stripAnsi(action.error!.message)}\n`;
      for (const frame of action.stack)
        md += `  at ${frame.function || '(anonymous)'} (${frame.file}:${frame.line}:${frame.column})\n`;
      md += '```\n\n';
      md += `</details>\n`;
    }

    md += `\n`;

    // Render children
    for (let i = 0; i < item.children.length; i++)
      renderItem(item.children[i], number, i + 1, depth + 1);
  };

  // Render all top-level items
  for (let i = 0; i < rootItem.children.length; i++)
    renderItem(rootItem.children[i], '', i + 1, 1);

  return md;
}

function resolveSnapshotLink(snapshotName: string, assetMap: Map<string, string>): string | null {
  // Direct match by snapshot name
  if (assetMap.has(snapshotName))
    return assetMap.get(snapshotName)!;

  // Try partial match
  for (const [key, assetPath] of assetMap) {
    if (snapshotName.includes(key) || key.includes(snapshotName))
      return assetPath;
  }
  return null;
}

function generateTimelineLogMarkdown(actions: TraceAction[]): string {
  if (actions.length === 0)
    return `# Actions Timeline Log\n\nNo actions recorded.\n`;

  // Check if this is a newer trace format with stepId linking API actions to Test actions
  // Older traces don't have stepId on API actions, so logs can't be linked to Test actions
  const hasStepIdLinks = actions.some(action => action.class !== 'Test' && action.stepId);
  if (!hasStepIdLinks)
    return `# Actions Timeline Log\n\nTimeline logs are not available for this trace format. This feature requires traces recorded with Playwright 1.49 or later.\n`;

  // Only show Test-class actions (the hierarchical test steps), not API-level calls
  const filteredActions = actions.filter(action => action.class === 'Test');

  if (filteredActions.length === 0)
    return `# Actions Timeline Log\n\nNo test actions recorded.\n`;

  // Build tree structure
  const rootItem = buildActionTree(filteredActions);

  // Build a map from Test action callId to all API-level logs
  // API actions have stepId pointing to their parent Test action
  const actionLogsMap = new Map<string, Array<{ time: number; message: string }>>();
  for (const action of actions) {
    // Collect logs from API-level actions that reference Test actions via stepId
    if (action.stepId && action.log.length > 0) {
      const existing = actionLogsMap.get(action.stepId) || [];
      existing.push(...action.log);
      actionLogsMap.set(action.stepId, existing);
    }
    // Also collect logs directly on Test actions
    if (action.class === 'Test' && action.log.length > 0) {
      const existing = actionLogsMap.get(action.callId) || [];
      existing.push(...action.log);
      actionLogsMap.set(action.callId, existing);
    }
  }

  // Sort logs by time for each action
  for (const logs of actionLogsMap.values())
    logs.sort((a, b) => a.time - b.time);

  // Generate table of contents for top-level items
  const tocEntries: string[] = [];
  for (let i = 0; i < rootItem.children.length; i++) {
    const item = rootItem.children[i];
    const number = `${i + 1}`;
    const title = getActionTitle(item.action);
    const hasError = !!item.action.error;
    const headingText = `${number}. ${title}${hasError ? ' - ERROR' : ''}`;
    const anchor = headingText.toLowerCase().replace(/[^\w\s-]/g, '').replace(/ /g, '-');
    tocEntries.push(`- [${headingText}](#${anchor})`);
  }

  let md = `# Actions Timeline Log\n\n`;
  md += `Detailed Playwright processing logs for each action. Shows how Playwright resolved locators, waited for elements, and performed actions.\n\n`;
  md += `Total actions: ${filteredActions.length}\n\n`;

  if (tocEntries.length > 0) {
    md += `## Contents\n\n`;
    md += tocEntries.join('\n') + '\n\n';
  }

  // Render tree with hierarchical numbering
  const renderItem = (item: ActionTreeItem, prefix: string, index: number, depth: number) => {
    const action = item.action;
    if (action.callId === 'root')
      return;

    const number = prefix ? `${prefix}.${index}` : `${index}`;
    const hasError = !!action.error;
    const title = getActionTitle(action);

    // Use heading level based on depth (h2-h6, then stay at h6)
    const headingLevel = Math.min(depth + 1, 6);
    const heading = '#'.repeat(headingLevel);

    md += `${heading} ${number}. ${title}${hasError ? ' - ERROR' : ''}\n\n`;

    // Get logs for this action
    const logs = actionLogsMap.get(action.callId) || [];

    if (logs.length > 0) {
      md += '```\n';
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        // Calculate duration to next log or action end
        let duration = '';
        if (i + 1 < logs.length) {
          const ms = Math.max(0, Math.round(logs[i + 1].time - log.time));
          duration = ` (${ms}ms)`;
        } else if (action.endTime > 0) {
          const ms = Math.max(0, Math.round(action.endTime - log.time));
          duration = ` (${ms}ms)`;
        }

        md += `${log.message}${duration}\n`;
      }
      md += '```\n\n';
    } else {
      md += `_No log entries_\n\n`;
    }

    // Render children
    for (let i = 0; i < item.children.length; i++)
      renderItem(item.children[i], number, i + 1, depth + 1);
  };

  // Render all top-level items
  for (let i = 0; i < rootItem.children.length; i++)
    renderItem(rootItem.children[i], '', i + 1, 1);

  return md;
}

function generateErrorsMarkdown(errors: TraceError[], actions: TraceAction[]): string {
  const allErrors: Array<{ message: string; stack?: TraceError['stack']; source?: string }> = [];

  for (const error of errors) {
    allErrors.push({
      message: stripAnsi(error.message),
      stack: error.stack,
    });
  }

  for (const action of actions) {
    if (action.error) {
      allErrors.push({
        message: stripAnsi(action.error.message),
        stack: action.stack,
        source: action.stack?.[0] ? `${action.stack[0].file}:${action.stack[0].line}` : undefined,
      });
    }
  }

  if (allErrors.length === 0)
    return `# Errors\n\nNo errors recorded.\n`;

  let md = `# Errors\n\n`;
  md += `Total errors: ${allErrors.length}\n\n`;

  for (let i = 0; i < allErrors.length; i++) {
    const error = allErrors[i];
    md += `## Error ${i + 1}\n\n`;
    md += `**Message:** ${error.message}\n\n`;

    if (error.source)
      md += `**Source:** \`${error.source}\`\n\n`;

    if (error.stack && error.stack.length > 0) {
      md += `**Stack Trace:**\n\n`;
      md += '```\n';
      for (const frame of error.stack)
        md += `  at ${frame.function || '(anonymous)'} (${frame.file}:${frame.line}:${frame.column})\n`;
      md += '```\n\n';
    }

    md += `---\n\n`;
  }

  return md;
}

function generateConsoleMarkdown(events: TraceEvent[]): string {
  const consoleEvents = events.filter(e => e.type === 'console');

  if (consoleEvents.length === 0)
    return `# Console Log\n\nNo console messages recorded.\n`;

  let md = `# Console Log\n\n`;
  md += `Total messages: ${consoleEvents.length}\n\n`;
  md += `| Time | Type | Message | Location |\n`;
  md += `|------|------|---------|----------|\n`;

  for (const event of consoleEvents) {
    const message = truncateString(event.text || '', 100).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const location = event.location ? `${event.location.url}:${event.location.lineNumber}` : '';
    md += `| ${event.time}ms | ${event.messageType || 'log'} | ${message} | ${truncateString(location, 50)} |\n`;
  }

  return md;
}

function generateNetworkMarkdown(resources: TraceResource[]): string {
  if (resources.length === 0)
    return `# Network Log\n\nNo network requests recorded.\n`;

  let md = `# Network Log\n\n`;
  md += `Total requests: ${resources.length}\n\n`;

  md += `| # | Method | URL | Status | Size |\n`;
  md += `|---|--------|-----|--------|------|\n`;

  const failedRequests: TraceResource[] = [];

  for (let i = 0; i < resources.length; i++) {
    const resource = resources[i];
    const url = resource.request.url.replace(/\|/g, '\\|');
    const status = resource.response.status;
    const size = formatSize(resource.response.content?.size);

    md += `| ${i + 1} | ${resource.request.method} | ${url} | ${status} | ${size} |\n`;

    if (status >= 400)
      failedRequests.push(resource);
  }

  if (failedRequests.length > 0) {
    md += `\n## Failed Requests\n\n`;

    for (const resource of failedRequests) {
      md += `### ${resource.request.method} ${resource.request.url} - ${resource.response.status}\n\n`;

      if (resource.response._failureText)
        md += `**Failure:** ${resource.response._failureText}\n\n`;

      if (resource.response.content?.text) {
        md += `<details><summary>Response</summary>\n\n`;
        md += '```\n';
        md += truncateString(resource.response.content.text, 1000);
        md += '\n```\n\n';
        md += `</details>\n\n`;
      }
    }
  }

  return md;
}

function generateFilmstripMarkdown(pages: TracePage[], startTime: number, assetMap: Map<string, string>): string {
  const allFrames: Array<{ timestamp: number; sha1: string; pageId: string }> = [];

  for (const page of pages) {
    for (const frame of page.screencastFrames) {
      allFrames.push({
        timestamp: frame.timestamp,
        sha1: frame.sha1,
        pageId: page.pageId,
      });
    }
  }

  if (allFrames.length === 0)
    return `# Filmstrip\n\nNo screenshots recorded.\n`;

  // Sort by timestamp
  allFrames.sort((a, b) => a.timestamp - b.timestamp);

  let md = `# Filmstrip\n\n`;
  md += `Total screenshots: ${allFrames.length}\n\n`;
  md += `| # | Time | Screenshot |\n`;
  md += `|---|------|------------|\n`;

  for (let i = 0; i < allFrames.length; i++) {
    const frame = allFrames[i];
    const relativeTime = Math.round(frame.timestamp - startTime);
    const resourcePath = assetMap.get(frame.sha1) || `./assets/resources/${frame.sha1}`;
    md += `| ${i + 1} | ${relativeTime}ms | [view](${resourcePath}) |\n`;
  }

  return md;
}

function generateAttachmentsMarkdown(actions: TraceAction[], assetMap: Map<string, string>): string {
  const allAttachments: Array<{ actionTitle: string; attachment: TraceAttachment }> = [];

  for (const action of actions) {
    if (!action.attachments?.length)
      continue;
    const actionTitle = action.title || `${action.class}.${action.method}`;
    for (const attachment of action.attachments) {
      allAttachments.push({
        actionTitle,
        attachment,
      });
    }
  }

  if (allAttachments.length === 0)
    return `# Attachments\n\nNo attachments recorded.\n`;

  let md = `# Attachments\n\n`;
  md += `Total attachments: ${allAttachments.length}\n\n`;
  md += `| # | Name | Type | Action | Link |\n`;
  md += `|---|------|------|--------|------|\n`;

  for (let i = 0; i < allAttachments.length; i++) {
    const { actionTitle, attachment } = allAttachments[i];
    const name = attachment.name.replace(/\|/g, '\\|');
    const contentType = attachment.contentType.replace(/\|/g, '\\|');
    const action = truncateString(actionTitle, 30).replace(/\|/g, '\\|');
    let link = '';
    if (attachment.sha1) {
      const resourcePath = assetMap.get(attachment.sha1) || `./assets/resources/${attachment.sha1}`;
      link = `[view](${resourcePath})`;
    }
    md += `| ${i + 1} | ${name} | ${contentType} | ${action} | ${link} |\n`;
  }

  return md;
}

// Snapshot rendering with proper subtree reference resolution and URL rewriting

const autoClosing = new Set(['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'MENUITEM', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);

// Playwright attributes that preserve element state and should be kept in exported snapshots.
// These are captured in snapshotterInjected.ts and restored in snapshotRenderer.ts.
// See tests/library/trace-exporter.spec.ts for a test that validates these stay in sync.
// Excluded attributes (trace viewer internals, not needed for exports):
//   - __playwright_bounding_rect__: canvas rendering calculations
//   - __playwright_current_src__: video/audio src tracking
export const kPreservedPlaywrightAttributes = new Set([
  '__playwright_src__',             // iframe src
  '__playwright_scroll_top_',       // scroll position
  '__playwright_scroll_left_',      // scroll position
  '__playwright_value_',            // input/textarea value
  '__playwright_checked_',          // checkbox/radio checked state
  '__playwright_selected_',         // option selected state
  '__playwright_popover_open_',     // popover open state
  '__playwright_dialog_open_',      // dialog open state
  '__playwright_shadow_root_',      // shadow DOM template marker
  '__playwright_custom_elements__', // custom element definitions (on body)
  '__playwright_style_sheet_',      // adopted stylesheets (on template)
  '__playwright_target__',          // click target highlighting
]);

function isNodeNameAttributesChildNodesSnapshot(n: NodeSnapshot): n is NodeNameAttributesChildNodesSnapshot {
  return Array.isArray(n) && typeof n[0] === 'string';
}

function isSubtreeReferenceSnapshot(n: NodeSnapshot): n is SubtreeReferenceSnapshot {
  return Array.isArray(n) && Array.isArray(n[0]);
}

// Build node index for subtree reference resolution (post-order traversal)
function buildNodeIndex(snapshot: TraceFrameSnapshot): NodeSnapshot[] {
  const nodes: NodeSnapshot[] = [];
  const visit = (n: NodeSnapshot) => {
    if (typeof n === 'string') {
      nodes.push(n);
    } else if (isNodeNameAttributesChildNodesSnapshot(n)) {
      const [, , ...children] = n;
      for (const child of children)
        visit(child);
      nodes.push(n);
    }
  };
  visit(snapshot.html);
  return nodes;
}

interface SnapshotHighlightInfo {
  callId: string;
  point?: { x: number; y: number };
}

class ExportSnapshotRenderer {
  private _snapshots: TraceFrameSnapshot[];
  private _index: number;
  private _snapshot: TraceFrameSnapshot;
  private _nodeIndexCache = new Map<number, NodeSnapshot[]>();
  private _baseUrl: string;
  private _overrideMap: Map<string, string>; // URL -> SHA1
  private _networkResourceMap: Map<string, string>; // URL -> SHA1 from network log
  private _usedSha1s = new Set<string>();
  private _highlightInfo?: SnapshotHighlightInfo;

  constructor(snapshots: TraceFrameSnapshot[], index: number, networkResourceMap: Map<string, string>, highlightInfo?: SnapshotHighlightInfo) {
    this._snapshots = snapshots;
    this._index = index;
    this._snapshot = snapshots[index];
    this._baseUrl = snapshots[index].frameUrl;
    this._networkResourceMap = networkResourceMap;
    this._highlightInfo = highlightInfo;

    // Build override map from current snapshot and all referenced snapshots
    this._overrideMap = this._buildOverrideMap();
  }

  // Build a map of URL -> SHA1 from all resourceOverrides, resolving refs
  private _buildOverrideMap(): Map<string, string> {
    const map = new Map<string, string>();

    // Process current snapshot's overrides
    for (const override of this._snapshot.resourceOverrides) {
      if (override.sha1) {
        map.set(override.url, override.sha1);
      } else if (override.ref !== undefined) {
        // Resolve ref chain
        const refIndex = this._index - override.ref;
        if (refIndex >= 0 && refIndex < this._snapshots.length) {
          const refSnapshot = this._snapshots[refIndex];
          const refOverride = refSnapshot.resourceOverrides.find(o => o.url === override.url);
          if (refOverride?.sha1)
            map.set(override.url, refOverride.sha1);
        }
      }
    }

    return map;
  }

  private _getNodeIndex(snapshotIndex: number): NodeSnapshot[] {
    let nodes = this._nodeIndexCache.get(snapshotIndex);
    if (!nodes) {
      nodes = buildNodeIndex(this._snapshots[snapshotIndex]);
      this._nodeIndexCache.set(snapshotIndex, nodes);
    }
    return nodes;
  }

  // Resolve a potentially relative URL to absolute using base URL
  private _resolveUrl(url: string): string {
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:'))
      return url;

    try {
      // Try to resolve against base URL
      return new URL(url, this._baseUrl).href;
    } catch {
      return url;
    }
  }

  // Rewrite URL to relative path for export
  private _rewriteUrl(url: string): string {
    // First try the URL as-is in override map
    let sha1 = this._overrideMap.get(url);

    // If not found, try resolving against base URL
    if (!sha1) {
      const resolvedUrl = this._resolveUrl(url);
      sha1 = this._overrideMap.get(resolvedUrl);

      // Still not found? Try the network resource map
      if (!sha1) {
        sha1 = this._networkResourceMap.get(url) || this._networkResourceMap.get(resolvedUrl);
      }
    }

    if (sha1) {
      this._usedSha1s.add(sha1);
      return `../resources/${sha1}`;
    }

    // Keep original URL for resources we don't have
    return url;
  }

  // Rewrite URLs in CSS text (url(...) references)
  private _rewriteCssUrls(cssText: string): string {
    return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, url) => {
      const rewritten = this._rewriteUrl(url.trim());
      return `url('${rewritten}')`;
    });
  }

  // Get all SHA1s that were actually used during rendering
  getUsedSha1s(): Set<string> {
    return this._usedSha1s;
  }

  render(): string {
    const result: string[] = [];

    const visit = (n: NodeSnapshot, snapshotIndex: number, parentTag: string | undefined) => {
      // Text node
      if (typeof n === 'string') {
        // Rewrite URLs in inline stylesheets
        if (parentTag === 'STYLE' || parentTag === 'style')
          result.push(this._rewriteCssUrls(escapeHTML(n)));
        else
          result.push(escapeHTML(n));
        return;
      }

      // Subtree reference - resolve from previous snapshot
      if (isSubtreeReferenceSnapshot(n)) {
        const [snapshotsAgo, nodeIndex] = n[0];
        const referenceIndex = snapshotIndex - snapshotsAgo;
        if (referenceIndex >= 0 && referenceIndex <= snapshotIndex) {
          const nodes = this._getNodeIndex(referenceIndex);
          if (nodeIndex >= 0 && nodeIndex < nodes.length)
            return visit(nodes[nodeIndex], referenceIndex, parentTag);
        }
        return;
      }

      // Element node
      if (isNodeNameAttributesChildNodesSnapshot(n)) {
        const [name, nodeAttrs, ...children] = n;
        const nodeName = name === 'NOSCRIPT' ? 'X-NOSCRIPT' : name;
        const attrs = Object.entries(nodeAttrs || {});

        // Skip <base> tag - it would cause relative URLs to resolve against the original server
        if (nodeName === 'BASE')
          return;

        result.push('<', nodeName.toLowerCase());

        const isFrame = nodeName === 'IFRAME' || nodeName === 'FRAME';
        const isAnchor = nodeName === 'A';
        const isLink = nodeName === 'LINK';
        const isScript = nodeName === 'SCRIPT';
        const isImg = nodeName === 'IMG';

        for (const [attr, value] of attrs) {
          // Skip internal playwright attributes, but keep state-preserving ones
          if (attr.startsWith('__playwright') && !kPreservedPlaywrightAttributes.has(attr))
            continue;

          let attrName = attr;
          let attrValue = value;
          const attrLower = attr.toLowerCase();

          // Handle iframe src
          if (isFrame && attr === '__playwright_src__') {
            attrName = 'src';
            attrValue = this._rewriteUrl(value);
          } else if (isLink && attrLower === 'href') {
            // Stylesheet links
            attrValue = this._rewriteUrl(value);
          } else if ((isScript || isImg) && attrLower === 'src') {
            // Script and image sources
            attrValue = this._rewriteUrl(value);
          } else if (!isAnchor && !isLink && attrLower === 'src') {
            // Other src attributes (video, audio, etc.)
            attrValue = this._rewriteUrl(value);
          } else if (attrLower === 'srcset') {
            // Handle srcset (contains multiple URLs)
            attrValue = this._rewriteSrcset(value);
          } else if (attrLower === 'style') {
            // Rewrite URLs in inline styles
            attrValue = this._rewriteCssUrls(value);
          }

          result.push(' ', attrName, '="', escapeHTMLAttribute(attrValue), '"');
        }

        result.push('>');

        for (const child of children)
          visit(child, snapshotIndex, nodeName);

        if (!autoClosing.has(nodeName))
          result.push('</', nodeName.toLowerCase(), '>');
      }
    };

    const snapshot = this._snapshot;
    visit(snapshot.html, this._index, undefined);

    const doctype = snapshot.doctype ? `<!DOCTYPE ${snapshot.doctype}>` : '<!DOCTYPE html>';
    const viewportInfo = snapshot.viewport ? ` | Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}` : '';
    const comment = `<!-- Playwright Snapshot: ${snapshot.snapshotName} | URL: ${snapshot.frameUrl} | Timestamp: ${snapshot.timestamp}${viewportInfo} -->`;

    // Inject state restoration script at the end of the document
    const restorationScript = generateRestorationScript(this._highlightInfo);

    return doctype + '\n' + comment + '\n' + result.join('') + restorationScript;
  }

  // Rewrite srcset attribute (format: "url1 1x, url2 2x, ...")
  private _rewriteSrcset(srcset: string): string {
    return srcset.split(',').map(entry => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length >= 1) {
        parts[0] = this._rewriteUrl(parts[0]);
      }
      return parts.join(' ');
    }).join(', ');
  }
}

// State restoration script for exported snapshots
// This mirrors the behavior of the trace viewer's snapshotRenderer.ts
function generateRestorationScript(highlightInfo?: SnapshotHighlightInfo): string {
  // Generate highlight config as JSON if present
  const highlightConfig = highlightInfo ? JSON.stringify({
    callId: highlightInfo.callId,
    pointX: highlightInfo.point?.x,
    pointY: highlightInfo.point?.y,
  }) : 'null';

  return `
<script>
(function() {
  const highlightConfig = ${highlightConfig};
  const targetElements = [];

  const visit = (root) => {
    // Restore input values
    for (const element of root.querySelectorAll('[__playwright_value_]')) {
      if (element.type !== 'file')
        element.value = element.getAttribute('__playwright_value_');
      element.removeAttribute('__playwright_value_');
    }
    // Restore checkbox/radio checked state
    for (const element of root.querySelectorAll('[__playwright_checked_]')) {
      element.checked = element.getAttribute('__playwright_checked_') === 'true';
      element.removeAttribute('__playwright_checked_');
    }
    // Restore option selected state
    for (const element of root.querySelectorAll('[__playwright_selected_]')) {
      element.selected = element.getAttribute('__playwright_selected_') === 'true';
      element.removeAttribute('__playwright_selected_');
    }
    // Restore popover open state
    for (const element of root.querySelectorAll('[__playwright_popover_open_]')) {
      try { element.showPopover(); } catch {}
      element.removeAttribute('__playwright_popover_open_');
    }
    // Restore dialog open state
    for (const element of root.querySelectorAll('[__playwright_dialog_open_]')) {
      try {
        if (element.getAttribute('__playwright_dialog_open_') === 'modal')
          element.showModal();
        else
          element.show();
      } catch {}
      element.removeAttribute('__playwright_dialog_open_');
    }
    // Apply click target highlighting (blue outline)
    if (highlightConfig) {
      for (const target of root.querySelectorAll('[__playwright_target__="' + highlightConfig.callId + '"]')) {
        target.style.outline = '2px solid #006ab1';
        target.style.backgroundColor = '#6fa8dc7f';
        targetElements.push(target);
      }
    }
    // Handle shadow roots
    for (const element of root.querySelectorAll('template[__playwright_shadow_root_]')) {
      const shadowRoot = element.parentElement.attachShadow({ mode: 'open' });
      shadowRoot.appendChild(element.content);
      element.remove();
      visit(shadowRoot);
    }
    // Register custom elements
    const body = root.querySelector('body[__playwright_custom_elements__]');
    if (body && window.customElements) {
      const customElements = (body.getAttribute('__playwright_custom_elements__') || '').split(',');
      for (const elementName of customElements) {
        if (elementName && !window.customElements.get(elementName))
          window.customElements.define(elementName, class extends HTMLElement {});
      }
      body.removeAttribute('__playwright_custom_elements__');
    }
    // Restore adopted stylesheets
    if ('adoptedStyleSheets' in root) {
      const adoptedSheets = [...root.adoptedStyleSheets];
      for (const element of root.querySelectorAll('template[__playwright_style_sheet_]')) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(element.getAttribute('__playwright_style_sheet_'));
        adoptedSheets.push(sheet);
        element.remove();
      }
      root.adoptedStyleSheets = adoptedSheets;
    }
  };

  const onLoad = () => {
    window.removeEventListener('load', onLoad);
    // Restore scroll positions after layout
    for (const element of document.querySelectorAll('[__playwright_scroll_top_]')) {
      element.scrollTop = +element.getAttribute('__playwright_scroll_top_');
      element.removeAttribute('__playwright_scroll_top_');
    }
    for (const element of document.querySelectorAll('[__playwright_scroll_left_]')) {
      element.scrollLeft = +element.getAttribute('__playwright_scroll_left_');
      element.removeAttribute('__playwright_scroll_left_');
    }

    // Add click pointer (red circle) for input snapshots
    if (highlightConfig && highlightConfig.pointX !== undefined && highlightConfig.pointY !== undefined) {
      const hasTargetElements = targetElements.length > 0;
      const roots = document.documentElement ? [document.documentElement] : [];
      for (const target of (hasTargetElements ? targetElements : roots)) {
        const pointElement = document.createElement('x-pw-pointer');
        pointElement.style.position = 'fixed';
        pointElement.style.backgroundColor = '#f44336';
        pointElement.style.width = '20px';
        pointElement.style.height = '20px';
        pointElement.style.borderRadius = '10px';
        pointElement.style.margin = '-10px 0 0 -10px';
        pointElement.style.zIndex = '2147483646';
        pointElement.style.display = 'flex';
        pointElement.style.alignItems = 'center';
        pointElement.style.justifyContent = 'center';
        if (hasTargetElements) {
          // Show circle at center of target element
          const box = target.getBoundingClientRect();
          const centerX = (box.left + box.width / 2);
          const centerY = (box.top + box.height / 2);
          pointElement.style.left = centerX + 'px';
          pointElement.style.top = centerY + 'px';
          // Add warning if point differs significantly from recorded location
          if (Math.abs(centerX - highlightConfig.pointX) >= 10 || Math.abs(centerY - highlightConfig.pointY) >= 10) {
            const warningElement = document.createElement('x-pw-pointer-warning');
            warningElement.textContent = '⚠';
            warningElement.style.fontSize = '19px';
            warningElement.style.color = 'white';
            warningElement.style.marginTop = '-3.5px';
            warningElement.style.userSelect = 'none';
            pointElement.appendChild(warningElement);
            pointElement.setAttribute('title', 'Recorded click position in absolute coordinates did not match the center of the clicked element. This is likely due to a difference between the test runner and the trace viewer operating systems.');
          }
          document.documentElement.appendChild(pointElement);
        } else {
          // For actions without a target element, show at recorded location
          pointElement.style.left = highlightConfig.pointX + 'px';
          pointElement.style.top = highlightConfig.pointY + 'px';
          document.documentElement.appendChild(pointElement);
        }
      }
    }
  };

  visit(document);
  window.addEventListener('load', onLoad);
})();
</script>`;
}

// Helper functions

function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength)
    return str;
  return str.substring(0, maxLength - 3) + '...';
}

function formatParams(params: Record<string, any>): string {
  const str = JSON.stringify(params);
  return truncateString(str, 200);
}

function formatResult(result: any): string {
  if (result === null || result === undefined)
    return 'null';
  if (typeof result === 'string')
    return truncateString(result, 100);
  const str = JSON.stringify(result);
  return truncateString(str, 100);
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes < 0)
    return '-';
  if (bytes < 1024)
    return `${bytes}B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
