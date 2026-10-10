import type { UsageEventResponseHeader } from './usageEvents';

/** What a diagnosis reads a response header for, in the order the drawer prints them. */
export type ResponseHeaderGroupId = 'identifiers' | 'limits' | 'routing' | 'other';

export interface ResponseHeaderGroup {
  id: ResponseHeaderGroupId;
  headers: UsageEventResponseHeader[];
}

/* The first matching rule wins, so `x-ratelimit-reset-requests` is a limit and not
   an identifier for containing "request". Providers spell these headers their own
   way; a rule is a name fragment rather than a list of every vendor's header. */
const GROUP_RULES: Array<[ResponseHeaderGroupId, RegExp]> = [
  ['limits', /ratelimit|rate-limit|retry-after|quota|x-codex-|-usage|-limit|-reset|-remaining|-plan|overage|credits/],
  ['identifiers', /request-?id|trace|cf-ray|correlation|x-amz-id|-id$/],
  ['routing', /^server$|^via$|^cf-|x-cache|served-by|region|upstream|processing-ms|envoy|x-powered-by|organization|-version$|-model$/],
];

export const RESPONSE_HEADER_GROUP_ORDER: ResponseHeaderGroupId[] = ['identifiers', 'limits', 'routing', 'other'];

export function responseHeaderGroupOf(name: string): ResponseHeaderGroupId {
  const lowered = name.toLowerCase();
  return GROUP_RULES.find(([, pattern]) => pattern.test(lowered))?.[0] ?? 'other';
}

/** Groups in display order; a group with nothing in it is left out. */
export function groupResponseHeaders(headers: UsageEventResponseHeader[] | undefined): ResponseHeaderGroup[] {
  const byGroup = new Map<ResponseHeaderGroupId, UsageEventResponseHeader[]>();
  for (const header of headers ?? []) {
    const id = responseHeaderGroupOf(header.name);
    byGroup.set(id, [...(byGroup.get(id) ?? []), header]);
  }
  return RESPONSE_HEADER_GROUP_ORDER.flatMap((id) => {
    const grouped = byGroup.get(id);
    return grouped ? [{ id, headers: grouped }] : [];
  });
}

/** The snapshot as `name: value` lines, for the clipboard. */
export function responseHeadersText(headers: UsageEventResponseHeader[]): string {
  return headers.map((header) => `${header.name}: ${header.value}`).join('\n');
}
