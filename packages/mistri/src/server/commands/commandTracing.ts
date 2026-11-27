/**
 * OpenTelemetry span wrapper for business command execution.
 *
 * Emits the command's id, version, outcome, and refusal code as attributes
 * while keeping inputs, outputs, and recorded refusal reasons local to the
 * dev observer (`span.detail`).
 */
import { errorCode, inSpan, tracing } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { refusalReasons } from '@mistriwork/engine/shared/refusal.js';
import { isBusinessCommandExecutionError } from './commandErrors.js';

export async function observeCommandExecution<
  T extends { status: string; replayed?: boolean; resource?: string; result?: unknown; receiptId?: string; key?: unknown },
>(rawRequest: unknown, statusOnly: boolean, run: () => Promise<T>): Promise<T> {
  if (!tracing()) return run();
  const envelope =
    rawRequest && typeof rawRequest === 'object' ? (rawRequest as { command?: unknown; commandVersion?: unknown; input?: unknown }) : {};
  const id = typeof envelope.command === 'string' && /^[A-Za-z][\w.-]{0,63}$/.test(envelope.command) ? envelope.command : undefined;
  return inSpan(
    statusOnly ? `command status ${id ?? ''}`.trim() : `command ${id ?? ''}`.trim(),
    {
      attributes: {
        'mistri.command.id': id,
        'mistri.command.version': typeof envelope.commandVersion === 'number' ? envelope.commandVersion : undefined,
        ...(statusOnly ? { 'mistri.command.status_only': true } : {}),
      },
    },
    async (span) => {
      span.detail(() => {
        const { input, ...rest } = envelope as Record<string, unknown>;
        return { input, envelope: rest };
      });
      try {
        const result = await run();
        span.setAttributes({
          'mistri.command.outcome': result.status === 'applied' ? (result.replayed ? 'replayed' : 'applied') : result.status,
          'mistri.command.target': result.resource,
        });
        span.detail(() => ({ output: result.result, receiptId: result.receiptId, key: result.key }));
        return result;
      } catch (error) {
        if (isBusinessCommandExecutionError(error)) {
          span.setAttributes({ 'mistri.command.outcome': error.outcome, 'mistri.refusal.code': error.code });
          span.detail(() => ({
            refusal: {
              code: error.code,
              message: error.message,
              ...(error.field ? { field: error.field } : {}),
              ...(error.reason ? { reason: error.reason } : {}),
            },
            because: refusalReasons(error),
          }));
        }
        throw error;
      }
    },
    errorCode,
  );
}
