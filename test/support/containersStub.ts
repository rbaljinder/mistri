/** Stands in for `@cloudflare/containers` (which imports the Workers-only `cloudflare:workers`) in the Node tests. */
export class Container {
  ctx: unknown;
  env: unknown;
  envVars: Record<string, string> = {};
  destroyed = 0;
  started: unknown[][] = [];
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(_request: Request): Promise<Response> {
    return new Response('from the container');
  }
  async destroy(): Promise<void> {
    this.destroyed++;
  }
  async onActivityExpired(): Promise<void> {
    (this as unknown as { expired: number }).expired = ((this as unknown as { expired?: number }).expired ?? 0) + 1;
  }
  async startAndWaitForPorts(...args: unknown[]): Promise<void> {
    this.started.push(args);
  }
}
