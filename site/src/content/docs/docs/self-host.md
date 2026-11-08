---
title: Self-host
description: Run an App on your own server in a container, with the database brought up to date before the new version starts.
---

Run an App on your own server in a container, with the database brought up to date before the new version starts.

## 1. Write the Dockerfile

```sh
npx @mistriwork/mistri build --app ./my-app --config ./mistri.json --dockerfile Dockerfile
docker build -t my-app .
```

The first command writes the Dockerfile and builds nothing. The image builds the App in its first stage and serves it in its last, on `PORT` with a `/healthz` check. Run `docker build` from the project root, where `package.json` and `package-lock.json` are, so the image installs the same mistri you did.

## 2. Bring the database up to date

```sh
npx @mistriwork/mistri migrate up --config ./mistri.json --migrations ./my-app/migrations
npx @mistriwork/mistri migrate stores up --config ./mistri.json --app ./my-app
```

Run both before the new container starts, and again at each upgrade. The first applies your migrations; the second creates the tables the App's commands and jobs keep for themselves. `migrate status` lists what is still missing.

## 3. If the new version refuses to start

A build serves only under the mistri version that made it:

```text
./build/my-app was built by mistri 1.0.2; this is mistri 1.0.3. A build is pinned to the version that made it: rebuild it with this version's `mistri build`.
```

Rebuild the image. Do not copy a build between mistri versions. A database one version behind says so in the same way: a store that "could not be opened and attested" is not provisioned here, or is not this version's layout. Run step 2 with the new version, with the old server stopped.

## Related

- [Build and deploy](/docs/build-and-deploy/): every flag, and Cloudflare Containers.
- [Observe and operate](/docs/observe/): `/healthz`, `/readyz` and the logs.
