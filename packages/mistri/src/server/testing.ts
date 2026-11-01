/** Public server-side test toolkit: authored Apps and isolated HTTP services. Explicit names (not `export *`), so a helper added under testing/ is not public by accident. */
export { createTestWorkspace } from './testing/workspace.js';
export type { TestWorkspace } from './testing/workspace.js';
export { createTestClient, assertAuthorizationMatrix } from './testing/client.js';
export type { TestClient, TestRequest, AuthorizationCase } from './testing/client.js';
export type {
  TestResult,
  TestSuccess,
  TestRefusal,
  TestRecordKey,
  TestRow,
  TestPage,
  TestUpdateResult,
  TestCommandResult,
} from './testing/appRequests.js';
export { assertApplied, assertPermissions } from './testing/permissions.js';
export type { PermissionCase } from './testing/permissions.js';
export { startTestApp, startTestSuite } from './testing/host.js';
export type { TestHost, TestAppOptions, TestSuiteOptions, TestAssistantScript, TestDecisionScript, TestJobRun } from './testing/host.js';
export type { TestTenantAccount, TestTenantClient, TestTenantLease, TestSupportVisit } from './testing/tenant.js';
export { validateTestApp, createTestClock } from './testing/unit.js';
export { createWorkflowDriver } from './testing/workflows.js';
export { evaluateDecision } from './testing/decisions.js';
export type { EvaluateDecisionOptions } from './testing/decisions.js';
export type { DecisionEvaluation, ReliabilityBucket } from './decide/decisionEval.js';
export type { WorkflowDriverOptions } from './testing/workflows.js';
export { settled, watchRequests } from './testing/settled.js';
export type { SettledOptions, SettledPage } from './testing/settled.js';
export { roundTrips } from './testing/roundTrips.js';
export { defineService } from './virtualization/definition.js';
export type { ServiceDefinition, ServiceRoute, ServiceContext, VirtualReply, VirtualClock } from './virtualization/definition.js';
export { startService } from './virtualization/service.js';
export type { StartServiceOptions, ServiceJournalEntry, VirtualService } from './virtualization/service.js';
export type { RequestMatcher, BodyMatcher, ValueMatcher, VirtualRequest, RequestMatch } from './virtualization/matching.js';
