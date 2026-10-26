/** Child-process test boundary for Node TCP clients, including fetch/http/https. */
import net from 'node:net';

const allowed = new Set<string>(JSON.parse(process.env.MISTRI_TEST_ALLOWED_HOSTS ?? '[]'));
const connect = net.Socket.prototype.connect;
// This preload is only installed by the disposable test host, never production.
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  const object = options && typeof options === 'object' ? (options as Record<string, unknown>) : undefined;
  const host = object ? String(object.host ?? 'localhost') : typeof args[1] === 'string' ? args[1] : 'localhost';
  const socketPath = object?.path ?? (typeof options === 'string' && !/^\d+$/.test(options) ? options : undefined);
  if (socketPath || (!['127.0.0.1', '::1', 'localhost'].includes(host) && !allowed.has(host))) {
    process.stderr.write(`[mistri-test-network-denied] Unexpected outbound connection to ${socketPath ? 'a local socket' : host}\n`);
    throw new Error('Unexpected outbound connection in isolated App test. Inject a loopback service or explicitly allow its host.');
  }
  return Reflect.apply(connect, this, args);
} as typeof connect;
