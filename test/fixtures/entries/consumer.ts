/*
 * The package entry points as a consumer outside the tree would import them (scripts/boundary/entries.json): each
 * name through its workspace link under node_modules, read by the root `tsc --noEmit`: each exports something. test/repo/entries.test.ts
 * holds this file to the table, so a new entry is a line here.
 */
import * as mistriApp from '@mistriwork/mistri/app';
import * as mistriPage from '@mistriwork/mistri/page';
import * as mistriUi from '@mistriwork/mistri/ui';
import * as mistriUiTesting from '@mistriwork/mistri/ui/testing';
import * as mistriCommands from '@mistriwork/mistri/commands';
import * as mistriPolicy from '@mistriwork/mistri/policy';
import * as mistriJobs from '@mistriwork/mistri/jobs';
import * as mistriWorkflows from '@mistriwork/mistri/workflows';
import * as mistriHandler from '@mistriwork/mistri/handler';
import * as mistriReact from '@mistriwork/mistri/react';
import * as mistriReactNext from '@mistriwork/mistri/react/next';
import * as mistriReactReactRouter from '@mistriwork/mistri/react/react-router';
import * as mistriReactTanstackRouter from '@mistriwork/mistri/react/tanstack-router';
import * as mistriTesting from '@mistriwork/mistri/testing';
import * as mistriMaintenance from '@mistriwork/mistri/maintenance';
import * as mistriOpenfeature from '@mistriwork/mistri/openfeature';
import * as mistriIntegration from '@mistriwork/mistri/integration';
import * as engine from '@mistriwork/engine';
import * as kit from '@mistriwork/kit';
import * as ui from '@mistriwork/ui';
import * as cloudflare from '@mistriwork/cloudflare';

/** Compiles only when the module exports at least one value. */
const some = <A>(any: [A] extends [never] ? false : true) => any;

export const entries = {
  '@mistriwork/mistri/app': some<keyof typeof mistriApp>(true),
  '@mistriwork/mistri/page': some<keyof typeof mistriPage>(true),
  '@mistriwork/mistri/ui': some<keyof typeof mistriUi>(true),
  '@mistriwork/mistri/ui/testing': some<keyof typeof mistriUiTesting>(true),
  '@mistriwork/mistri/commands': some<keyof typeof mistriCommands>(true),
  '@mistriwork/mistri/policy': some<keyof typeof mistriPolicy>(true),
  '@mistriwork/mistri/jobs': some<keyof typeof mistriJobs>(true),
  '@mistriwork/mistri/workflows': some<keyof typeof mistriWorkflows>(true),
  '@mistriwork/mistri/handler': some<keyof typeof mistriHandler>(true),
  '@mistriwork/mistri/react': some<keyof typeof mistriReact>(true),
  '@mistriwork/mistri/react/next': some<keyof typeof mistriReactNext>(true),
  '@mistriwork/mistri/react/react-router': some<keyof typeof mistriReactReactRouter>(true),
  '@mistriwork/mistri/react/tanstack-router': some<keyof typeof mistriReactTanstackRouter>(true),
  '@mistriwork/mistri/testing': some<keyof typeof mistriTesting>(true),
  '@mistriwork/mistri/maintenance': some<keyof typeof mistriMaintenance>(true),
  '@mistriwork/mistri/openfeature': some<keyof typeof mistriOpenfeature>(true),
  '@mistriwork/mistri/integration': some<keyof typeof mistriIntegration>(true),
  '@mistriwork/engine': some<keyof typeof engine>(true),
  '@mistriwork/kit': some<keyof typeof kit>(true),
  '@mistriwork/ui': some<keyof typeof ui>(true),
  '@mistriwork/cloudflare': some<keyof typeof cloudflare>(true),
};
