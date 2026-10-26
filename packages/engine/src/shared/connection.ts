/** Public metadata only. Connection URLs and credentials remain server-side. */
export type SecretSource = 'none' | 'inline' | 'environment' | 'keychain' | 'file';

/** Routing and write capability, without database administration metadata. */
export interface AppSource {
  id: string;
  name: string;
  writable: boolean;
  rows?: boolean;
  /** Some columns are never served over it (`"hidden"`), so it runs no raw SQL. */
  hidesColumns?: true;
}

export type RuntimeMetadata = { appConfigured: false } | { appConfigured: true; active: string | null; apps: AppSource[] };

export interface PublicConnection extends AppSource {
  dialect: string;
  /** Host and database, or a file name. Never a password. */
  detail: string;
  source: 'argument' | 'config' | 'session';
  connected: boolean;
  tables?: number;
  error?: string;
  secret?: SecretSource;
  warning?: string;
  schemas?: string[];
}
