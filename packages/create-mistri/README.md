<img src="mark.svg" alt="mistri" width="48" height="48" />

# create-mistri

Starts a [mistri](https://mistriwork.dev) App: `npm create mistri@next my-app` is `mistri new my-app`, run by the
`@mistriwork/mistri` this package depends on, at its own version. Arguments go to `mistri new` as they are typed; npm
wants `--` before a flag:

```bash
npm create mistri@next                             # a starter App
npm create mistri@next my-app -- --brief BRIEF.md  # an App drafted from a brief
```

Until 1.0.0 ships, npm's `latest` tag is a placeholder: `@next` is the release candidate.

Node 24 or newer. The App framework, its command and its reference are in
[`@mistriwork/mistri`](https://www.npmjs.com/package/@mistriwork/mistri).
