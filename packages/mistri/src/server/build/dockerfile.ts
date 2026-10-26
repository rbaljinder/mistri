/**
 * `mistri build --dockerfile`: the Dockerfile that builds and runs one App.
 *
 * The build command is what an App's image is made of — typecheck, validation,
 * a bundle pinned to the mistri that made it — so the image is written from
 * the same request, not from a second description of the App that could drift
 * from it. Nothing is built here: the Dockerfile runs `mistri build` in its
 * own build stage, from the project root as the build context, so the file
 * names paths the way the command line did (relative to where it ran).
 *
 * The conventions are the repository Dockerfile's: the pinned node:24 alpine,
 * tini as PID 1, uid 1000, loopback never assumed (--host 0.0.0.0), the port
 * from PORT (the platform's, else 4111) and a health check on /healthz that
 * opens no database. A published App base image was the other option; it would
 * have to carry a mistri version the App's own package.json also pins, and
 * the build refuses to run under any other one.
 */
import { basename, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { BUILD_ENTRY_KINDS } from '../app/appBuild.js';

/** What the Dockerfile is written from: the build's own request. */
interface DockerfileRequest {
  app: string;
  appEntry?: string;
  out?: string;
  config?: string;
  commands?: string;
  jobs?: string;
  policy?: string;
}

/* Kept in step with the repository Dockerfile's NODE_IMAGE: an exact patch, so a rebuild is the image that was tested. */
const NODE_IMAGE = 'node:24.22.1-alpine3.24';

/** A path inside the build context, in the form a Dockerfile COPY reads; refused when it climbs out of the current directory. */
function contextPath(flag: string, value: string, root = false): string {
  const near = relative(process.cwd(), resolve(value));
  if (root && !near) return '.';
  if (!near || near.startsWith('..') || isAbsolute(near))
    throw new Error(`${flag} ${value} is not inside the current directory, which is the Docker build context.`);
  return near.split(sep).join('/');
}

/** Shell-word quoting for the RUN line. */
const shellWord = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

/** The Dockerfile for `request`, run from the project root (the directory holding package.json and package-lock.json). */
export function appDockerfile(request: DockerfileRequest): string {
  const given = contextPath('--app', request.app, true);
  /* An App that is the project root is copied into a folder of its own in the image, `app`, since a build may not
   * land inside the App it builds; every path the command line gave is then that folder's. */
  const atRoot = given === '.';
  const name = atRoot ? basename(process.cwd()) : basename(given);
  const app = atRoot ? 'app' : given;
  const inImage = (path: string) => (atRoot ? `${app}/${path}` : path);
  /* A fixed place in the image, whatever --out was on the command line: nothing outside the image reads it. */
  const built = `build/${name}`;
  const entries = BUILD_ENTRY_KINDS.filter((kind) => request[kind] !== undefined);
  const buildFlags = [
    `--app ${shellWord(app)}`,
    ...(request.appEntry ? [`--app-entry ${shellWord(inImage(contextPath('--app-entry', request.appEntry)))}`] : []),
    `--out ${built}`,
    ...entries.map((kind) => `--${kind} ${shellWord(inImage(contextPath(`--${kind}`, request[kind]!)))}`),
  ];
  const config = request.config ? contextPath('--config', request.config) : undefined;
  const serveFlags = [
    '"--host", "0.0.0.0"',
    ...(config ? ['"--config", "/config/mistri.json"'] : []),
    `"--app", "${built}"`,
    ...entries.map((kind) => `"--${kind}", "${built}/server/${kind}.mjs"`),
  ];
  return `# syntax=docker/dockerfile:1
#
# ${name}, built and served by mistri. Written by \`mistri build --dockerfile\`; run \`docker build\` from the
# project root (the directory holding package.json and package-lock.json), which is the build context.
#
# The build stage has no database, so it does not take --config: also run \`mistri build --config …\` against a
# staging database in CI, where the types and the database check can run. Every secret in the config stays a
# \${NAME} and is read from the environment at start; nothing in the image names a password.

ARG NODE_IMAGE=${NODE_IMAGE}

FROM \${NODE_IMAGE} AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
${
  atRoot
    ? `# The App is the project root: keep node_modules, build output and local databases out of the context with a
# .dockerignore, or they are copied in over what npm ci installed.
COPY . ./${app}`
    : `COPY ${app} ./${app}`
}
${[...new Set(entries.map((kind) => posix.dirname(contextPath(`--${kind}`, request[kind]!))))]
  .filter((dir) => !atRoot && dir !== '.' && dir !== app && !dir.startsWith(`${app}/`))
  .map((dir) => `COPY ${dir} ./${dir}\n`)
  .join('')}RUN npx @mistriwork/mistri build ${buildFlags.join(' ')}
RUN npm prune --omit=dev

FROM \${NODE_IMAGE} AS runtime
# tini is PID 1 so SIGTERM reaches the server, which drains and closes its stores before it exits.
RUN apk add --no-cache tini
WORKDIR /srv
ENV NODE_ENV=production
# The platform's PORT wins; mistri reads it when no --port is given.
ENV PORT=4111
COPY --from=build /srv/package.json ./
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/build ./build
${config ? `COPY ${config} /config/mistri.json\n` : ''}# The node image's unprivileged user (uid 1000).
USER node
EXPOSE 4111

# Loopback on purpose: this tests the process, not the port mapping. /healthz is liveness only and opens no
# database (packages/engine/src/server/http/probes.ts); it moves under MISTRI_BASE_PATH.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4111)+(process.env.MISTRI_BASE_PATH||'')+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "node_modules/.bin/mistri"]
CMD [${serveFlags.join(', ')}]
`;
}
