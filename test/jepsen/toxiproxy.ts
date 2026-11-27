/**
 * Zero-dependency REST client for Shopify's Toxiproxy (`:8474`).
 *
 * Used with `test/jepsen/docker-compose.yml` to inject latency, bandwidth caps,
 * TCP resets, or complete partitions between Mistri instances and PostgreSQL
 * primary/replica containers.
 */
export interface ToxiproxyProxy {
  readonly name: string;
  readonly listen: string;
  readonly upstream: string;
  readonly enabled: boolean;
}

export interface ToxiproxyToxic {
  readonly name: string;
  readonly type: 'latency' | 'down' | 'bandwidth' | 'slow_close' | 'timeout' | 'reset_peer' | 'slicer' | 'limit_data';
  readonly stream?: 'upstream' | 'downstream';
  readonly toxicity?: number;
  readonly attributes: Readonly<Record<string, number>>;
}

export class ToxiproxyClient {
  private readonly baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:8474') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/version`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureProxy(spec: { readonly name: string; readonly listen: string; readonly upstream: string }): Promise<ToxiproxyProxy> {
    const existing = await fetch(`${this.baseUrl}/proxies/${encodeURIComponent(spec.name)}`);
    if (existing.ok) return (await existing.json()) as ToxiproxyProxy;
    const created = await fetch(`${this.baseUrl}/proxies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...spec, enabled: true }),
    });
    if (!created.ok) throw new Error(`Toxiproxy create failed (${created.status}): ${await created.text()}`);
    return (await created.json()) as ToxiproxyProxy;
  }

  async setEnabled(proxyName: string, enabled: boolean): Promise<void> {
    const res = await fetch(`${this.baseUrl}/proxies/${encodeURIComponent(proxyName)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`Toxiproxy setEnabled failed (${res.status}): ${await res.text()}`);
  }

  async addToxic(proxyName: string, toxic: ToxiproxyToxic): Promise<void> {
    const res = await fetch(`${this.baseUrl}/proxies/${encodeURIComponent(proxyName)}/toxics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: 'downstream',
        toxicity: 1,
        ...toxic,
      }),
    });
    if (!res.ok) throw new Error(`Toxiproxy addToxic failed (${res.status}): ${await res.text()}`);
  }

  async removeToxic(proxyName: string, toxicName: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/proxies/${encodeURIComponent(proxyName)}/toxics/${encodeURIComponent(toxicName)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Toxiproxy removeToxic failed (${res.status}): ${await res.text()}`);
    }
  }

  /** Re-enable all proxies and remove all active toxics. */
  async resetAll(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/reset`, { method: 'POST' });
    if (!res.ok) throw new Error(`Toxiproxy reset failed (${res.status}): ${await res.text()}`);
  }
}
