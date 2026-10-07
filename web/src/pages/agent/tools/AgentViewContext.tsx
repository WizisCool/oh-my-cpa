import React from 'react';
import type { Trace } from '../../../agent/types';
import type { Capability, Operation } from '../state';

/** What the run in flight is doing, for the activity strip under the live answer. */
export interface AgentActivity {
  round: number;
  startedAtMS: number;
  isThinking: boolean;
  /** The capability executing right now, if one is. */
  runningCall?: string;
}

/**
 * What the Agent's message views read beside the message itself.
 *
 * A tool view is handed the framework's part - arguments, result, approval - and looks up the rest
 * here: the call's full trace (status, timing, frozen view), the registry entry that names it, the
 * operation it waits on, and the side panel's selection. Kept as one context so a view registered
 * for a new capability needs no new wiring in the page.
 */
export interface AgentViewState {
  traces: Map<string, Trace>;
  capabilities: Capability[];
  /** The operation the conversation waits on, once read. */
  pendingOperation?: Operation;
  selectedCallID: string;
  selectCall: (id: string) => void;
  /** Present while a run is in flight. */
  activity?: AgentActivity;
  /** The newest turn's id when it may be retried or edited; empty otherwise. */
  replaceableTurnID?: string;
  /** Asks the newest turn's question again in its place. */
  retryTurn?: () => void;
  /** Puts the newest turn's message back in the composer; sending it replaces the turn. */
  editTurn?: () => void;
}

const EMPTY: AgentViewState = {
  traces: new Map(),
  capabilities: [],
  selectedCallID: '',
  selectCall: () => undefined,
};

export const AgentViewContext = React.createContext<AgentViewState>(EMPTY);

export function useAgentView(): AgentViewState {
  return React.useContext(AgentViewContext);
}
