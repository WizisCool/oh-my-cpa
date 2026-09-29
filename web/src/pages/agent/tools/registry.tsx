import React from 'react';
import { Button } from 'antd';
import { makeAssistantToolUI } from '@assistant-ui/react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { queryResultTable } from '../../../agent/export';
import type { Trace } from '../../../agent/types';
import { useI18n } from '../../../i18n';
import { ApprovalCard } from '../interrupts/ApprovalCard';
import type { CapabilityReceipt } from '../state';
import { useAgentView } from './AgentViewContext';
import { CapabilityCall } from './CapabilityCall';
import { DisplayCall } from './DisplayCall';
import { TableView } from './TableView';
import styles from '../AgentPage.module.css';

/**
 * The Agent's tool views, registered with assistant-ui by tool name.
 *
 * Each view is an ordinary component that takes the framework's part props and reads the rest -
 * the call's trace, the registry entry, the operation it waits on - from the Agent view context.
 * Adding a view for a capability is one entry here; a capability without one is drawn by
 * `ToolFallback`, the generic call row, so a server-side addition is never invisible.
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
  const { capabilities, pendingOperation, selectedCallID, selectCall } = useAgentView();
  const trace = useTrace(part);
  const approval = part.approval;
  const isOpen = !!approval && approval.approved === undefined;
  return (
    <CapabilityCall trace={trace} isSelected={selectedCallID === trace.id} onSelect={selectCall}>
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

function DisplayToolView(part: ToolCallMessagePartProps) {
  const { selectedCallID, selectCall } = useAgentView();
  const trace = useTrace(part);
  return <DisplayCall trace={trace} isSelected={selectedCallID === trace.id} onSelect={selectCall} />;
}

/** `database_query`: the call row, and its rows one click away as a table. */
function QueryToolView(part: ToolCallMessagePartProps) {
  const { t } = useI18n();
  const { selectedCallID, selectCall } = useAgentView();
  const trace = useTrace(part);
  const [isOpen, setIsOpen] = React.useState(false);
  const table = trace.result.status === 'success' ? queryResultTable(trace.result.data) : undefined;
  return (
    <CapabilityCall trace={trace} isSelected={selectedCallID === trace.id} onSelect={selectCall}>
      {table && (
        <div className={styles['call-extra']}>
          <Button type="link" size="small" aria-expanded={isOpen} onClick={() => setIsOpen(value => !value)}>
            {t(isOpen ? 'agent.view.hide_rows' : 'agent.view.show_rows', { count: String(table.rows.length) })}
          </Button>
          {isOpen && <TableView table={table} title={trace.name} />}
        </div>
      )}
    </CapabilityCall>
  );
}

const RenderChartToolUI = makeAssistantToolUI({ toolName: 'render_chart', display: 'standalone', render: DisplayToolView });
const RenderTableToolUI = makeAssistantToolUI({ toolName: 'render_table', display: 'standalone', render: DisplayToolView });
const DatabaseQueryToolUI = makeAssistantToolUI({ toolName: 'database_query', render: QueryToolView });

/** Mounted once inside the runtime provider; each entry registers one tool's view. */
export function AgentToolUIs() {
  return (
    <>
      <RenderChartToolUI />
      <RenderTableToolUI />
      <DatabaseQueryToolUI />
    </>
  );
}
