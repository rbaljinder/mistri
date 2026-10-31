/**
 * `--trust-proxy`: which peers the public forms' rate limit may believe
 * about who they forwarded for. Loopback always; beyond it, only the
 * addresses and CIDR ranges the operator named, IPv4, IPv6 and IPv4-mapped
 * alike. The header is walked from the right past every trusted hop to the
 * first that is not; from an untrusted peer it is not read at all, and a
 * malformed one is ignored whole. That list never says whose `--auth-proxy-header`
 * value is believed: `--auth-proxy-from` does, and defaults to loopback only.
 * Startup refuses an entry that is not an address.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  forwardedClient,
  identityFor,
  parseTrustedProxies,
  trustedProxyPeer,
  type ProxyRange,
} from '../packages/engine/src/server/http/trust.js';
import { proxyIdentityLines } from '../packages/engine/src/server/cli/startupOptions.js';

const ranges = (...values: string[]): ProxyRange[] => {
  const parsed = parseTrustedProxies(values);
  assert.deepEqual(parsed.invalid, [], `${values.join(' ')} should parse`);
  return parsed.ranges;
};
const via = (peer: string, forwarded: string | string[] | undefined, trusted: readonly ProxyRange[] = []) =>
  forwardedClient(
    {
      socket: { remoteAddress: peer },
      headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    },
    trusted,
  );

describe('parseTrustedProxies', () => {
  test('reads addresses and CIDR ranges, v4 and v6, several to a value by commas or spaces', () => {
    const parsed = parseTrustedProxies(['10.0.0.0/8', '172.17.0.1', 'fd00::/8, 2001:db8::7', '192.168.0.0/16 ::ffff:10.1.0.0/112,,']);
    assert.deepEqual(parsed.invalid, []);
    assert.deepEqual(
      parsed.ranges.map((range) => range.text),
      ['10.0.0.0/8', '172.17.0.1', 'fd00::/8', '2001:db8::7', '192.168.0.0/16', '::ffff:10.1.0.0/112'],
    );
    // IPv4 is held mapped, so its prefix counts from the 96th bit.
    assert.deepEqual(
      parsed.ranges.map((range) => range.prefix),
      [104, 128, 8, 128, 112, 112],
    );
    assert.ok(Object.isFrozen(parsed.ranges[0]));
  });

  test('names every entry that is not an address or range, and refuses a prefix that trusts everyone', () => {
    const bad = [
      '',
      ' ',
      'proxy.internal',
      '10.0.0.0/33',
      '10.0.0.0/',
      '10.0.0.0/8/1',
      '10.0.0.0/x',
      '10.0.0.0/-1',
      'fd00::/129',
      'fe80::1%eth0',
      '1.2.3.4:80',
      '[::1]',
      '10.0.0.0/0',
      '::/0',
      '10.0.0.256',
    ];
    for (const entry of bad) {
      const parsed = parseTrustedProxies([entry]);
      assert.equal(parsed.ranges.length, 0, JSON.stringify(entry));
      assert.equal(parsed.invalid.length, 1, JSON.stringify(entry));
    }
    assert.deepEqual(parseTrustedProxies(['10.0.0.1, nope, fd00::/8']).invalid, ['nope']);
  });
});

describe('trustedProxyPeer', () => {
  test('loopback is trusted with or without a list', () => {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal(trustedProxyPeer(peer), true, peer);
      assert.equal(trustedProxyPeer(peer, ranges('10.0.0.0/8')), true, peer);
    }
    assert.equal(trustedProxyPeer('10.0.0.5'), false);
    assert.equal(trustedProxyPeer(undefined, ranges('10.0.0.0/8')), false);
    assert.equal(trustedProxyPeer('unknown', ranges('10.0.0.0/8')), false);
  });

  test('IPv4 ranges match on the prefix, an address is itself', () => {
    const list = ranges('10.0.0.0/8', '172.16.0.0/12', '192.168.4.0/22', '203.0.113.9');
    for (const inside of ['10.0.0.0', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.4.1', '192.168.7.254', '203.0.113.9']) {
      assert.equal(trustedProxyPeer(inside, list), true, inside);
    }
    for (const outside of ['11.0.0.1', '9.255.255.255', '172.32.0.0', '172.15.255.255', '192.168.8.0', '203.0.113.10']) {
      assert.equal(trustedProxyPeer(outside, list), false, outside);
    }
  });

  test('IPv6 ranges match on the prefix, a zone on the peer is ignored', () => {
    const list = ranges('fd00::/8', '2001:db8::/32', '2001:db8:ffff::7');
    for (const inside of ['fd12:3456::1', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db8:1234::1', 'FD00::1%eth0']) {
      assert.equal(trustedProxyPeer(inside, list), true, inside);
    }
    for (const outside of ['fe80::1', 'fc00::1', '2001:db9::1', '2001:0db7:ffff::1']) {
      assert.equal(trustedProxyPeer(outside, list), false, outside);
    }
  });

  test('an IPv4-mapped peer is its IPv4 address, either way round', () => {
    assert.equal(trustedProxyPeer('::ffff:10.1.2.3', ranges('10.0.0.0/8')), true);
    assert.equal(trustedProxyPeer('::ffff:a01:203', ranges('10.0.0.0/8')), true, 'hex mapped form');
    assert.equal(trustedProxyPeer('172.17.0.1', ranges('::ffff:172.17.0.1')), true);
    assert.equal(trustedProxyPeer('198.51.100.4', ranges('::ffff:0:0/96')), true, 'every mapped IPv4');
    assert.equal(trustedProxyPeer('::ffff:11.0.0.1', ranges('10.0.0.0/8')), false);
    // An IPv4 range is not an IPv6 one that happens to share the low bits.
    assert.equal(trustedProxyPeer('::a01:203', ranges('10.0.0.0/8')), false);
    assert.equal(trustedProxyPeer('10.0.0.1', ranges('fd00::/8')), false);
  });
});

describe('forwardedClient with --trust-proxy', () => {
  const list = ranges('10.0.0.0/8', 'fd00::/8');

  test("an untrusted peer's header is ignored: the client is the peer", () => {
    assert.equal(via('192.0.2.10', '203.0.113.7', list), '192.0.2.10');
    assert.equal(via('11.0.0.5', '203.0.113.7', list), '11.0.0.5');
    assert.equal(via('2001:db8::1', '203.0.113.7', list), '2001:db8::1');
  });

  test('a trusted peer beyond loopback is read like a loopback one', () => {
    assert.equal(via('10.0.0.5', '203.0.113.7', list), '203.0.113.7');
    assert.equal(via('::ffff:10.0.0.5', '203.0.113.7', list), '203.0.113.7', "a dual-stack socket's mapped peer");
    assert.equal(via('fd00::2', '2001:DB8::7', list), '2001:db8::7');
    // Without the list the same peer is its own address, as before.
    assert.equal(via('10.0.0.5', '203.0.113.7'), '10.0.0.5');
  });

  test('the walk goes right to left past two trusted hops to the first untrusted one', () => {
    // peer 10.0.0.5 -> it appended 10.0.0.9 (another proxy) -> which appended the client.
    assert.equal(via('10.0.0.5', '198.51.100.1, 203.0.113.7, 10.0.0.9', list), '203.0.113.7');
    assert.equal(via('127.0.0.1', '198.51.100.1, 203.0.113.7, fd00::9, 10.0.0.9', list), '203.0.113.7', 'loopback, then v6 and v4 proxies');
    assert.equal(via('fd00::2', ['2001:db8::7', 'fd00::1'], list), '2001:db8::7');
    // What the client wrote to the left of its own address never decides.
    assert.notEqual(via('10.0.0.5', '198.51.100.1, 203.0.113.7, 10.0.0.9', list), '198.51.100.1');
    // An unnamed proxy in the chain is where the walk stops: its clients share it.
    assert.equal(via('127.0.0.1', '203.0.113.7, 10.0.0.9'), '10.0.0.9');
  });

  test('every hop trusted: the furthest is the client', () => {
    assert.equal(via('10.0.0.5', '10.0.0.8, 10.0.0.9', list), '10.0.0.8');
    assert.equal(via('127.0.0.1', '127.0.0.1, ::1'), '127.0.0.1');
  });

  test('a malformed header from a trusted peer is ignored whole: the peer', () => {
    for (const header of [
      '',
      'nonsense',
      '203.0.113.7, nonsense',
      '203.0.113.7:4431, 10.0.0.9',
      '10.0.0.0/8',
      Array.from({ length: 33 }, () => '203.0.113.7').join(','),
    ]) {
      assert.equal(via('10.0.0.5', header, list), '10.0.0.5', JSON.stringify(header));
    }
  });

  test('identity trust reads --auth-proxy-from: a forged header is believed only from loopback or a listed identity proxy', () => {
    const bound = {
      host: '0.0.0.0',
      port: 4111,
      identityHeader: 'X-Forwarded-User',
      identityProxies: list,
    };
    const from = (peer: string, headers: Record<string, string> = {}) => identityFor({ headers, socket: { remoteAddress: peer } }, bound);
    const forged = { 'x-forwarded-user': 'admin@example.org' };
    assert.deepEqual(from('10.0.0.5', forged), { who: 'admin@example.org' });
    assert.deepEqual(from('127.0.0.1', forged), { who: 'admin@example.org' });
    assert.match(from('203.0.113.9', forged).refusal ?? '', /X-Forwarded-User only from its proxy.*not come from the trusted proxy/);
    assert.ok(from('203.0.113.9', forged).who === undefined, 'a forgery names no one');
    assert.match(from('203.0.113.9').refusal ?? '', /carried none/);
    assert.ok(from('10.0.0.5').refusal, 'a listed proxy that sent no header is still refused');
    assert.deepEqual(from('127.0.0.1'), { who: 'local' });
  });

  test('a --trust-proxy peer is not an identity proxy: its header is refused, and loopback is believed by default', () => {
    const forged = { 'x-forwarded-user': 'admin@example.org' };
    const from = (peer: string, bound: { identityProxies?: readonly ProxyRange[] }) =>
      identityFor(
        { headers: forged, socket: { remoteAddress: peer } },
        { host: '0.0.0.0', port: 4111, identityHeader: 'X-Forwarded-User', trustedProxies: list, ...bound },
      );
    // 10.0.0.5 is in --trust-proxy, so its X-Forwarded-For is read, but with no --auth-proxy-from it cannot name anyone.
    const refused = from('10.0.0.5', {});
    assert.match(refused.refusal ?? '', /only from its proxy.*--auth-proxy-from/);
    assert.ok(refused.who === undefined, 'a forgery names no one');
    // Listing it for identity elsewhere does not help a different peer in the same trusted range.
    assert.ok(from('10.0.0.6', { identityProxies: ranges('10.0.0.5') }).refusal);
    assert.deepEqual(from('10.0.0.5', { identityProxies: ranges('10.0.0.5') }), { who: 'admin@example.org' });
    assert.deepEqual(from('127.0.0.1', {}), { who: 'admin@example.org' }, 'loopback needs no list');
    assert.ok(from('203.0.113.9', { identityProxies: ranges('10.0.0.5') }).refusal);
  });
});

describe('the --trust-proxy flag at startup', () => {
  const start = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TABLEWALK_TRUST_PROXY: '',
        DATABASE_URL: '',
        ...env,
      },
    });

  test('an entry that is not an address or range stops startup, named', () => {
    const flag = start(['--trust-proxy', '10.0.0.0/8,proxy.internal']);
    assert.equal(flag.status, 1, flag.stderr);
    assert.match(flag.stderr, /--trust-proxy takes an IPv4 or IPv6 address or CIDR range/);
    assert.match(flag.stderr, /"proxy\.internal" is not one/);
    const missing = start(['--trust-proxy']);
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /--trust-proxy takes/);
    const env = start([], { TABLEWALK_TRUST_PROXY: 'fd00::/8 10.0.0.0/33' });
    assert.equal(env.status, 1, env.stderr);
    assert.match(env.stderr, /"10\.0\.0\.0\/33" is not one\. It comes from the flag or TABLEWALK_TRUST_PROXY\./);
  });
});

describe('the --auth-proxy-from flag at startup', () => {
  const start = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, TABLEWALK_AUTH_PROXY_FROM: '', TABLEWALK_TRUST_PROXY: '', DATABASE_URL: '', ...env },
    });

  test('an entry that is not an address or range stops startup, named', () => {
    const flag = start(['--auth-proxy-from', '10.0.0.7,proxy.internal']);
    assert.equal(flag.status, 1, flag.stderr);
    assert.match(flag.stderr, /--auth-proxy-from takes an IPv4 or IPv6 address or CIDR range/);
    assert.match(flag.stderr, /"proxy\.internal" is not one/);
    const env = start([], { TABLEWALK_AUTH_PROXY_FROM: '10.0.0.0/33' });
    assert.equal(env.status, 1, env.stderr);
    assert.match(env.stderr, /"10\.0\.0\.0\/33" is not one\. It comes from the flag or TABLEWALK_AUTH_PROXY_FROM\./);
  });

  test('the flag and the variable are read into their own list, apart from --trust-proxy', async () => {
    const { parseArgs } = await import('../packages/engine/src/server/cli/args.js');
    const { setProduct } = await import('../packages/engine/src/server/product.js');
    setProduct('tablewalk');
    const before = process.env.TABLEWALK_AUTH_PROXY_FROM;
    try {
      const parsed = parseArgs(['--auth-proxy-from', '10.0.0.7', '--trust-proxy', '10.0.0.0/8']);
      assert.deepEqual(parsed.authProxyFrom, ['10.0.0.7']);
      assert.deepEqual(parsed.trustProxy, ['10.0.0.0/8']);
      process.env.TABLEWALK_AUTH_PROXY_FROM = '10.0.0.8,fd00::7';
      assert.deepEqual(parseArgs([]).authProxyFrom, ['10.0.0.8', 'fd00::7']);
    } finally {
      if (before === undefined) delete process.env.TABLEWALK_AUTH_PROXY_FROM;
      else process.env.TABLEWALK_AUTH_PROXY_FROM = before;
    }
  });
});

describe('the retired --trust-proxy-header at startup', () => {
  /* Renamed to --auth-proxy-header before 1.0. Ignored, the old spelling
     would start a server that no longer requires the identity header, so it
     stops startup and names the new one: the flag and the variable both. */
  const start = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TABLEWALK_TRUST_PROXY_HEADER: '',
        TABLEWALK_AUTH_PROXY_HEADER: '',
        DATABASE_URL: '',
        ...env,
      },
    });

  test('the old flag stops startup and names --auth-proxy-header', () => {
    const run = start([':memory:', '--trust-proxy-header', 'X-Forwarded-User']);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /--trust-proxy-header is now --auth-proxy-header/);
  });

  test('the old variable stops startup and names TABLEWALK_AUTH_PROXY_HEADER', () => {
    const run = start([':memory:'], {
      TABLEWALK_TRUST_PROXY_HEADER: 'X-Forwarded-User',
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /TABLEWALK_TRUST_PROXY_HEADER is now TABLEWALK_AUTH_PROXY_HEADER/);
  });

  test('the new flag and variable are read', async () => {
    const { parseArgs } = await import('../packages/engine/src/server/cli/args.js');
    /* In this process the engine reads in the browser's name, as the browser's main says (product.ts). */
    const { setProduct } = await import('../packages/engine/src/server/product.js');
    setProduct('tablewalk');
    assert.equal(parseArgs(['--auth-proxy-header', 'X-Forwarded-User']).authProxyHeader, 'X-Forwarded-User');
    assert.equal(parseArgs(['--trust-proxy-header', 'X-Forwarded-User']).authProxyHeader, undefined);
    const before = process.env.TABLEWALK_AUTH_PROXY_HEADER;
    try {
      process.env.TABLEWALK_AUTH_PROXY_HEADER = 'X-Identity';
      assert.equal(parseArgs([]).authProxyHeader, 'X-Identity');
    } finally {
      if (before === undefined) delete process.env.TABLEWALK_AUTH_PROXY_HEADER;
      else process.env.TABLEWALK_AUTH_PROXY_HEADER = before;
    }
  });
});

