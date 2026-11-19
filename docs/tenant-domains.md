# Tenant domains: a subdomain for every tenant, and their own domain

Status: D1–D4 built (D4: two site pages, "Give a tenant its own domain" and "Set up custom domains").

Goal: a tenant is reachable, signed in, at `acme.yourapp.com` the moment it is
created, and at `portal.acme.com` after adding two DNS records, with no config
edit and no restart.

**Every part is optional.** A platform with no `tenantDomain` and no custom
domains works exactly as today: every tenant on the one staff host, chosen by
the tenant switcher. Subdomains and custom domains are independent opt-ins; a
platform can use either, both or neither.

## Where we are

- `http/tenantHosts.ts`: a static `hosts: [{host, app, tenant}]` list in the
  suite config, read once at startup. Wildcards are refused. Only the real
  `Host` header counts. Host intent is presentation, never authority.
- `http/suite.ts`: the router builds a static `allowedHosts(app)` list for the
  App's Host-header door.
- A mapped host serves only public intake and landing pages, static files,
  branding, flags and experiments, capability links and a signed-out whoami
  (`tenantAuthenticatedHttp.ts`). **Sign-in is refused there on purpose**;
  `test/suite-hosts.test.ts` asserts that `/api/auth` returns 404 on a mapped
  host.
- Auth is pinned to the staff `publicOrigin`:
  - `suiteIdentity.ts` sets `baseURL` and `trustedOrigins` to it.
  - OAuth and SAML callbacks follow `baseURL`.
  - Cookies are host-only (no Domain attribute) and named `mistri-<app>`.
- Already host-aware: capability and mail links (`linkHosts`), public form
  placement (`tenantPublicPlacement.ts`), sign-in branding.
- The tenant table is `id, status, version, kind`, with no slug.

So the routing exists. What's missing is (a) hosts as data rather than config,
(b) a wildcard parent, (c) sign-in on a tenant's host, (d) verification and TLS
for a domain the tenant owns.

## Design

### 1. Hosts are rows: `__mistri_tenant_host` in the tenant store

