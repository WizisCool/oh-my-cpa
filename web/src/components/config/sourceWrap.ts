export type SourceWrap = 'on' | 'off';

export function resolveSourceWrap(isPhone: boolean, manualChoice: SourceWrap | null): SourceWrap {
  return manualChoice ?? (isPhone ? 'on' : 'off');
}
