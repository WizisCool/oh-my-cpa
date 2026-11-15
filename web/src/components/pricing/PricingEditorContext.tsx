import React from 'react';
import type { PricingMode, UpstreamModel } from '../../types/pricing';

/**
 * The console-wide price editor. Any surface that shows a cost - a request row, the request
 * drawer, the dashboard's model ranking, the price book - opens the same editor in place, so
 * pricing a model never means leaving the thing that showed it had no price.
 *
 * The drawer itself is loaded on first use: most sessions never open it, and the pages that can
 * open it are the ones whose first paint the bundle budget guards most closely.
 */
export interface OpenPriceEditorOptions {
  /** The provider label recorded on requests: the editor opens on that channel's scope. */
  channel?: string;
  /** Start in this mode instead of the model's current one. */
  mode?: PricingMode;
  /** Preselect this OpenRouter model for a link, e.g. a suggestion the operator clicked. */
  upstream?: UpstreamModel;
}

type OpenPriceEditor = (model: string, options?: OpenPriceEditorOptions) => void;

const PricingEditorContext = React.createContext<OpenPriceEditor | null>(null);
const OpenModelContext = React.createContext<string | null>(null);

const LazyPriceEditorDrawer = React.lazy(() =>
  import('./PriceEditorDrawer').then((module) => ({ default: module.PriceEditorDrawer })));

interface EditorTarget {
  model: string;
  options: OpenPriceEditorOptions;
  /** Bumped per open, so reopening the same model starts from the server's state again. */
  session: number;
}

export const PricingEditorProvider: React.FC<{ routeKey?: string; children: React.ReactNode }> = ({ routeKey, children }) => {
  const [target, setTarget] = React.useState<EditorTarget | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);
  const sessionRef = React.useRef(0);
  const lastRouteKeyRef = React.useRef(routeKey);
  React.useEffect(() => {
    if (lastRouteKeyRef.current !== routeKey) {
      lastRouteKeyRef.current = routeKey;
      setIsOpen(false);
    }
  }, [routeKey]);
  const open = React.useCallback<OpenPriceEditor>((model, options = {}) => {
    sessionRef.current += 1;
    setTarget({ model, options, session: sessionRef.current });
    setIsOpen(true);
  }, []);
  const targetSession = target?.session ?? 0;
  const closeCurrentSession = React.useCallback(() => {
    if (sessionRef.current === targetSession) {
      setIsOpen(false);
    }
  }, [targetSession]);
  return (
    <PricingEditorContext.Provider value={open}>
      <OpenModelContext.Provider value={isOpen && target ? target.model : null}>
        {children}
      </OpenModelContext.Provider>
      {target && (
        <React.Suspense fallback={null}>
          <LazyPriceEditorDrawer
            key={target.session}
            model={target.model}
            channel={target.options.channel}
            initialMode={target.options.mode}
            initialUpstream={target.options.upstream}
            isOpen={isOpen}
            onClose={closeCurrentSession}
          />
        </React.Suspense>
      )}
    </PricingEditorContext.Provider>
  );
};

/**
 * Opens the price editor, or null outside the console shell - a caller then renders no pricing
 * action rather than one that does nothing.
 */
export function useOpenPriceEditor(): OpenPriceEditor | null {
  return React.useContext(PricingEditorContext);
}

/** The model the editor is open on, so a list can keep that row marked while it is edited. */
export function useOpenPriceModel(): string | null {
  return React.useContext(OpenModelContext);
}
