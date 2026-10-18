import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePreference } from '../../hooks/usePreference';
import {
  DEFAULT_OAUTH_MANAGEMENT_VIEW,
  parseOAuthManagementView,
  parseOAuthWorkspaceQuery,
  updateWorkspaceSearch,
} from './oauthWorkspaceLogic';

export function useOAuthManagementViewState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const preference = usePreference(
    'oauth_management_view_v1',
    DEFAULT_OAUTH_MANAGEMENT_VIEW,
    parseOAuthManagementView,
  );
  // Links override only the dimensions they name; the saved view supplies the rest.
  const resolvedParams = React.useMemo(() => {
    const next = new URLSearchParams(searchParams);
    for (const key of ['status', 'quota', 'sort'] as const) {
      if (!next.has(key)) next.set(key, preference.value[key]);
    }
    if (!next.has('page_size')) next.set('page_size', String(preference.value.pageSize));
    return next;
  }, [searchParams, preference.value]);
  const queryState = React.useMemo(() => parseOAuthWorkspaceQuery(resolvedParams), [resolvedParams]);

  const intentRef = React.useRef(0);
  React.useEffect(() => () => { intentRef.current += 1; }, []);
  const setSearch = React.useCallback((changes: Record<string, string | number | null | undefined>) => {
    const intent = ++intentRef.current;
    const nextParams = updateWorkspaceSearch(searchParams, changes);
    const viewKeys = ['status', 'quota', 'sort', 'page_size'];
    if (preference.loaded && viewKeys.some((key) => key in changes)) {
      const next = parseOAuthWorkspaceQuery(updateWorkspaceSearch(resolvedParams, changes));
      void preference.set({ pageSize: next.pageSize, status: next.status, quota: next.quota, sort: next.sort }).then(({ ok }) => {
        // An unsaved URL override must not hide the preference's rollback. A later
        // edit or navigation owns the URL by then and must never be undone here.
        if (ok || intentRef.current !== intent) return;
        setSearchParams((current) => current.toString() === nextParams.toString() ? searchParams : current, { replace: true });
      });
    }
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams, resolvedParams, preference.loaded, preference.set]);

  return { searchParams, setSearchParams, queryState, setSearch, isViewLoaded: preference.ready };
}
