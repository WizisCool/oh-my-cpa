export interface PreferenceWireCase {
  id: string;
  method: string;
  path: string;
  body: string | null;
  authenticated: boolean;
  status: number;
  response: Record<string, unknown>;
}
export const PREFERENCE_CONTRACT: {
  version: number;
  server_timezone: string;
  known_keys: string[];
  alternate_server: { timezone: string; response: { preferences: Record<string, unknown>; time_zone: { timezone: string; server_timezone: string; effective_timezone: string } } };
  cases: PreferenceWireCase[];
};
export function createPreferenceFixture(options?: { serverTimezone?: string; authenticated?: boolean }):
  (url: URL, method: string, body: string | null) => {
    status: number;
    headers?: Record<string, string>;
    json: Record<string, unknown>;
  };
