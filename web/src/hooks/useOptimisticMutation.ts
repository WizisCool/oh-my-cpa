import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
} from '@tanstack/react-query';
import { describeError } from '../api/client';
import { useToast } from '../components/feedback';
import {
  buildOptimisticMutationOptions,
  defineOptimisticTarget,
  type OptimisticCacheTarget,
  type OptimisticMutationConfig,
  type OptimisticMutationContext,
} from './optimisticMutation';

export { defineOptimisticTarget, type OptimisticCacheTarget, type OptimisticMutationContext };

export interface UseOptimisticMutationOptions<
  TData,
  TError = unknown,
  TVariables = void,
  TCustomContext = undefined,
> extends Omit<OptimisticMutationConfig<TData, TError, TVariables, TCustomContext>, 'onError'> {
  /**
   * Formats the error message displayed via Toast when the mutation fails and rolls back.
   * Return null/empty string to suppress automatic toast (e.g. when handling custom conflict UI).
   */
  readonly formatError?: (error: TError, variables: TVariables) => string | null;
  readonly onError?: (
    error: TError,
    variables: TVariables,
    context: OptimisticMutationContext<TCustomContext> | undefined,
  ) => void | Promise<void>;
}

/**
 * React hook encapsulating TanStack Query's full optimistic update lifecycle:
 * cancelQueries -> snapshot -> synchronous setQueryData -> rollback + Toast on error ->
 * last-in-flight (isMutating === 1) guarded invalidateQueries on settle.
 */
export function useOptimisticMutation<
  TData,
  TError = unknown,
  TVariables = void,
  TCustomContext = undefined,
>(
  options: UseOptimisticMutationOptions<TData, TError, TVariables, TCustomContext>,
): UseMutationResult<TData, TError, TVariables, OptimisticMutationContext<TCustomContext>> {
  const queryClient = useQueryClient();
  const toast = useToast();

  const mutationOptions = buildOptimisticMutationOptions<TData, TError, TVariables, TCustomContext>(
    queryClient,
    {
      ...options,
      onError: async (error, variables, context) => {
        const message = options.formatError
          ? options.formatError(error, variables)
          : describeError(error);
        if (message) {
          toast.error(message);
        }
        await options.onError?.(error, variables, context);
      },
    },
  );

  return useMutation(mutationOptions);
}

/**
 * Single-cache convenience hook for the common case where a mutation optimistically
 * transforms one primary QueryKey and invalidates optional sibling keys on final settle.
 */
export function useSingleKeyOptimisticMutation<TData, TCache, TVariables, TError = unknown>(params: {
  mutationKey: QueryKey;
  queryKey: QueryKey;
  mutationFn: (variables: TVariables) => Promise<TData>;
  updater: (current: TCache | undefined, variables: TVariables) => TCache | undefined;
  invalidateKeys?: ReadonlyArray<QueryKey>;
  formatError?: (error: TError, variables: TVariables) => string | null;
  onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>;
  onError?: (error: TError, variables: TVariables) => void | Promise<void>;
}) {
  return useOptimisticMutation<TData, TError, TVariables>({
    mutationKey: params.mutationKey,
    mutationFn: params.mutationFn,
    targets: [defineOptimisticTarget<TVariables, TCache>(params.queryKey, params.updater)],
    invalidateKeys: params.invalidateKeys,
    formatError: params.formatError,
    onSuccess: params.onSuccess ? (data, vars) => params.onSuccess?.(data, vars) : undefined,
    onError: params.onError ? (err, vars) => params.onError?.(err, vars) : undefined,
  });
}
