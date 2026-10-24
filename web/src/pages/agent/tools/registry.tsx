import { AuiConfig, Tools } from '@assistant-ui/react';
import type { ToolCallMessagePartProps, Toolkit } from '@assistant-ui/react';
import type { Trace } from '../../../agent/types';
import { ApprovalCard } from '../interrupts/ApprovalCard';
import type { CapabilityReceipt } from '../state';
import { useAgentView } from './AgentViewContext';
import { CapabilityCall } from './CapabilityCall';
import { OPENUI_TOOLKIT } from './openui';

/**
 * The Agent's tool views, registered with assistant-ui as one toolkit keyed by tool name.
 *
 * Each view is an ordinary component that takes the framework's part props and reads the rest -
 * the call's trace, the registry entry, the operation it waits on - from the Agent view context.
 * Adding a view for a capability is one entry here; a capability without one is drawn by
 * `ToolFallback`, the generic call row, so a server-side addition is never invisible.
 *
 * The server owns the catalogue and executes every call (ADR 0041), so the toolkit contributes
 * views, never declarations the model would act on. The OpenUI tools are the official integration's
 * own renderers (ADR 0088); the ExternalStore runtime never executes them in the browser, so the
 * only thing they send back is a submitted `prompt_openui` form, through `onAddToolResult`.
 */

/** The call's trace, from the page's state when it has one, otherwise read off the part. */
function useTrace(part: ToolCallMessagePartProps): Trace {
  const { traces } = useAgentView();
  return traces.get(part.toolCallId) ?? {
    id: part.toolCallId,
    name: part.toolName,
    arguments: part.argsText,
    result: (part.result as CapabilityReceipt | undefined) ?? { status: 'running' },
  };
}

/** The generic call row, with the approval card under it while the call waits on the operator. */
export function ToolFallback(part: ToolCallMessagePartProps) {
  const { capabilities, pendingOperation } = useAgentView();
  const trace = useTrace(part);
  const approval = part.approval;
  const isOpen = !!approval && approval.approved === undefined;
  return (
    <CapabilityCall trace={trace}>
      {isOpen && (
        <ApprovalCard
          operation={pendingOperation?.id === approval.id ? pendingOperation : undefined}
          capability={capabilities.find(item => item.name === trace.name)}
          respond={part.respondToApproval}
        />
      )}
    </CapabilityCall>
  );
}

const AGENT_TOOLKIT: Toolkit = OPENUI_TOOLKIT;

/** Passed to the runtime provider, which installs the toolkit's views for the thread below it. */
export const AGENT_AUI_CONFIG = AuiConfig({ tools: Tools({ toolkit: AGENT_TOOLKIT }) });
