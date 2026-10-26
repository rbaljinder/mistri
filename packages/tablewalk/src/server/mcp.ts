/**
 * tablewalk as an MCP server: the database, offered to a coding agent.
 *
 * During development an agent guesses at schema from ORM models and migration
 * files; the actual foreign-key graph — both directions — is exactly what it
 * lacks and exactly what tablewalk already computes. The server is a thin
 * protocol layer over machinery that all exists: introspection, the query
 * language, the reference counts, the shape analysis, the recorded writes.
 * Nothing under mcp/ talks to a database directly.
 *
 * Reading is the default. The write tools are listed only when a connection
 * is marked writable, and they go through the same recorded operations as
 * the browser's edits. Every answer is bounded by the same clamp the HTTP
 * API uses, because an agent that asks for everything should get a page and
 * a total, not everything.
 *
 * This file is the entry point the rest of the server imports. The parts:
 *   mcp/protocol.ts  the stdio loop and the method dispatch
 *   mcp/registry.ts  which tools exist and are offered, and runTool
 *   mcp/tools/*.ts   the tools, one file per family
 *   mcp/shelf.ts     resources: the schema brief, table briefs, the team's shelf
 *   mcp/prompts.ts   the packaged walks
 *   mcp/toolkit.ts   what the families share
 */
export { serveMcp } from './mcp/protocol.js';
export { agentTools, runTool, setAdvertiseOutputSchema, setToolProfile, toolCounts, toolNames } from './mcp/registry.js';
export { setElicitor } from './mcp/tools/write.js';
export { findValue } from './mcp/tools/schema.js';
