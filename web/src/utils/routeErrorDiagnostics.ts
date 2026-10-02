import { isRouteErrorResponse } from 'react-router-dom';

const MAX_DIAGNOSTIC_TEXT = 12_000;
const MAX_INPUT_TEXT = 64_000;
const REDACTED_VALUE = '[REDACTED]';

export interface RouteErrorDiagnostics {
  errorType: string;
  message: string;
  stack: string;
  routePath: string;
  version: string;
  occurredAt: string;
  status?: number;
}

/** Keep code locations useful while removing URL credentials and arbitrary query/hash values. */
export function redactDiagnosticText(text: string): string {
  // Drop a cut-off token before matching so an oversized payload cannot leak a partial secret.
  let endOffset = Math.min(text.length, MAX_INPUT_TEXT);
  if (text.length > MAX_INPUT_TEXT) {
    while (endOffset > 0 && !/\s/.test(text[endOffset - 1])) endOffset -= 1;
  }
  const boundedText = text.slice(0, endOffset);
  return boundedText
    .replace(/https?:\/\/[^\s"'<>]+/gi, (address) => {
      try {
        const locationSuffix = address.match(/(:\d+:\d+\)?)[,;]?$/)?.[1] ?? '';
        const url = new URL(address);
        const path = `${url.origin}${url.pathname}`;
        return locationSuffix && !path.endsWith(locationSuffix) ? `${path}${locationSuffix}` : path;
      } catch {
        return REDACTED_VALUE;
      }
    })
    .replace(/(^|[\s(])((?:\.?\.?\/)[^\s?#[\]"'<>]*)(?:[?#][^\s)"'<>]*)/gm, '$1$2')
    .replace(/(^[ \t]*(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*:[ \t]*)[^\r\n]*/gim, `$1${REDACTED_VALUE}`)
    .replace(/\bBearer\s+[^\s,;"'<>]+/gi, `Bearer ${REDACTED_VALUE}`)
    .replace(/(["']?\b[\w-]*(?:key|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, `$1${REDACTED_VALUE}`)
    .replace(/\b(?:sk|pk|pat|glpat)-[A-Za-z0-9_-]{8,}\b|\bgh[pousr]_[A-Za-z0-9]{8,}\b|\bgithub_pat_[A-Za-z0-9_]{8,}\b|\bxox[baprs]-[A-Za-z0-9-]{8,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|\bya29\.[A-Za-z0-9_.-]{10,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED_VALUE)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, MAX_DIAGNOSTIC_TEXT);
}

function readText(value: unknown, field: 'name' | 'message' | 'stack'): string {
  if (typeof value !== 'object' || value === null) return '';
  // A thrown value need not be an Error; even reading a hostile getter must not break recovery.
  try {
    const text = (value as Record<string, unknown>)[field];
    return typeof text === 'string' ? redactDiagnosticText(text) : '';
  } catch {
    return '';
  }
}

export function createRouteErrorDiagnostics(
  error: unknown,
  context: Pick<RouteErrorDiagnostics, 'routePath' | 'version' | 'occurredAt'>,
): RouteErrorDiagnostics {
  let status: number | undefined;
  let errorType = readText(error, 'name');
  let message = typeof error === 'string' ? redactDiagnosticText(error) : readText(error, 'message');
  try {
    if (isRouteErrorResponse(error)) {
      status = error.status;
      errorType = redactDiagnosticText(`HTTP ${error.status} ${error.statusText}`.trim());
      message = typeof error.data === 'string' ? redactDiagnosticText(error.data) : readText(error.data, 'message');
    }
  } catch {
    // Structural route-response detection also reads properties of an arbitrary thrown value.
  }
  return {
    errorType,
    message,
    stack: readText(error, 'stack'),
    routePath: redactDiagnosticText(context.routePath.split(/[?#]/, 1)[0]),
    version: redactDiagnosticText(context.version),
    occurredAt: context.occurredAt,
    ...(status !== undefined ? { status } : {}),
  };
}

/** Copy only the same bounded, redacted projection shown on screen, never the thrown object. */
export function formatRouteErrorReport(diagnostics: RouteErrorDiagnostics): string {
  return [
    'Oh My CPA',
    `Error: ${diagnostics.errorType}`,
    `Message: ${diagnostics.message}`,
    ...(diagnostics.status !== undefined ? [`HTTP: ${diagnostics.status}`] : []),
    `Route: ${diagnostics.routePath}`,
    `Build: ${diagnostics.version}`,
    `Time: ${diagnostics.occurredAt}`,
    ...(diagnostics.stack ? ['', diagnostics.stack] : []),
  ].join('\n');
}