| column | meaning |
| --- | --- |
| `host` PK | canonical lowercase hostname |
| `tenant`, `app` | whom it shows |
| `kind` | `subdomain` (under the platform's `tenantDomain`) or `custom` |
| `status` | `pending` → `verified` → `live`; `suspended` |
| `verify_token` | the TXT value (custom only) |
| `checked_at`, `failures` | from the re-check job |
| `primary` | the tenant's canonical host (one per tenant and App) |

- Subdomain rows exist only when `tenantDomain` is set; custom rows need only
  `customDomains` enabled.
- A subdomain row is born `live`.
- Every change writes a tenant-administration receipt, like other tenant
  operations.
- The static `hosts` config stays as a seed, applied at startup and marked
  `operator`.
- **No slug column:** the subdomain label is the host row. It is chosen at
  signup and defaults to the slugified tenant name.
- **Reserved labels** can't be claimed: `www api app admin mail auth static
  assets status docs` and the staff host's own label. The App can add more
  (`tenantDomain.reserved`).

### 2. A wildcard parent: suite config `tenantDomain: "yourapp.com"` (optional)

Unset (the default): no subdomain rows are created, nothing is claimed at
signup, no wildcard DNS or certificate is needed, and the router behaves as
today. Set:

- The router accepts `<one label>.yourapp.com` only when a `live` row exists.
  Every other host still fails closed.
- `allowedHosts(app)` becomes a predicate, `allows(app, host)`, backed by a
  cache: a 30 s TTL plus same-process invalidation on writes, and a negative
  cache so a flood of unknown hosts costs one lookup each per TTL.
- The door, the link writer and the placement code all ask that one predicate.
- `check` validates that the staff host is not under `tenantDomain`, or is a
  reserved label. **Advisory:** the platform domain should be on the Public
  Suffix List, so browsers treat each tenant subdomain as its own site for
  cookies, storage and permission prompts.
- **Operations:** a wildcard DNS record and a wildcard certificate, once.

### 3. Sign-in on a tenant's host: central sign-in, then a handoff

Every sign-in method stays on the staff origin: password, magic link, OAuth,
SAML and passkeys. This avoids registering an OAuth redirect URI per tenant
domain (IdPs won't), passkey rpID sprawl (WebAuthn related origins allow only a
handful), and a trusted-origins list that changes at runtime.

1. `acme.yourapp.com/sign-in` redirects to
   `https://<staff>/sign-in?host=acme.yourapp.com`, drawn in Acme's branding.
2. After sign-in, the staff origin checks that the user is a member of the
   tenant that host names, then mints a **handoff code**: random, 60 s, single
   use, bound to (user, tenant, app, target host, verifier hash), stored in the
   auth store.
3. It redirects to `https://acme.yourapp.com/_mistri/handoff?code=…`. The
   tenant host redeems the code server-side, sets a **host-only, tenant-pinned
   session cookie**, and redirects to the requested page.
4. **On a mapped host, a session is valid only for that host's tenant**:
   `host tenant === session tenant`, or 403. The tenant switcher is hidden
   there; switching tenant goes through the staff host.
5. **Signing out** on a tenant host ends that session and offers "sign out
   everywhere", which ends the staff session too.

The mapped-host allowlist widens only for a request carrying a valid pinned
session. Without one, the surface stays exactly what it is today. This phase
gets a security review before it merges.

### 4. A tenant's own domain (optional: `customDomains: { enabled: true }`)

Works with or without `tenantDomain`. Without it, the CNAME target is
`customDomains.target` (the staff host, or the TLS provider's fallback origin).

- **Who:** a tenant admin, self-serve, from **Settings → Domains**, or the
  operator CLI (`mistri tenant host add|verify|list|remove|primary`). A
  per-tenant limit applies (`customDomains.limit`, default 2); pending rows
  count toward it. Who may edit is `customDomains.editors`, falling back to
  the branding editors. `/api/domains` is refused to a tenant-pinned session,
  so the panel is used from the staff host, never from a tenant's own host.
- **Adding a domain:** the row is created `pending`, and the panel shows
  `CNAME portal.acme.com → acme.yourapp.com` (or `customDomains.target`) and
  `TXT _mistri-verify.portal.acme.com = <token>`. An apex domain gets advice:
  use `www`, or a DNS provider that supports ALIAS/flattening.
- **Verify:** **Check now** looks the records up through a fixed resolver over
  DoH (1.1.1.1, then 8.8.8.8), never the box's own cache. A resolver that
  cannot be reached is not counted as a failure. Both present → `verified` → the TLS provider
  is asked → `live` once the certificate is active.
- **Re-check:** a daily job (an hourly tick re-checks rows last checked 23 h
  or more ago). Three failures in 72 h → `suspended` (the host stops
  resolving) with a warning in the server log, and the next passing check
  restores it. "Unavailable" is not a failure at first: the row records when
  the streak began (`unavailable_since`), warns once (host and App, no token),
  and after 72 h of nothing else counts as a failure on the same path. Each transition to `suspended` or back to `live` is written once to the operator log (host, tenant and reason, never a token); a domain that stays in a state says nothing more, and the status shows in the Domains panel, which is where tenant admins see it. A dangling CNAME can't serve the wrong tenant.
- **Expiry:** a claimed custom row still `pending` `PENDING_DOMAIN_DAYS` (7)
  days after `created_at` is deleted by the same hourly tick (journaled as an
  operator `domain-expiry` removal). The panel says "Expires in N days unless
  verified."
- **Limits:** `/api/domains*` is limited per session and tenant: `check` once
  per 30 s per row, `add`/`remove`/`primary` ten a minute (429 with
  `Retry-After`). The GET list is served from the host router's in-memory
  snapshot (up to 30 s stale for another process's writes; a mutation's reply
  reads fresh), and only editors see tokens. The per-tenant limit is enforced
  under the anchor row's lock, so concurrent adds cannot exceed it.
- **Primary host:** once a custom domain is live and made primary (never
  automatically), GET page requests on the subdomain 301 to it (API calls are
  not redirected), and mail and capability links write it. The staff host
  always keeps working.

### 5. TLS seam (core) and providers

```ts
interface HostCertificates {
  request(host: string, tenantId: string): Promise<'pending' | 'active' | 'failed'>;
  status(host: string, tenantId: string): Promise<'pending' | 'active' | 'failed'>;
  release(host: string, tenantId: string): Promise<void>;
}
```

- **`none` (default):** the operator handles certificates; status is `active`
  once the domain is verified.
- **`caddy` (containers):** Caddy's on-demand TLS calls
  `GET /_mistri/tls-allowed?domain=` on the staff host and gets 200 only for a
  custom row that is `verified` or `live` in any App the suite serves (404
  otherwise, no body, never cached), so certificate issuance can't be abused.
- **`cloudflare` (`@mistriwork/cloudflare`, installed beside mistri):**
  Cloudflare for SaaS custom hostnames, created, polled and deleted, read from
  `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN`. The fallback origin is the
  operator's to set up in Cloudflare. Hostnames above the free allowance are
  billed by Cloudflare. Every hostname it makes carries `custom_metadata`
  naming mistri and the tenant; one without that tag is neither read as a
  tenant's certificate nor deleted.
- Removing a custom domain releases its certificate only if one was requested
  (the row was verified, live or suspended), never for a pending row.
- The host table gained `created_at` and `unavailable_since` (store v2, not yet
  released, so changed in place).

### Later: a setup wizard

Typing two DNS records is where tenants give up. A later wizard, built into
mistri rather than a third-party service, would detect the DNS provider from
the nameservers and pick the best path: Domain Connect (one-click consent at
the provider), a provider API with a scoped token used once and never stored,
or a step-by-step guide per provider. It never asks for a registrar password.
D3 ships with the manual records, Check now and the re-check job.

### Out of scope

- Mail sender domains
- Per-tenant OAuth apps
- Wildcard custom domains (`*.acme.com`)
- Path-based tenants

## Phases

| Phase | What | Gate |
| --- | --- | --- |
| D1 | Host table, `tenantDomain` wildcard, cached predicate, reserved labels, a subdomain claimed when a tenant is created, CLI, PSL advisory; no config → today's behaviour, tested | Public pages, forms and links on `acme.<domain>` with no restart; existing host tests unchanged |
| D2 | Central sign-in, handoff, tenant-pinned sessions, host-tenant check, sign-out | Security review; the generated cross-tenant test gains the host axis; e2e: sign in on host A, refused on host B |
| D3 (built) | Custom domains: Domains panel, verification, re-check job, TLS seam with `caddy` and `cloudflare` | e2e on a fake resolver; one real deployment proof |
| D4 | Docs page "Give a tenant its own address", deploy-target updates, CHANGELOG | Prose tests |

D1 and D2 ship together; a subdomain you can't sign in on is half a feature.
