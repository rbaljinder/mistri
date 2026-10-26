import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as served from '../../../../kit/src/client/shellHost.js';
import * as servedAddress from '../../../../kit/src/client/addressMount.js';
import * as servedTransport from '../../../../kit/src/client/transport.js';
import * as host from './shellHost.js';
import * as address from './addressMount.js';
import * as transport from './transport.js';
import { bind, unbind, type EmbedBinding } from '../binding.js';
import { memoryNavigator } from '../navigator.js';

let bound: EmbedBinding;
const title = vi.fn();

beforeEach(() => {
  const root = document.createElement('div');
  root.className = 'tw-root';
  const body = document.createElement('div');
  body.className = 'tw-body';
  body.innerHTML = '<main id="content"><input id="search"></main>';
  const portals = document.createElement('div');
  body.append(portals);
  root.append(body);
  document.body.append(root);
  bound = {
    root,
    body,
    portals,
    navigator: memoryNavigator('/crm/leads/127?tab=notes'),
    address: { base: '/crm', apps: { compass: '' } },
    endpoint: '/api/tw',
    authorization: () => undefined,
    title,
  };
  bind(bound);
});
afterEach(() => {
  unbind();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the embed’s seams', () => {
  it('answer everything the served ones do', () => {
    expect(Object.keys(host).sort()).toEqual(Object.keys(served).sort());
    expect(Object.keys(address).sort()).toEqual(Object.keys(servedAddress).sort());
    expect(Object.keys(transport).sort()).toEqual(Object.keys(servedTransport).sort());
  });

  it('look things up in the shell, not in the host’s document', () => {
    const hosts = document.createElement('div');
    hosts.id = 'content';
    document.body.prepend(hosts);
    expect(host.shellById('content')?.tagName).toBe('MAIN');
    expect(host.shellQuery('#content')?.tagName).toBe('MAIN');
    expect(host.shellRoot()).toBe(bound.root);
    expect(host.portalRoot()).toBe(bound.portals);
    expect(host.popupContainer()).toBe(bound.portals);
  });

  it('hand the title to the host and leave its tab icon alone', () => {
    document.title = 'Host';
    host.setTabTitle('Leads · Compass');
    expect(title).toHaveBeenCalledWith('Leads · Compass');
    expect(document.title).toBe('Host');
    expect(host.tabIcon()).toBeNull();
  });

  it('keep a key typed in the host’s page from the shell’s document handlers', () => {
    const heard = vi.fn();
    const stop = host.addHostListener(document, 'keydown', heard);
    const hostsBox = document.createElement('input');
    document.body.append(hostsBox);
    hostsBox.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    expect(heard).not.toHaveBeenCalled();
    bound.root.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    expect(heard).toHaveBeenCalledTimes(1);
    // A key with nowhere in particular to go is the shell's, as on its own page.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    bound.root.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('read the address through the host’s prefix, and write it back out', () => {
    expect(address.herePath()).toBe('/compass/leads/127');
    expect(address.hereSearch()).toBe('?tab=notes');
    expect(address.shown('/compass/leads/128')).toBe('/crm/leads/128');
    expect(address.served('/api/apps')).toBe('/api/tw/api/apps');
    // An App's own file is the endpoint's, not the host's address: a component chunk under /crm was the host's page.
    expect(address.appFile('/compass/_components/page-pick-walk-0a1b.js')).toBe('/api/tw/_components/page-pick-walk-0a1b.js');
    host.navPush('/crm/leads/128', { step: 3 });
    expect(host.navState()).toEqual({ step: 3 });
  });

  it('ask the endpoint, with the bearer when the session has one', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await transport.fetchServer('/api/me', { headers: { accept: 'application/json' } });
    expect(fetched).toHaveBeenLastCalledWith('/api/tw/api/me', { headers: { accept: 'application/json' } });

    bound.authorization = () => 'Bearer t1';
    await transport.fetchServer('/api/me', { headers: { accept: 'application/json' } });
    const [url, init] = fetched.mock.calls.at(-1)!;
    expect(url).toBe('/api/tw/api/me');
    expect(init?.credentials).toBe('omit');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t1');
    expect(new Headers(init?.headers).get('accept')).toBe('application/json');
  });
});
