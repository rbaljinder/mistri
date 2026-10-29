#!/usr/bin/env node
/**
 * A TCP proxy that holds every chunk for a fixed time in each direction, to
 * stand a local database a network away.
 *
 *   node scripts/delay-proxy.mjs --listen 55432 --to 127.0.0.1:5432 [--ms 10] [--host 127.0.0.1]
 *
 * 10 ms each way is a 20 ms round trip, a database in the next availability
 * zone. Every chunk is delivered in order, after `--ms` from when it arrived,
 * so a statement that waits on its answer pays the round trip and a pipelined
 * batch pays it once, exactly as on a real link. Bandwidth is not limited.
 * A measurement tool for docs/performance.md; nothing in the product uses it.
 */
import { createServer, connect } from 'node:net';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const listen = Number(option('--listen'));
const [host, port] = String(option('--to', '')).split(':');
const delay = Number(option('--ms', 10));
/* 0.0.0.0 only where the proxy is its own container (scripts/capacity-harness.mjs): its port is then the network's. */
const bindHost = option('--host', '127.0.0.1');
if (!Number.isInteger(listen) || !host || !Number(port) || !(delay >= 0)) {
  console.error('Usage: node scripts/delay-proxy.mjs --listen <port> --to <host:port> [--ms 10]');
  process.exit(2);
}

/** Writes to `to` what `from` sends, each chunk `delay` ms after it came, in order. */
function pipeDelayed(from, to) {
  from.on('data', (chunk) => {
    // One timer per chunk keeps order because timers with one delay fire in the order they were set.
    setTimeout(() => {
      if (!to.destroyed) to.write(chunk);
    }, delay);
  });
  from.on('end', () => setTimeout(() => to.end(), delay));
  from.on('error', () => to.destroy());
  from.on('close', () => setTimeout(() => to.destroy(), delay));
}

const server = createServer((client) => {
  client.setNoDelay(true);
  const upstream = connect({ host, port: Number(port) });
  upstream.setNoDelay(true);
  pipeDelayed(client, upstream);
  pipeDelayed(upstream, client);
});
server.listen(listen, bindHost, () => console.log(`delay-proxy ${bindHost}:${listen} -> ${host}:${port}, ${delay} ms each way`));
