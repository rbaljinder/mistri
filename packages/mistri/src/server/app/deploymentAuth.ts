/**
 * Where one deployment keeps an App's accounts and sessions (`"auth": { "<app>": { "store": "…" } }` in the config
 * file, beside "presentation"). The same App served by two deployments wants two sign-in stores, and the App's own
 * `auth.store` names one for every deployment there is: a `${NAME}` in it moves the choice to the environment, but
 * then every deployment must set that name, the local one too (a field report). The store is the deployment's
 * fact, so the deployment's file may say it; the App's `auth.store` stays the fallback, and the default file
 * under the config directory the fallback after that.
 *
 * It is laid over the definition before the definition is parsed, as a presentation is (appPresentation.ts), so
 * every reader of `app.auth.store` — the sign-in runtime, `migrate stores up`, `check --deploy`, a reload's
 * sign-in comparison — reads the one store this deployment uses, and none has to know where it was written.
 */
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AppDef } from '../../shared/app.js';

export interface DeploymentAuth {
  /** A `postgres://` URL, a `${NAME}` the environment holds, or a SQLite file: an App's `auth.store`, as it takes one. */
  readonly store: string;
}

const KEYS = ['store'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The config's `"auth"`, read: a map from App id to where its sign-ins are kept. A file path is resolved against the
 * config file's own directory, as a connection's SQLite file is: the file travels, and a path written beside it
 * keeps pointing at the thing beside it. A URL or a `${NAME}` is kept as written, and expanded where the App's own is.
 */
export function parseDeploymentAuth(raw: unknown, file: string): Record<string, DeploymentAuth> {
  if (raw === undefined) return {};
  if (!isRecord(raw))
    throw new Error(`${file}: "auth" must name each App's sign-in store by its id, like { "main": { "store": "\${MISTRI_AUTH_STORE}" } }.`);
  return Object.fromEntries(
    Object.entries(raw).map(([id, value]) => {
      const at = `${file}: "auth.${id}"`;
      if (!isRecord(value)) throw new Error(`${at} must be an object with "store".`);
      for (const key of Object.keys(value))
        if (!(KEYS as readonly string[]).includes(key))
          throw new Error(`${at} has no "${key}". It takes: ${KEYS.join(', ')}. The App's roles and providers are the App's own.`);
      const store = value.store;
      if (typeof store !== 'string' || !store.trim())
        throw new Error(`${at}.store must be a postgres:// URL, a \${NAME} the environment holds, or a SQLite file path.`);
      const written = store.trim();
      const located =
        /^\$\{|^postgres(ql)?:\/\//i.test(written) || isAbsolute(written) ? written : resolve(dirname(resolve(file)), written);
      return [id, { store: located }];
    }),
  );
}

/**
 * The definition with the deployment's store laid over its `auth.store`, as written or as a build compiled it (both
 * keep the store as the one string); an App nobody signs in to has no store to place.
 */
export function overlayAuthStore<T extends object>(raw: T, auth: DeploymentAuth, where: { file?: string; id: string }): T {
  const declared = (raw as { auth?: unknown }).auth;
  if (!isRecord(declared))
    throw new Error(
      `${where.file ?? 'the config file'}: "auth.${where.id}".store places the sign-in store of an App nobody signs in to: "${where.id}" declares no "auth". Drop the entry, or declare auth in the App.`,
    );
  return { ...raw, auth: { ...declared, store: auth.store } };
}

/** Who decided where the App's sign-ins are kept: the deployment's config file, or the App's own `auth.store`; undefined for the default. */
export function authStoreFrom(loaded: {
  app: Pick<AppDef, 'id' | 'auth'>;
  deploymentAuth?: { file?: string; apps: Readonly<Record<string, DeploymentAuth>> };
}): string | undefined {
  if (loaded.deploymentAuth?.apps[loaded.app.id]) return `"auth.${loaded.app.id}" in ${loaded.deploymentAuth.file ?? 'the config file'}`;
  return loaded.app.auth?.store ? "the App's auth.store" : undefined;
}
