import { displayCallStage } from '../../../agent/types';
import type { DisplayView, Trace } from '../../../agent/types';
import { CanvasView } from './CanvasView';
import { CapabilityCall } from './CapabilityCall';
import { FigureDraft } from './FigureDraft';
import { PanelView } from './PanelView';

/** A display call's frozen view, drawn inside the answer by the component for its kind. */
export function DisplayFigure({ view, callID }: { view: DisplayView; callID?: string }) {
  return view.kind === 'panel' ? <PanelView view={view} /> : <CanvasView view={view} callID={callID} />;
}

export interface DisplayCallProps {
  trace: Trace;
}

/**
 * A display call, drawn at the point of the answer where the model made it (ADR 0082): a draft
 * that fills in as it is written (ADR 0085), then the figure in the same place. A call that failed stays a call
 * row, which is where its code and detail are read.
 */
export function DisplayCall({ trace }: DisplayCallProps) {
  const stage = displayCallStage(trace);
  if (stage === 'row') return <CapabilityCall trace={trace} />;
  return (
    <div data-aui-quote-selectable="false" data-testid="agent-results">
      {stage === 'figure' ? <DisplayFigure view={trace.view!} callID={trace.id} /> : <FigureDraft trace={trace} />}
    </div>
  );
}
