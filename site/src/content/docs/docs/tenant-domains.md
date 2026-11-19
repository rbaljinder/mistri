---
title: Give a tenant its own domain
description: A tenant admin adds a domain, publishes two DNS records, checks it, and makes it the tenant's primary address.
---

A tenant admin adds a domain, publishes two DNS records, checks it, and makes it the tenant's primary address. Your operator must have [turned custom domains on](/docs/custom-domains-setup/); if Settings has no Domains section, they have not.

1. **Add it.** Open Settings, then Domains, from the staff address (not from a tenant's own host). Type the name, such as `portal.acme.com`, and choose Add. Only the roles your operator named may add, check, or remove; others can see the list but not the records.
2. **Publish the records.** The row shows two records to create at your DNS provider:
   - `CNAME portal.acme.com` pointing to the address shown.
   - `TXT _mistri-verify.portal.acme.com` with the value shown.

   An apex name (`acme.com`) cannot hold a CNAME at most providers: use `www.acme.com`, or a provider that supports ALIAS or CNAME flattening.
3. **Check it.** Choose Check now once the records are published. A check looks both up through public DNS over HTTPS, so a record can take a few minutes to show. A row moves from pending to verified, then live once its certificate is active. You can check a row once every 30 seconds.
4. **Make it primary.** A live domain can be made the tenant's primary address; it is never done for you. Page requests to the old subdomain then redirect to it, and emailed links use it. The staff address keeps working.
5. **Remove it.** Choose Remove on the row. The certificate is released, and the name stops answering at once.

- A domain not verified within 7 days is deleted; the row says how many days remain. Add it again to start over.
- A live domain whose records go missing is re-checked daily, and suspended after three failed checks over 72 hours. Fix the records and choose Check now to restore it. The status shows in the Domains panel and, once per change, in the operator log. A DNS lookup that cannot be answered at all is not a failure, until it has gone on for 72 hours.
- Each tenant may hold a limited number of domains (two by default), pending ones included. Changes are limited to ten a minute.

## Related

- [Set up custom domains](/docs/custom-domains-setup/): what the operator turns on.
- [Tenant Apps](/docs/tenant-apps/): what a tenant is.
