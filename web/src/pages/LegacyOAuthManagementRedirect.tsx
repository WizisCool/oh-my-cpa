import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { legacyOAuthManagementRedirect } from './oauthManagement/oauthWorkspaceLogic';

interface LegacyOAuthManagementRedirectProps {
  from: '/oauth' | '/auth-files' | '/quota';
}

/** Parameter-safe replacement for the three surfaces consolidated by the workspace. */
export const LegacyOAuthManagementRedirect: React.FC<LegacyOAuthManagementRedirectProps> = ({ from }) => {
  const location = useLocation();
  const target = React.useMemo(
    () => legacyOAuthManagementRedirect(from, new URLSearchParams(location.search)),
    [from, location.search],
  );
  return <Navigate to={target} replace />;
};
