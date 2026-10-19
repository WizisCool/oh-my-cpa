export type Check = { label: string; command: string; args: string[] };
export type Execute = (checks: Check[]) => Promise<boolean>;
