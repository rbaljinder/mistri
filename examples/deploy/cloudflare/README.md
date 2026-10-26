# mistri App on Cloudflare Containers

A template, not a deploy: a Worker, a `wrangler.jsonc` and a keep-awake cron for one built App. Nothing here
runs until you copy it into your project and deploy it with your own account.

Read [docs/deploy-targets.md](../../../docs/deploy-targets.md#cloudflare-containers) first. Cloudflare Containers
do not autoscale: this runs a fixed number of instances (one, by default) and is unfit for an App that must scale
out. The App must keep every store on PostgreSQL (`mistri check --deploy`).

```sh
# in your project, beside package.json and package-lock.json
cp -r path/to/mistri/examples/deploy/cloudflare ./cloudflare
npx @mistriwork/mistri build --app my-app --commands my-app/commands.ts --config mistri.json --dockerfile Dockerfile
cd cloudflare && npm install
npx wrangler secret put BETTER_AUTH_SECRET     # and each ${NAME} mistri.json reads
npx wrangler deploy
```

What to edit: the domain, `MISTRI_PUBLIC_URL` and `MISTRI_ALLOWED_HOSTS` in `wrangler.jsonc`; the secret
names in `src/index.ts` (`FORWARDED`); `INSTANCES` there and `max_instances` there, equal to each other; the
placement region, next to your database. Run migrations from CI over the database's direct port, never from the
container (`mistri migrate up`, `mistri migrate stores up`).
