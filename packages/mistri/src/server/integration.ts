/**
 * Package entry for integration packages (`@mistriwork/mistri/integration`):
 * what a package that wraps a vendor needs to declare its integration, and
 * nothing of the server. An integration package imports this and its vendor's
 * SDK; core never imports a vendor SDK. The App lists the integration in its
 * jobs module (`integrations: { use: [fakepay()] }`) and its commands call it
 * from their lookups (docs: Integrations).
 */
export { defineIntegration, IntegrationDeclarationError } from './integrations/integrationModule.js';
export type {
  ChannelMessage,
  Integration,
  IntegrationActionDefinition,
  IntegrationChannelDefinition,
  IntegrationDefinition,
  IntegrationDelivery,
  IntegrationEvent,
  IntegrationEventDefinition,
  IntegrationRegistry,
} from './integrations/integrationModule.js';
/* A provider's answer that is final (a declined card, an unknown number): the command is refused with it, and a retry
   is answered the same without asking again. Anything else thrown is a failure that may pass, and is retried. */
export { refuse } from './commands/commandErrors.js';
/* The shapes an action's input and output and an event's payload are written with. */
export { bool, date, id, int, list, literal, nullable, number, oneOf, optional, shape, text } from './commands/commandShapes.js';
export type { Shape, ShapeOf } from './commands/commandShapes.js';
