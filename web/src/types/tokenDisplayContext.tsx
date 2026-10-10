import React from 'react';
import { DEFAULT_TPS_CALCULATION_MODE, TPS_CALCULATION_PREFERENCE, parseTpsCalculationMode, type TpsCalculationMode } from './tpsCalculation';
import { usePreference } from '../hooks/usePreference';
import { useI18n } from '../i18n';
import {
  DEFAULT_MODEL_CHART_VIEW,
  DEFAULT_REQUEST_MODEL_ICONS,
  DEFAULT_TOKEN_NUMBER_STYLE,
  parseModelChartView,
  parseRequestModelIcons,
  parseTokenNumberStyle,
  resolveTokenNumberStyle,
  type ModelChartView,
  type TokenNumberStyle,
} from './tokenDisplay';

/** The stored preference key holding the console-wide token unit style. */
export const TOKEN_STYLE_PREFERENCE = 'omc_token_style';
/** The stored preference key holding the model panels' grouping view. */
export const MODEL_VIEW_PREFERENCE = 'omc_models_view';
/** The stored preference key holding whether model brand icons appear in the request list. */
export const REQUEST_MODEL_ICONS_PREFERENCE = 'omc_request_model_icons';

interface TokenDisplayContextValue {
  /**
   * How token counts are abbreviated across the console, already resolved against
   * the reading language - see `resolveTokenNumberStyle`. Surfaces render this
   * value, so none of them has to remember the language rule.
   */
  style: TokenNumberStyle;
  /** How the model panels group their series. */
  modelView: ModelChartView;
  tpsMode: TpsCalculationMode;
  showModelIcons: boolean;
  setShowModelIcons: (show: boolean) => void;
  setTpsMode: (mode: TpsCalculationMode) => void;
  setStyle: (style: TokenNumberStyle) => void;
  setModelView: (view: ModelChartView) => void;
}

const TokenDisplayContext = React.createContext<TokenDisplayContextValue>({
  style: DEFAULT_TOKEN_NUMBER_STYLE,
  modelView: DEFAULT_MODEL_CHART_VIEW,
  tpsMode: DEFAULT_TPS_CALCULATION_MODE,
  showModelIcons: DEFAULT_REQUEST_MODEL_ICONS,
  setShowModelIcons: () => undefined,
  setTpsMode: () => undefined,
  setStyle: () => undefined,
  setModelView: () => undefined,
});

/**
 * TokenDisplayProvider owns the console-wide token display settings through the
 * server-stored preference flow, so a choice follows the deployment across
 * browsers like every other console setting.
 *
 * It exists as a provider rather than as per-page `usePreference` calls because
 * the unit style is read by surfaces on different pages - dashboard, request
 * records, the event drawer - and they must not hold two different answers for
 * one setting after a change. One subscription point makes the switch atomic.
 */
export const TokenDisplayProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { lang } = useI18n();
  // Reference-stable parsers are part of usePreference's memo contract; see its
  // note on render loops.
  const parseStyle = React.useRef(parseTokenNumberStyle).current;
  const parseView = React.useRef(parseModelChartView).current;
  const parseTpsMode = React.useRef(parseTpsCalculationMode).current;
  const parseIcons = React.useRef(parseRequestModelIcons).current;

  const stylePref = usePreference<TokenNumberStyle>(TOKEN_STYLE_PREFERENCE, DEFAULT_TOKEN_NUMBER_STYLE, parseStyle);
  const viewPref = usePreference<ModelChartView>(MODEL_VIEW_PREFERENCE, DEFAULT_MODEL_CHART_VIEW, parseView);
  const iconsPref = usePreference<boolean>(REQUEST_MODEL_ICONS_PREFERENCE, DEFAULT_REQUEST_MODEL_ICONS, parseIcons);

  const tpsPref = usePreference<TpsCalculationMode>(TPS_CALCULATION_PREFERENCE, DEFAULT_TPS_CALCULATION_MODE, parseTpsMode);

  // The language rule lives here and only here: every surface reads the resolved
  // value, so a Chinese-only unit can never reach a non-Chinese reading even if a
  // future page forgets the rule.
  const style = React.useMemo(
    () => resolveTokenNumberStyle(stylePref.value, lang),
    [stylePref.value, lang],
  );

  const value = React.useMemo<TokenDisplayContextValue>(
    () => ({
      style,
      modelView: viewPref.value,
      tpsMode: tpsPref.value,
      showModelIcons: iconsPref.value,
      setShowModelIcons: iconsPref.set,
      setTpsMode: tpsPref.set,
      setStyle: stylePref.set,
      setModelView: viewPref.set,
    }),
    [style, stylePref.set, viewPref.value, viewPref.set, tpsPref.value, tpsPref.set, iconsPref.value, iconsPref.set],
  );

  return <TokenDisplayContext.Provider value={value}>{children}</TokenDisplayContext.Provider>;
};

export function useTokenDisplayStyle(): TokenDisplayContextValue {
  return React.useContext(TokenDisplayContext);
}
