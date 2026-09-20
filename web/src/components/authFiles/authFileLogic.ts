import type { ManagementAuthFile } from '../../types/managementAuthFile';

export const HEALTHY_STATUS_MESSAGES = new Set([
  'ok',
  'healthy',
  'ready',
  'success',
  'available',
  'active',
]);

export function getAuthFileStatusMessage(file: ManagementAuthFile): string {
  return (file.status_message ?? '').trim();
}

export function hasAuthFileStatusWarning(file: ManagementAuthFile): boolean {
  const msg = getAuthFileStatusMessage(file);
  return Boolean(msg) && !HEALTHY_STATUS_MESSAGES.has(msg.toLowerCase());
}

export function isAuthFileDisabled(file: ManagementAuthFile): boolean {
  return (
    file.disabled === true ||
    (typeof file.status === 'string' && file.status.trim().toLowerCase() === 'disabled')
  );
}

export function isAuthFileProblem(file: ManagementAuthFile): boolean {
  if (isAuthFileDisabled(file)) return false;
  const status = typeof file.status === 'string' ? file.status.trim().toLowerCase() : '';
  return file.unavailable === true || status === 'error' || hasAuthFileStatusWarning(file);
}

export function isAuthFileHealthy(file: ManagementAuthFile): boolean {
  return !isAuthFileDisabled(file) && !isAuthFileProblem(file);
}

export function providerOf(file: ManagementAuthFile): string {
  return (file.type || file.provider || 'unknown').trim().toLowerCase();
}

export interface AuthFileIdentity {
  primary: string;
  secondary?: string;
  isAccountPrimary: boolean;
}

export function deriveAuthFileIdentity(file: ManagementAuthFile): AuthFileIdentity {
  const account = (file.email || file.project_id || '').trim();
  const name = (file.name || '').trim();
  if (account) {
    return {
      primary: account,
      secondary: name !== account ? name : undefined,
      isAccountPrimary: true,
    };
  }
  return {
    primary: name || '—',
    secondary: undefined,
    isAccountPrimary: false,
  };
}

export type AuthFileStatusFilter = 'all' | 'enabled' | 'disabled' | 'problem';

export function matchesStatusFilter(
  file: ManagementAuthFile,
  filter: AuthFileStatusFilter
): boolean {
  if (filter === 'all') return true;
  if (filter === 'disabled') return isAuthFileDisabled(file);
  if (filter === 'problem') return isAuthFileProblem(file);
  if (filter === 'enabled') return isAuthFileHealthy(file);
  return true;
}

export type AuthFileSortKey =
  | 'name-asc'
  | 'name-desc'
  | 'requests-desc'
  | 'priority-desc'
  | 'weight-desc';

export function sortAuthFiles(
  files: ManagementAuthFile[],
  sortKey: AuthFileSortKey
): ManagementAuthFile[] {
  const copy = [...files];
  switch (sortKey) {
    case 'name-asc':
      return copy.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
    case 'name-desc':
      return copy.sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' })
      );
    case 'requests-desc':
      return copy.sort((a, b) => {
        const totalA = (a.success ?? 0) + (a.failed ?? 0);
        const totalB = (b.success ?? 0) + (b.failed ?? 0);
        if (totalB !== totalA) return totalB - totalA;
        return a.name.localeCompare(b.name);
      });
    case 'priority-desc':
      return copy.sort((a, b) => {
        const prioA = a.priority ?? 0;
        const prioB = b.priority ?? 0;
        if (prioB !== prioA) return prioB - prioA;
        return a.name.localeCompare(b.name);
      });
    case 'weight-desc':
      return copy.sort((a, b) => {
        const wA = a.weight ?? 1;
        const wB = b.weight ?? 1;
        if (wB !== wA) return wB - wA;
        return a.name.localeCompare(b.name);
      });
    default:
      return copy.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function filterAuthFiles(
  files: ManagementAuthFile[],
  query: string,
  provider: string,
  statusFilter: AuthFileStatusFilter
): ManagementAuthFile[] {
  const q = query.trim().toLowerCase();
  return files.filter((file) => {
    if (provider !== 'all' && providerOf(file) !== provider) {
      return false;
    }
    if (!matchesStatusFilter(file, statusFilter)) {
      return false;
    }
    if (q) {
      const match = [
        file.name,
        file.email,
        file.project_id,
        file.type,
        file.provider,
        file.auth_index,
        file.note,
        file.status_message,
      ].some((val) => val && val.toLowerCase().includes(q));
      if (!match) return false;
    }
    return true;
  });
}

export function chunkItems<T>(items: T[], chunkSize = 100): T[][] {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export async function executeBatchStatus(
  files: ManagementAuthFile[],
  disabled: boolean,
  setStatusFn: (name: string, disabled: boolean, authIndex?: string) => Promise<unknown>,
  concurrency = 5
): Promise<{ succeeded: string[]; failed: Array<{ name: string; error: string }> }> {
  const eligible = files.filter((f) => !f.runtime_only);
  const succeeded: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const workerCount = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 5;

  for (let i = 0; i < eligible.length; i += workerCount) {
    const chunk = eligible.slice(i, i + workerCount);
    const results = await Promise.allSettled(
      chunk.map(async (file) => {
        await setStatusFn(file.name, disabled, file.auth_index);
        return file.name;
      })
    );
    results.forEach((res, index) => {
      const fileName = chunk[index].name;
      if (res.status === 'fulfilled') {
        succeeded.push(fileName);
      } else {
        const errMsg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        failed.push({ name: fileName, error: errMsg });
      }
    });
  }

  return { succeeded, failed };
}
