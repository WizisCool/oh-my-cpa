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
  /** Start in this mode instead of the model's current one. */
  mode?: PricingMode;
  /** Preselect this OpenRouter model for a link, e.g. a suggestion the operator clicked. */
  upstream?: UpstreamModel;
}

type OpenPriceEditor = (model: string, options?: OpenPriceEditorOptions) => void;

const PricingEditorContext = React.createContext<OpenPriceEditor | null>(null);

const LazyPriceEditorDrawer = React.lazy(() =>
  import('./PriceEditorDrawer').then((module) => ({ default: module.PriceEditorDrawer })));

interface EditorTarget {
  model: string;
  options: OpenPriceEditorOptions;
  /** Bumped per open, so reopening the same model starts from the server's state again. */
  session: number;
}

export const PricingEditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [target, setTarget] = React.useState<EditorTarget | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);
  const sessionRef = React.useRef(0);
  const open = React.useCallback<OpenPriceEditor>((model, options = {}) => {
    sessionRef.current += 1;
    setTarget({ model, options, session: sessionRef.current });
    setIsOpen(true);
  }, []);
  const close = React.useCallback(() => setIsOpen(false), []);
  return (
    <PricingEditorContext.Provider value={open}>
      {children}
      {target && (
        <React.Suspense fallback={null}>
          <LazyPriceEditorDrawer
            key={target.session}
            model={target.model}
            initialMode={target.options.mode}
            initialUpstream={target.options.upstream}
            isOpen={isOpen}
            onClose={close}
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
