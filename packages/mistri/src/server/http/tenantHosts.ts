/** Operator-owned host routing is presentation intent, never identity or tenant authority. */
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

export interface TenantHostIntent {
  readonly host: string;
  readonly app: string;
  readonly tenant: string;
}

const intents = new WeakMap<IncomingMessage, TenantHostIntent>();

/** Consumers must independently authorize any tenant-scoped read. */
export function getTenantHostIntent(request: IncomingMessage): TenantHostIntent | undefined {
  return intents.get(request);
}

/** Only internally synthesized requests inherit an admitted parent's intent.
 * Forwarding headers cannot establish it, and an existing intent cannot change. */
export function inheritTenantHostIntent(parent: IncomingMessage, child: IncomingMessage): void {
  const intent = intents.get(parent),
    existing = intents.get(child);
  if (existing && existing !== intent) throw new Error('Internal host intent conflicts with its parent.');
  if (intent) intents.set(child, intent);
}

function hostname(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 253 ||
    !value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) {
    throw new Error('Suite host must be a hostname only, without credentials, port, wildcard or URL components.');
  }
  const canonical = value.toLowerCase();
  if (new URL(`http://${canonical}`).hostname !== canonical) throw new Error('Suite host must use its canonical hostname.');
  return canonical;
}

const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** Independent of auth/email helpers: callers pass this normalized config value onward. */
export function normalizeSuitePublicOrigin(value: unknown): string {
  if (typeof value !== 'string' || /[\s@%]/.test(value) || !/^https?:\/\/[^/?#\\]+\/?$/.test(value)) {
    throw new Error('Suite publicOrigin must be an HTTPS origin (HTTP is allowed only on loopback).');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid suite publicOrigin.');
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname)))
  ) {
    throw new Error('Suite publicOrigin must be an HTTPS origin (HTTP is allowed only on loopback).');
  }
  if (url.hostname !== '[::1]') hostname(url.hostname);
  return url.origin;
}

export function validateTenantHosts(value: unknown, apps: readonly string[], publicOrigin?: string): readonly TenantHostIntent[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error('Suite hosts must be a list.');
  const staff = publicOrigin && new URL(publicOrigin).hostname;
  const seen = new Set<string>();
  return Object.freeze(
    value.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !['host', 'app', 'tenant'].includes(key)))
        throw new Error('Invalid suite host mapping.');
      const host = hostname(raw.host);
      if (loopback(host) || isIP(host) || host === staff || seen.has(host))
        throw new Error(`Suite host "${host}" is duplicated or collides with a staff/loopback origin.`);
      if (typeof raw.app !== 'string' || !apps.includes(raw.app)) throw new Error(`Suite host "${host}" names an unknown App.`);
      // eslint-disable-next-line no-control-regex -- Opaque tenant identifiers must exclude ASCII controls.
      if (typeof raw.tenant !== 'string' || !raw.tenant.trim() || raw.tenant !== raw.tenant.trim() || /[\x00-\x1f\x7f]/.test(raw.tenant)) {
        throw new Error(`Suite host "${host}" needs an opaque tenant id.`);
      }
      seen.add(host);
      return Object.freeze({ host, app: raw.app, tenant: raw.tenant });
    }),
  );
}

/** The real Host header only; duplicates and URL-shaped authorities fail closed. */
function requestHostname(req: IncomingMessage): string | undefined {
  if (req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length !== 1) return undefined;
  const value = req.headers.host;
  if (!value) return undefined;
  const match = /^(\[::1\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match || (match[2] !== undefined && (+match[2] < 1 || +match[2] > 65535))) return undefined;
  try {
    return match[1] === '[::1]' ? match[1] : hostname(match[1]);
  } catch {
    return undefined;
  }
}

export function createTenantHostRouter(hosts: readonly TenantHostIntent[], publicOrigin?: string) {
  const mapped = new Map(hosts.map((intent) => [intent.host, Object.freeze({ ...intent })]));
  const staff = publicOrigin && new URL(publicOrigin).hostname;
  return {
    allowedHosts(app: string): readonly string[] {
      return Object.freeze([
        ...new Set([
          ...(staff ? [staff] : []),
          ...[...mapped.values()].filter((intent) => intent.app === app).map((intent) => intent.host),
        ]),
      ]);
    },
    accept(req: IncomingMessage): boolean {
      const host = requestHostname(req);
      if (!host) return false;
      const intent = mapped.get(host);
      if (intent) {
        const existing = intents.get(req);
        if (existing && existing !== intent) return false;
        intents.set(req, intent);
        return true;
      }
      return loopback(host) || host === staff;
    },
  };
}
