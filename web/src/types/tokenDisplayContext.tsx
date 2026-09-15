import React from 'react';
import { usePreference } from '../hooks/usePreference';
import {
  DEFAULT_MODEL_CHART_VIEW,
  DEFAULT_TOKEN_NUMBER_STYLE,
  parseModelChartView,
  parseTokenNumberStyle,
  type ModelChartView,
  type TokenNumberStyle,
} from './tokenDisplay';

/** The stored preference key holding the console-wide token unit style. */
export const TOKEN_STYLE_PREFERENCE = 'omc_token_style';
/** The stored preference key holding the model panels' grouping view. */
export const MODEL_VIEW_PREFERENCE = 'omc_models_view';

interface TokenDisplayContextValue {
  /** How token counts are abbreviated across the console. */
  style: TokenNumberStyle;
  /** How the model panels group their series. */
  modelView: ModelChartView;
  setStyle: (style: TokenNumberStyle) => void;
  setModelView: (view: ModelChartView) => void;
}

const TokenDisplayContext = React.createContext<TokenDisplayContextValue>({
  style: DEFAULT_TOKEN_NUMBER_STYLE,
  modelView: DEFAULT_MODEL_CHART_VIEW,
  setStyle: () => undefined,
  setModelView: () => undefined,
});

/**
 * TokenDisplayProvider owns the two console-wide display settings through the
 * server-stored preference flow, so a choice follows the deployment across
 * browsers like every other console setting.
 *
 * It exists as a provider rather than as per-page `usePreference` calls because
 * the unit style is read by surfaces on different pages - dashboard, request
 * records, the event drawer - and they must not hold two different answers for
 * one setting after a change. One subscription point makes the switch atomic.
 */
export const TokenDisplayProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Reference-stable parsers are part of usePreference's memo contract; see its
  // note on render loops.
  const parseStyle = React.useRef(parseTokenNumberStyle).current;
  const parseView = React.useRef(parseModelChartView).current;

  const stylePref = usePreference<TokenNumberStyle>(TOKEN_STYLE_PREFERENCE, DEFAULT_TOKEN_NUMBER_STYLE, parseStyle);
  const viewPref = usePreference<ModelChartView>(MODEL_VIEW_PREFERENCE, DEFAULT_MODEL_CHART_VIEW, parseView);

  const value = React.useMemo<TokenDisplayContextValue>(
    () => ({
      style: stylePref.value,
      modelView: viewPref.value,
      setStyle: stylePref.set,
      setModelView: viewPref.set,
    }),
    [stylePref.value, stylePref.set, viewPref.value, viewPref.set],
  );

  return <TokenDisplayContext.Provider value={value}>{children}</TokenDisplayContext.Provider>;
};

export function useTokenDisplayStyle(): TokenDisplayContextValue {
  return React.useContext(TokenDisplayContext);
}