describe('client address behind a managed front end', async () => {
  const { parseClientAddressPolicy } = await import('../packages/engine/src/server/http/trust.js');
  const { configureServerSettings, defaultServerSettings, withServerSettings } =
    await import('../packages/engine/src/adapters/serverSettings.js');
  // The process's policy: what a request outside any server's scope is keyed by (adapters/serverSettings.ts).
  const setClientAddressPolicy = (clientAddress: { hops?: number; cloudflare?: boolean }) => configureServerSettings({ clientAddress });
  const request = (peer: string, headers: Record<string, string>) => forwardedClient({ socket: { remoteAddress: peer }, headers });
  const googleFrontEnd = '34.96.1.1';

  test('by default both the hop count and Cloudflare header are ignored', () => {
    setClientAddressPolicy({});
    assert.equal(request(googleFrontEnd, { 'x-forwarded-for': '203.0.113.9' }), googleFrontEnd);
    assert.equal(request(googleFrontEnd, { 'cf-connecting-ip': '203.0.113.9' }), googleFrontEnd);
  });

  test('--trust-proxy-hops picks the address that many places from the right, whatever the client wrote', () => {
    try {
      setClientAddressPolicy({ hops: 1 });
      // The visitor sent "6.6.6.6"; the front end appended the address it saw.
      assert.equal(request(googleFrontEnd, { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), '203.0.113.9');
      assert.equal(request(googleFrontEnd, { 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9');
      setClientAddressPolicy({ hops: 2 });
      assert.equal(
        request(googleFrontEnd, {
          'x-forwarded-for': '6.6.6.6, 203.0.113.9, 130.211.0.5',
        }),
        '203.0.113.9',
      );
      // Fewer entries than hops: the furthest, never an invented address.
      assert.equal(request(googleFrontEnd, { 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9');
      // No header, or a malformed one, is the peer.
      assert.equal(request(googleFrontEnd, {}), googleFrontEnd);
      assert.equal(
        request(googleFrontEnd, {
          'x-forwarded-for': 'not-an-ip, 203.0.113.9',
        }),
        googleFrontEnd,
      );
      // Hops do not make the Cloudflare header believable.
      assert.equal(request(googleFrontEnd, { 'cf-connecting-ip': '1.2.3.4' }), googleFrontEnd);
    } finally {
      setClientAddressPolicy({});
    }
  });

  test('two servers in one process each key by their own front end, however their requests interleave', async () => {
    const behindOneHop = {
      ...defaultServerSettings(),
      clientAddress: { hops: 1 },
    };
    const direct = defaultServerSettings();
    const forwarded = { 'x-forwarded-for': '203.0.113.9' };
    const seen: string[] = [];
    const later = (settings: typeof direct, label: string) =>
      withServerSettings(settings, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(`${label} ${request(googleFrontEnd, forwarded)}`);
      });
    // The second server started after the first and before either's request: it used to decide both.
    await Promise.all([later(behindOneHop, 'hops'), later(direct, 'direct')]);
    assert.deepEqual(seen.sort(), [`direct ${googleFrontEnd}`, 'hops 203.0.113.9']);
    // Outside both, the process's own.
    assert.equal(request(googleFrontEnd, forwarded), googleFrontEnd);
  });

  test('--trust-proxy-cloudflare reads CF-Connecting-IP, and only a real address', () => {
    try {
      setClientAddressPolicy({ cloudflare: true });
      assert.equal(
        request('172.67.1.1', {
          'cf-connecting-ip': '203.0.113.9',
          'x-forwarded-for': '6.6.6.6',
        }),
        '203.0.113.9',
      );
      assert.equal(request('172.67.1.1', { 'cf-connecting-ip': '2001:DB8::1' }), '2001:db8::1');
      assert.equal(request('172.67.1.1', { 'cf-connecting-ip': 'garbage' }), '172.67.1.1');
      assert.equal(request('172.67.1.1', {}), '172.67.1.1');
    } finally {
      setClientAddressPolicy({});
    }
  });

  test('the flags are read and a bad hop count is named', () => {
    assert.deepEqual(parseClientAddressPolicy({}), { policy: {} });
    assert.deepEqual(parseClientAddressPolicy({ hops: '2' }), {
      policy: { hops: 2 },
    });
    assert.deepEqual(parseClientAddressPolicy({ cloudflare: true }), {
      policy: { cloudflare: true },
    });
    // Both at once is two rules for one question, so it is refused rather than one quietly winning.
    const both = parseClientAddressPolicy({ hops: '2', cloudflare: true });
    assert.ok('error' in both && /--trust-proxy-hops and --trust-proxy-cloudflare are two ways to find the client/.test(both.error));
    for (const bad of ['0', '-1', 'two', '1.5', '33', '']) {
      const read = parseClientAddressPolicy({ hops: bad });
      assert.ok('error' in read && read.error.includes('--trust-proxy-hops'), bad);
    }
  });

  test('startup refuses a bad hop count and accepts the environment variables', () => {
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'packages/tablewalk/src/server/index.ts', '--no-config', ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 30_000,
      });
    const bad = run([':memory:', '--trust-proxy-hops', 'x']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--trust-proxy-hops takes a whole number/);
    const fromEnv = run([':memory:'], { TABLEWALK_TRUST_PROXY_HOPS: '0' });
    assert.notEqual(fromEnv.status, 0);
    assert.match(fromEnv.stderr, /TABLEWALK_TRUST_PROXY_HOPS/);
    const both = run([':memory:', '--trust-proxy-hops', '1'], {
      TABLEWALK_TRUST_PROXY_CLOUDFLARE: '1',
    });
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /two ways to find the client: name one/);
  });
});

describe('the startup lines name who may set --auth-proxy-header', () => {
  test('loopback alone, said as such, and nothing without the flag', () => {
    assert.deepEqual(proxyIdentityLines('127.0.0.1', undefined), []);
    const lines = proxyIdentityLines('127.0.0.1', 'X-Forwarded-User');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /X-Forwarded-User .*from loopback only/);
  });

  test('beyond loopback with no --auth-proxy-from warns that an off-box proxy is refused', () => {
    const lines = proxyIdentityLines('0.0.0.0', 'X-Forwarded-User');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^Warning: .*no --auth-proxy-from.*Name its address with --auth-proxy-from/);
  });

  test('a single listed host is named, and neither warning appears', () => {
    const lines = proxyIdentityLines('0.0.0.0', 'X-Forwarded-User', ranges('10.0.0.7', '2001:db8::7/128', '192.0.2.4/32'));
    assert.deepEqual(lines.length, 1);
    assert.match(lines[0], /from loopback and 10\.0\.0\.7, 2001:db8::7\/128, 192\.0\.2\.4\/32/);
  });

  test('a range wider than one host warns that every peer in it can assert identity', () => {
    for (const wide of ['10.0.0.0/8', '192.0.2.0/31', 'fd00::/8', '2001:db8::/127']) {
      const lines = proxyIdentityLines('0.0.0.0', 'X-Forwarded-User', ranges('10.0.0.7', wide));
      assert.equal(lines.length, 2, wide);
      assert.match(
        lines[1],
        new RegExp(
          `^Warning: --auth-proxy-from ${wide.replace(/[./]/g, '\\$&')} is wider than one host: every peer in it can assert who is signed in`,
        ),
      );
    }
    // It is a warning, and it is said on loopback too: the range is the exposure, not the bind address.
    assert.equal(proxyIdentityLines('127.0.0.1', 'X-Forwarded-User', ranges('10.0.0.0/8')).length, 2);
    assert.deepEqual(proxyIdentityLines('0.0.0.0', undefined, ranges('10.0.0.0/8')), []);
  });
});
