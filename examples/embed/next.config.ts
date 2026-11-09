import type { NextConfig } from 'next';

export default {
  // The handler runs in Node from node_modules as it ships: it opens databases and loads the App's own modules.
  serverExternalPackages: ['@mistriwork/mistri'],
} satisfies NextConfig;
