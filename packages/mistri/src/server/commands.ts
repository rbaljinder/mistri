/** Server-only package entry. Never import this module into an App manifest. */
export { defineCommand, defineCommands, BusinessCommandDefinitionError } from './commands/businessCommands.js';
export type {
  BusinessCommand,
  BusinessCommandActor,
  BusinessCommandContext,
  BusinessCommandInitialContext,
  BusinessCommandAvailabilityContext,
  BusinessCommandRegistry,
  BusinessCommandLookupContext,
  BusinessCommandValidationContext,
  CommandDefinition,
  CommandFile,
  StandardSchema,
} from './commands/businessCommands.js';
/* A command's input: `field.*` writes each field, the declaration is fields
   keyed by name, and the value it parses to is what a handler or a `validate`
   written apart from its defineCommand reads. The server sends the browser the
   parsed declaration with the App, which names the command and never imports it. */
export { field } from './commands/commandFields.js';
export type { CommandInput, CommandInputOf } from '../shared/command.js';
/* A refusal: the handler's one way to say no, typed `never`. */
export { refuse } from './commands/commandErrors.js';
export type { RefusalCode } from './commands/commandErrors.js';
/* The typed source a command names, and the `db` its handler reads and
   writes through: a row type, a read-only view of some tables for a helper,
   and the table and query shapes. */
export { defineSource } from './commands/commandDb.js';
export type { CommandDb, CommandSource, Query, ReadTable, RowOf, Where, WriteTable } from './commands/commandDb.js';
/* A free-form page's loader (@mistriwork/mistri/page): server code that reads for the
   page as the reader, read-only and bounded, exported beside the commands as
   `export const loaders = defineLoaders({ … })`. */
export { defineLoader, defineLoaders } from './commands/pageLoaders.js';
export type { PageLoader, PageLoaderContext, PageLoaderViewer } from './commands/pageLoaders.js';
/* The human check a public door asks (`auth.challenge`): a provider pack's verifier, exported beside the commands as
   `export const challenges = defineChallenges({ … })`. Core ships the seam only. */
export { defineChallenges } from './commands/challenges.js';
export type { ChallengeRequest, HumanCheck } from './commands/challenges.js';
/* The shapes `output` is written with. */
export { bool, date, id, int, list, literal, nullable, number, oneOf, optional, shape, text } from './commands/commandShapes.js';
export type { Shape, ShapeOf } from './commands/commandShapes.js';
/* A public form's receipt: random, opaque, never a key or a counter. */
export { publicReference, publicReferencePattern } from './forms/publicReference.js';
/* A command's committed facts: the typed event it declares under `events`,
   and the projection of its validated output into that event's payload. The
   jobs module (`@mistriwork/mistri/jobs`) subscribes to them. */
export { defineEvent, defineEventProjection } from './commands/businessEvents.js';
export type { BusinessEvent, BusinessEventProjection } from './commands/businessEvents.js';
/* Beyond the command's own database: `lookup` reads the App's other sources
   before the transaction opens, through read-only handles, and `effects`
   post the validated output to a webhook after it commits. */
export { post } from './commands/commandEffects.js';
export type { CommandEffect, EffectPayload, PostOptions } from './commands/commandEffects.js';
/* A message on an integration's channel, after commit: consent, opt-out and quiet hours are core's. */
export { send } from './commands/commandEffects.js';
export type { ChannelMessageProjection } from './commands/commandEffects.js';
export type { LookupSources, LookupTable } from './commands/commandLookup.js';
/* The one-time steps a deployment runs on its stopped database — migrating the command journal, the
   PostgreSQL authentication store, the tenant stores and the support audit, and verifying the audit — are
   in `@mistriwork/mistri/maintenance`, beside `provisionStores`; this entry is what an App's server code imports. The
   binding they take is the App id, the source name and its connection id, and the policy's `storeId`. */
export type { TenantStoreBinding } from './tenant/tenantStoreContract.js';

/** Committed-event metrics, declared beside the command registry. @preview */
export { defineExperimentConversion } from './experiments/declarations.js';
export type { ExperimentConversion } from './experiments/declarations.js';
