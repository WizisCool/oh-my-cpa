import React from 'react';
import { Modal } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { ToolApprovalResponse } from '@assistant-ui/react';
import { useI18n } from '../../i18n';
import type { CapabilityReceipt } from '../../agent/types';
import { setOpenUIToolHost } from '../../agent/openui/toolProvider';
import { failureKey } from '../../components/workspace/conversationLabels';
import { ApprovalCard } from './interrupts/ApprovalCard';
import { decideOperation, failureCode, getCapabilities, getOperation, invokeCapability, readDataRows } from './api';
import type { Capability, Operation } from './state';

interface OpenApproval {
  operation: Operation | undefined;
  operationID: string;
  settle: (receipt: CapabilityReceipt) => void;
}

/** A failed request as the receipt a call would have returned, so the interface shows it in place. */
async function receiptOf(request: () => Promise<CapabilityReceipt>): Promise<CapabilityReceipt> {
  try {
    return await request();
  } catch (cause) {
    return { status: 'error', code: failureCode(cause) };
  }
}

/**
 * Connects the interfaces OpenUI renders on this page to the console.
 *
 * A Query or Mutation in a program reaches capabilities through the same executor endpoint, and the
 * same session, as any other console request: permissions, approval and audit are the server's, so a
 * generated interface cannot do anything its operator could not. A change the executor holds for
 * approval is decided here, on the conversation's own approval card, and the Mutation resolves with
 * the outcome. The returned element is that card's dialog.
 */
export function useOpenUIToolHost(): React.ReactNode {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [approval, setApproval] = React.useState<OpenApproval>();

  React.useEffect(() => {
    setOpenUIToolHost({
      capability: async name => {
        const capabilities = await queryClient.fetchQuery({ queryKey: ['capabilities'], queryFn: ({ signal }) => getCapabilities(signal), staleTime: Infinity });
        return capabilities.find((item: Capability) => item.name === name);
      },
      invoke: (name, args) => receiptOf(() => invokeCapability(name, args)),
      readRows: dataRef => receiptOf(() => readDataRows(dataRef)),
      approve: operationID => new Promise<CapabilityReceipt>(settle => {
        setApproval({ operation: undefined, operationID, settle });
        void getOperation(operationID).then(
          operation => setApproval(current => (current?.operationID === operationID ? { ...current, operation } : current)),
          (cause: unknown) => {
            setApproval(undefined);
            settle({ status: 'error', code: failureCode(cause) });
          },
        );
      }),
      isUserAction: () => navigator.userActivation?.isActive ?? true,
      invalidate: keys => {
        for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
      },
      describe: (code, detail) => (detail ? `${t(failureKey(code))} ${detail}` : t(failureKey(code))),
    });
    return () => setOpenUIToolHost(undefined);
  }, [queryClient, t]);

  const respond = async (response: ToolApprovalResponse) => {
    if (!approval) return;
    const isApproved = 'approved' in response && response.approved;
    const secret = isApproved && 'text' in response ? response.text : undefined;
    const decided = await decideOperation(approval.operationID, isApproved, secret ? { secret } : {});
    setApproval(undefined);
    approval.settle(decided.status === 'pending' ? { status: 'error', code: 'confirmation_pending' } : decided.result);
  };

  // Closing the dialog is a decision too: a change left prepared would wait on nobody.
  const dismiss = () => {
    if (!approval) return;
    void respond({ approved: false }).catch(() => {
      setApproval(undefined);
      approval.settle({ status: 'rejected' });
    });
  };

  return (
    <Modal open={!!approval} title={t('agent.openui.approval')} footer={null} onCancel={dismiss} destroyOnHidden>
      {approval && <div data-testid="agent-openui-approval"><ApprovalCard operation={approval.operation} respond={respond} /></div>}
    </Modal>
  );
}
