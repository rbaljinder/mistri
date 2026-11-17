---
title: Set up custom domains
description: Turn on tenant-owned domains in the suite file and pick who issues their certificates, or neither, or Caddy, or Cloudflare.
---

Turn on tenant-owned domains in the suite file and pick who issues their certificates: you, Caddy, or Cloudflare. The tenant's side is in [Give a tenant its own domain](/docs/tenant-domains/).

```json title="suite.json"
{
  "publicOrigin": "https://app.example.com",
  "tenantDomain": "example.com",
  "customDomains": { "enabled": true, "certificates": "caddy", "limit": 2 }
}
```

- `enabled` is off unless you say `true`. It needs `publicOrigin`, the staff host a custom domain can never take.
- `target` is the name tenants point their CNAME at. Leave it out when `tenantDomain` is set (a tenant's subdomain is used); otherwise it is required, such as `domains.example.com`, and must reach this server or your certificate provider's fallback origin.
- `limit` is the most domains per tenant, pending included (default 2, up to 100).
- `editors` names the tenant roles that may change domains; it defaults to the roles that edit branding.
- `certificates` is `none` (default), `caddy`, or `cloudflare`.

A server checks each domain's DNS hourly and re-checks one every 23 hours. It deletes a domain still pending after 7 days, and suspends one after three failed checks in 72 hours. Both are logged by host, never with the verification token.

## Certificates: none

You issue certificates yourself, by wildcard or by hand. A verified domain is treated as live.

## Certificates: Caddy

Caddy asks the server before it fetches a certificate for an unknown name, so it cannot be made to issue for names that are not a tenant's. In the Caddyfile:

```caddy title="Caddyfile"
{
  on_demand_tls {
    ask https://app.example.com/_mistri/tls-allowed
  }
}

https:// {
  tls {
    on_demand
  }
  reverse_proxy 127.0.0.1:4111
}
```

Caddy adds `?domain=<name>`. The server answers 200 only for a custom domain that is verified or live, in any App it serves, and 404 with no body for everything else. Pass the `Host` header through unchanged to the server's port.

## Certificates: Cloudflare for SaaS

Install `@mistriwork/cloudflare` beside mistri and set `"certificates": "cloudflare"`. Provide these in the server's environment (set them as secrets; their values are never logged or stored):

- `CLOUDFLARE_ZONE_ID`: the zone that holds your fallback origin.
- `CLOUDFLARE_API_TOKEN`: a token that may edit custom hostnames on that zone.

In Cloudflare, set the zone's fallback origin to the host that serves this suite, and point `target` at a name on that zone. A verified domain becomes a custom hostname with HTTP validation, and is deleted when the domain is removed. Hostnames this server creates are tagged with the tenant; one it did not create is never read as a tenant's or deleted. Hostnames beyond your Cloudflare plan's allowance are billed by Cloudflare.

## Related

- [Build and deploy](/docs/build-and-deploy/): the TLS proxy and the tenant host.
- [Self-host](/docs/self-host/): running the server.
