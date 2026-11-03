/**
 * The request-record horizon is set in OMC Settings (Data retention). The System page no longer
 * shows it: a meter of how full the window is had no action behind it, and the card it sat in has
 * to stay the same height as the component-health card beside it. This module is kept as the single
 * import site for the retention query key so both pages share one cache entry.
 */
export { DATA_RETENTION_QUERY_KEY } from '../../hooks/useDataRetention';
