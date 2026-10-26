---
title: File storage
description: Keep a file resource's bytes in an S3-compatible bucket (AWS S3, R2, MinIO, B2, Tigris) instead of the database, every read checked by the App.
---

Keep a file resource's bytes in an S3-compatible bucket (AWS S3, R2, MinIO, B2, Tigris) instead of the database, every read checked by the App.

```sh
export MISTRI_S3_ACCESS_KEY_ID=…  MISTRI_S3_SECRET_ACCESS_KEY=…
mistri migrate files up --app ./compass --db "$DATABASE_URL"
```

The App's side names the bucket's address and two text columns; the
credentials stay in the server's environment, never in App source:

```ts
attachment: { access: 'write', file: {
  content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size',
  object: 'object_key', hash: 'sha256', storage: 'bucket',
  bucket: { name: 'acme-files', region: 'auto', prefix: 'compass/',
            endpoint: 'https://<account>.r2.cloudflarestorage.com' } } },
```

<!-- no picture: the App's pages look the same wherever a file's bytes are kept. -->

## What you'll see

- An upload stored in the bucket under `<prefix><app>/<tenant>/<resource>/<id>`, its row holding the key and SHA-256, and `content` null.
- Downloads from `/api/file` after the same access check as before, with ranges, ETags and `?w=` thumbnails working off the bucket's bytes; a public resource's resized pictures (`?w=640&f=webp`) are kept in the same bucket under `<prefix>_variants/<app>/<hash>-<width>.<format>` (and `<hash>.json` for the placeholder), so a second instance starts with the first one's copies.
- `mistri migrate files status` counting each resource's files on each side, and saying how many still have to move.

## When to use it, and when not

- Use a bucket when files outgrow the database: large or many attachments, backups that should stay small, a CDN-sized bill.
- Keep `storage: 'database'` (the default) when files are few and small, or one backup must hold everything.
- Use `presign: true` when downloads are large and many; leave it off when a download must never leave the server's origin.

## Options

| Key | What it does | Default | Status |
| --- | --- | --- | --- |
| `storage` | Where new files go: `'database'` or `'bucket'`; a file is read from wherever its row says | `'database'` | Stable |
| `object`, `hash` | Text columns: the object's key (null for a file in `content`), the file's SHA-256 | none; `object` is needed with a bucket | Stable |
| `bucket.name`, `region` | The bucket, and its region (`auto` for R2 and Tigris) | region `us-east-1` | Stable |
| `bucket.endpoint`, `pathStyle` | The service for any but AWS; `pathStyle: true` for MinIO | AWS, host-style | Stable |
| `bucket.prefix`, `presign` | A folder every key goes under; a download redirects to a URL signed for a minute | none; proxied | Stable |

The same `bucket` for each service:

| Service | `endpoint` | `region` | `pathStyle` |
| --- | --- | --- | --- |
| AWS S3 | (none) | the bucket's, `eu-west-1` | no |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `auto` | no |
| MinIO | `http://localhost:9000` | `us-east-1` | `true` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | `us-west-004` | no |
| Tigris | `https://t3.storage.dev` | `auto` | no |

`MISTRI_S3_SESSION_TOKEN` carries temporary credentials beside the two keys.
Without static keys, a server takes the platform's: an ECS task role
(`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, or `_FULL_URI` with
`AWS_CONTAINER_AUTHORIZATION_TOKEN[_FILE]`, which ECS and EKS Pod Identity set)
or, with `MISTRI_S3_INSTANCE_ROLE=1`, an EC2 instance role over IMDSv2. They are
renewed five minutes before they expire; keys in `MISTRI_S3_*` win when both
are set. Google Cloud Storage takes an HMAC key (Cloud Storage settings,
Interoperability) as the two keys, with `endpoint: 'https://storage.googleapis.com'`,
`region: 'auto'`. A server whose App names a `bucket` refuses to start without
keys or a platform role, and at startup asks each bucket for one key, warning
(not refusing) when it does not answer. An object is stored before its row is
written, and a refused write deletes it at once. A tenant App's keys carry its
tenant, and a row naming another App's, tenant's or resource's object reads as
no file. `up` with `storage: 'database'` (the `bucket` still named) moves files
back.

`object` and `hash` need no grant: a role whose `fields.read` lists the
`content` column can download the file. They are the server's alone: never in a
list, a record, the catalog or an upload's reply, and a request that names one
(a column, filter, sort, export, insert or update) is refused as naming a
column that is not there. The App API refuses to expose either.

`maxBytes` caps one upload: 10 MB when unsaid, at most 25 MB (10 MB in a tenant
App). An upload is one request, and mistri does no S3 multipart upload.

## The sweep

A deleted record's object stays in the bucket until the sweep deletes what no
row names, once it is an hour old. Served with jobs (`--jobs`), the server
sweeps by itself: a built-in job, `mistri-files-sweep`, runs once a day at a
minute picked from the App's id, through the App's job store, so several
servers over one store run each day's sweep once and a failed sweep retries. A
tenant App's runs once for each active tenant, listing only that tenant's keys
and reading only its rows. Otherwise the server says at startup that nothing
sweeps the bucket; run the sweep from cron daily (a tenant App names its
`--policy`):

```sh
mistri migrate files sweep --app ./compass --db "$DATABASE_URL"
```

The sweep also deletes the resized copies of a picture no row names any more,
once they are an hour old. Pictures behind a sign-in are not shared through
the bucket; each instance keeps its own. If you set a lifecycle rule on the
bucket, `_variants/` is the prefix that holds only re-creatable copies, so it
is safe to expire.

## Common mistakes

- The server does not start and names `MISTRI_S3_*` → set both keys, or run under a task or instance role; an upload that says "its store did not answer" means the endpoint is unreachable, as the startup warning says.
- The App does not start: `bucket` needs `object` → add a text column for the key and name it.
- Files of deleted records still in the bucket → serve the App with `--jobs`, or run `mistri migrate files sweep` daily.
- MinIO answers every request with a DNS error → set `pathStyle: true`; a file past 25 MB is refused, since multipart upload is not supported.

## Related

- [Resources and fields](/docs/access-model/): what a resource's grants let a reader see, files included.
- [Resources reference](/docs/dsl-resources/): every key of `file`.
- [Command line](/docs/cli/): `mistri migrate files`, with its exit codes.
- [Secrets and hidden columns](/docs/secrets/): keeping credentials in the environment.
- [Build and deploy](/docs/build-and-deploy/): running the server where the variables are set.
