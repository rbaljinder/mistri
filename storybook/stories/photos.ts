/* A generated photo (npm run photos) as a path on this server. A card draws
   only https or a same-server path, and a built Storybook lives under
   /storybook/, so the path is resolved against the page, not written as /photos. */
export const photo = (name: string) => new URL(`photos/${name}.png`, document.baseURI).pathname;
