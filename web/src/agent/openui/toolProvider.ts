import type { McpClientLike } from '@openuidev/react-lang';
import type { CapabilityReceipt } from '../types';
import { DATA_ROWS_TOOL } from './prompt';

/** What a rendered interface's Query and Mutation calls need from the page that shows it. */
export interface OpenUIToolHost {
  /** The registry entry a call names, or undefined when there is none. */
  capability: (name: string) => Promise<{ permission: string; human_input?: string } | undefined>;
  /** Runs a capability through the console's executor endpoint. */
  invoke: (name: string, args: Record<string, unknown>) => Promise<CapabilityReceipt>;
  /** Reads the rows a data reference of the conversation names. */
  readRows: (dataRef: string) => Promise<CapabilityReceipt>;
  /** Asks the operator to decide a prepared change and resolves with its outcome. */
  approve: (operationID: string) => Promise<CapabilityReceipt>;
  /** Whether the call follows a click or key press, as a Mutation run by a button does. */
  isUserAction: () => boolean;
  /** The console data a change made stale. */
  invalidate: (keys: readonly string[]) => void;
  /** A refusal or failure in the operator's words. */
  describe: (code: string, detail?: string) => string;
}

let host: OpenUIToolHost | undefined;

/** The page that renders OpenUI installs its host; interfaces drawn before it calls nothing. */
export function setOpenUIToolHost(next: OpenUIToolHost | undefined): void {
  host = next;
}

type ToolEnvelope = Awaited<ReturnType<McpClientLike['callTool']>>;

function failure(message: string): ToolEnvelope {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function success(data: unknown): ToolEnvelope {
  return { content: [{ type: 'text', text: JSON.stringify(data ?? null) }], structuredContent: data ?? null };
}

/**
 * The capabilities an interface may not call: a capability that waits on private operator input
 * (a secret, an OAuth flow, an answer) needs the conversation's own cards, and database_query's
 * rows reach an interface only projected, through data_rows. The server's catalogue for the prompt
 * leaves out the same set (`agent.OpenUITools`).
 */
function isWithheld(name: string, entry: { human_input?: string }): boolean {
  return !!entry.human_input || name === 'database_query';
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolEnvelope> {
  const current = host;
  if (!current) return failure('unavailable');
  if (name === DATA_ROWS_TOOL) {
    const receipt = await current.readRows(typeof args.data_ref === 'string' ? args.data_ref : '');
    return receipt.status === 'success' ? success(receipt.data) : failure(current.describe(receipt.code ?? 'invalid_tool_arguments', receipt.detail));
  }
  const entry = await current.capability(name);
  if (!entry || isWithheld(name, entry)) return failure(current.describe('capability_forbidden'));
  // A Query runs as soon as the interface renders; a change belongs to a Mutation that a button
  // runs. The executor still asks for approval where it always would - this keeps a program from
  // preparing a change nobody clicked for.
  if (entry.permission !== 'read' && !current.isUserAction()) return failure(current.describe('openui_change_needs_action'));
  let receipt = await current.invoke(name, args);
  if (receipt.status === 'pending' && receipt.operation_id) receipt = await current.approve(receipt.operation_id);
  if (receipt.invalidates?.length) current.invalidate(receipt.invalidates);
  return receipt.status === 'success' ? success(receipt.data) : failure(current.describe(receipt.code ?? receipt.status, receipt.detail));
}

/**
 * The tool provider every rendered OpenUI program shares, in the MCP client shape the official
 * renderer accepts: one entry point for any tool name, so the registry can grow without the
 * provider changing.
 */
export const OPENUI_TOOL_PROVIDER: McpClientLike = {
  async callTool({ name, arguments: args }) {
    try {
      return await call(name, args ?? {});
    } catch (cause) {
      return failure(host?.describe(cause instanceof Error ? cause.message : 'gateway_unavailable') ?? 'unavailable');
    }
  },
};
