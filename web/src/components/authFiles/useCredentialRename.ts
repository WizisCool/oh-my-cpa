import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, describeError } from '../../api/client';
import { useToast } from '../feedback/useToast';
import { useT } from '../../i18n';
import type { ManagementAuthFile } from '../../types/managementAuthFile';

/**
 * Names or clears a credential, from its row or from its drawer.
 *
 * The name is Oh My CPA's own metadata and never rewrites the auth file. Every surface that prints a
 * credential reads it from the auth-file list, so a saved name refreshes that list everywhere. The
 * outcome is a toast; the promise answers whether the name was saved, so an editor stays open over
 * a name that was not.
 */
export function useCredentialRename(): (file: ManagementAuthFile, displayName: string) => Promise<boolean> {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  return React.useCallback(async (file, displayName) => {
    const next = displayName.trim();
    if (next === (file.display_name ?? '')) return true;
    try {
      await api.setManagementAuthFileDisplayName(file.name, next, file.display_name_version ?? 0);
      toast.success(t(next ? 'af.renamed' : 'af.rename_cleared'));
      await queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.warning(t('af.rename_conflict'));
        await queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
        return false;
      }
      toast.error(describeError(error) || t('af.rename_failed'));
      return false;
    }
  }, [queryClient, t, toast]);
}
