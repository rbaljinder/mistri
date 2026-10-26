# HTTP sources

An API can be a connection. tablewalk reads it through a *description*: a
JSON file saying which endpoints are lists and which are items, what columns
their rows have, and which filters, sort and paging the API documents. It is
drafted from the API's OpenAPI 3 spec, then kept beside the config file,
where it can be read, reviewed and edited like any other configuration.

HTTP sources are read-only. The browser suite's Parcel fixture
([test/fixtures/apps/parcel](../test/fixtures/apps/parcel/README.md)) is a whole App
over one: a local mock API, its spec, the drafted description and the
connection.

## Draft a description

```sh
tablewalk --from-openapi desk-openapi.json > desk.http.json
```

The spec must be OpenAPI 3 JSON: convert YAML first, and Swagger 2.0 is
refused. A resource is a collection path with an item path beside it
(`/contacts` and `/contacts/{id}`). What the draft had to guess — the paging
style, which parameter searches — and what it skipped (nested paths, rows
that are `oneOf`, remote `$ref`s) is written to stderr. Read it before
trusting the file; the description, not the spec, is what tablewalk obeys.

## Serve an API straight from its spec

```sh
tablewalk --openapi https://api.example.com/openapi.json --api-token-env EXAMPLE_TOKEN
```

One command, no config file and nothing written to disk: the description is
drafted in memory, with the same notes on stderr as `--from-openapi`, and the
API is served as a connection.

- The base URL is the spec's first `servers` entry, resolved against the
  spec's own URL when it is relative. Pass `--api-url` when the spec names no
  server, names one with `{variables}`, or names the wrong one.
- `--api-token-env NAME` sends `$NAME` as a bearer token, so the secret is
  never on the command line. Another header, or anything else a connection
  can say, needs a config.
- Plain `http://` is allowed only to this machine, which is where a local mock
  API lives; anywhere else needs https, or a config with `"insecure": true`.
- A spec at a URL is fetched under the same network rules as the API's own
  requests, and with no credential: download a spec that needs one and name
  the file.
- Saving the connection from the connection manager writes the drafted
  description into the config entry itself.

## Connect

```json
{
  "connections": [
    {
      "name": "Desk",
      "kind": "http",
      "url": "https://desk.example/v1/",
      "description": "desk.http.json",
      "auth": { "bearer": "${DESK_TOKEN}" }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `url` | The base URL. Every path in the description resolves under it. https, with no credential, query or fragment in it. |
| `description` | The drafted file, relative to the config file, or the description itself, inline. |
| `auth` | `{ "bearer": "${TOKEN}" }`, or `{ "header": "x-api-key", "value": "${KEY}" }`. Write the secret as a `${VAR}` reference: it is expanded when the connection opens and sent only as that header. A literal secret works, and is warned about. |
| `insecure` | `true` allows plain `http://`, for an API on a trusted network. |
| `allowLinkLocal` | `true` allows link-local addresses (169.254.0.0/16, fe80::/10), where cloud metadata services answer. |
| `cache` | `{ "ttl": 60 }` answers the same read from the cache for that many seconds (1 to 86,400) after the API answered it: the process's own, or the Valkey a `"kind": "cache"` connection names ([services](../site/src/content/docs/docs/services.md)). Only a 2xx is kept, keyed by path and query. The explorer's API tab always asks the API. |

`writable` and `schemas` are refused on an HTTP connection. `"rows": false`
works as it does for a database. When a browser the server does not trust
changes the URL, the connection opens with no credential at all, rather than
sending it to the new host.

## What a list can ask

The API is asked only what its description declares:

- **filters** — `=` on each documented query parameter, and `in` where the
  parameter takes a list, all of them together (and);
- **sort** — one of the values the API documents;
- **paging** — offset and limit, page and size, or a cursor. A cursor is
  walked forward at most 8 requests to reach a page; a deeper one is refused,
  with a filter as the way round it.

Anything else — an `or`, `contains`, a second sort, a column the API does not
filter on — is refused with a message naming what the API can do. tablewalk
never fetches more and filters the rows itself: a list that quietly showed
other rows than the ones asked for is the one wrong answer.

The explorer offers only what can be answered: filter boxes and a column
header's Filter on … for the documented filters, and header sorting for the
columns the documented sort values name. Inside an App, a refusal says
columns by the App's captions.

Lists carry no total, because an API reports none and counting would walk
every page; the list says whether more rows follow instead. A record opens
from the item path, by its key.

## References

A spec declares no foreign keys, so the draft guesses them from names: a
`carrier_id` column beside a `carriers` resource keyed by the same kind of
value is written as `"references": "carriers"` on that column, and listed
under `guesses`. Correct or remove it in the description like any other
guess.

A reference is a foreign key to the rest of tablewalk: related lists, label
paths such as `carrier_id.name`, the diagram. It is followed one step, and
each target a page names is read once from its item path, at most 50 per
read. A target the API no longer has reads as empty. What would need the
targets inside the API's own query is refused: a filter or a sort on
`carrier_id.name`, a second step, or a count of the records pointing here.
A related list over a reference reads the child through its own filter, so
it works where the child's list documents that parameter.

## Operation explorer

In the database browser, a table read from an HTTP connection has an **API**
tab in place of Definition, since an API's definition is its description.
It offers the resource's two documented reads, its list GET and its item
GET, as a form drawn from the description alone:

- each declared filter, with several values separated by commas where the
  parameter takes a list;
- the search parameter, when there is one;
- the sort, as a choice of its documented values;
- the paging parameters its list takes;
- for one record, its key.

**Send** asks the server, which builds the request from the description,
attaches the connection's credential and sends it under the network rules
below. The tab shows the request line, the status and the JSON body, whole.
A parameter the description does not declare is refused by name before
anything is sent, an error status is shown as its status (its body is not
read), and a failed call is a 502. For a cursor-paged list, **Next page**
sends the cursor the answer names. **Open as table** opens the table view
asking the same question, when the list's parameters are filters and a sort
it can say; the API's own search has no equivalent there.

It is the operator's tool, beside Definition and the SQL pane: an App never
offers it, and a shape-only connection (`"rows": false`) refuses it, because
it shows whole bodies. It only reads.

## The network

Every request leaves through one module, `packages/engine/src/adapters/http/egress.ts`:

- https, unless the connection says `insecure`; never a credential in a URL;
- the host's addresses are resolved and checked, and the checked address is
  the one connected to;
- private networks and loopback are reachable; link-local and cloud metadata
  addresses are not, unless `allowLinkLocal`; `0.0.0.0` never is;
  an IPv6 spelling that carries an IPv4 address (IPv4-mapped, NAT64
  `64:ff9b::/96`, 6to4 `2002::/16`, IPv4-compatible) is judged by that address;
- a redirect is refused, not followed;
- a response must be JSON, at most 5 MB, within 15 seconds (5 to connect);
- an error status is reported as its status, and its body is never read;
- an integer past 2^53 keeps every digit.

A failed call answers 502 in the explorer, naming the path and the status —
never the response body or the credential.
