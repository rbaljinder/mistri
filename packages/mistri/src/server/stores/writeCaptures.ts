/**
 * The App framework's capture beneath the engine adapters' writes
 * (../writeCapture.ts): a bound table's record history and the notices a
 * write sends, each appended on the write's own writer by the store of that
 * dialect, and live sync's one change row per transaction around them both
 * (live/liveChange.ts), so it sees each write as it finally landed.
 *
 * Installed when this module loads, and the bindings are made through it:
 * whatever binds a table to a history or to notices has imported this file,
 * so no binding exists without the capture that honours it.
 */
import { installWriteCapture, type CaptureSource } from '@mistriwork/engine/adapters/writeCapture.js';
import { captureRecordHistory, capturesWrites, type RecordHistorySink } from '../../adapters/history/recordHistory.js';
import { appendPostgresRecordChange } from '../../adapters/history/postgresRecordHistory.js';
import { appendSqliteRecordChange } from '../../adapters/history/sqliteRecordHistory.js';
import { appendMysqlRecordChange } from '../../adapters/history/mysqlRecordHistory.js';
import { appendPostgresNotice } from '../../adapters/inbox/postgresInbox.js';
import { appendSqliteNotice } from '../../adapters/inbox/sqliteInbox.js';
import { appendMysqlNotice } from '../../adapters/inbox/mysqlInbox.js';
import { queuePostgresChannelNotice, queueSqliteChannelNotice } from '../../adapters/integrations/integrationStore.js';
import { captureLiveChanges, capturesLiveChanges, type LiveChangeCapture, type LiveChangeSink } from '../../adapters/live/liveChange.js';
import { appendPostgresLiveChange } from '../../adapters/live/postgresLiveChange.js';
import { appendSqliteLiveChange } from '../../adapters/live/sqliteLiveChange.js';
import { appendMysqlLiveChange } from '../../adapters/live/mysqlLiveChange.js';

export { bindRecordHistory } from '../../adapters/history/recordHistory.js';
export { bindNotices } from '../../adapters/inbox/inbox.js';
export { bindLiveChanges } from '../../adapters/live/liveChange.js';

/** The capture's sink: the adapter's reads on its writer, and this dialect's appends on the same writer. */
function sinkOf(source: CaptureSource): RecordHistorySink {
  const { read, rows, writer } = source;
  switch (writer.dialect) {
    case 'postgres':
      return {
        read,
        rows,
        append: (row) => appendPostgresRecordChange(writer.client, row),
        notify: (row) => appendPostgresNotice(writer.client, row),
        message: (row) => queuePostgresChannelNotice(writer.client, row),
      };
    case 'sqlite':
      return {
        read,
        rows,
        append: async (row) => appendSqliteRecordChange(writer.db, row),
        notify: async (row) => appendSqliteNotice(writer.db, row),
        message: async (row) => queueSqliteChannelNotice(writer.db, row),
      };
    case 'mysql':
      // No channel queue on MySQL: a notice's channel message is not kept there.
      return {
        read,
        rows,
        append: (row) => appendMysqlRecordChange(writer.connection, writer.database, row),
        notify: (row) => appendMysqlNotice(writer.connection, writer.database, row),
      };
  }
}

/** The live change row's sink: the adapter's read on its writer, and this dialect's append on the same writer. */
function liveSinkOf(source: CaptureSource): LiveChangeSink {
  const { read, writer } = source;
  switch (writer.dialect) {
    case 'postgres':
      return { read, append: (row) => appendPostgresLiveChange(writer.client, row) };
    case 'sqlite':
      return { read, append: async (row) => appendSqliteLiveChange(writer.db, row) };
    case 'mysql':
      return { read, append: (row) => appendMysqlLiveChange(writer.connection, writer.database, row) };
  }
}

type HistoryCapture = NonNullable<ReturnType<typeof captureRecordHistory>>;

/* Live sync wraps the history capture, so the row it writes names each write as it finally landed. */
function composed(history: HistoryCapture | undefined, live: LiveChangeCapture | undefined) {
  if (!live) return history;
  if (!history)
    return {
      insert: live.insert,
      update: live.update,
      remove: live.remove,
      tell: async () => {},
      finish: live.finish,
      committed: live.committed,
    };
  return {
    insert: ((request, write) => live.insert(request, (inner) => history.insert(inner, write))) as HistoryCapture['insert'],
    update: ((request, write) => live.update(request, (inner) => history.update(inner, write))) as HistoryCapture['update'],
    remove: ((request, write) => live.remove(request, (inner) => history.remove(inner, write))) as HistoryCapture['remove'],
    tell: (request: Parameters<HistoryCapture['tell']>[0]) => history.tell(request),
    finish: live.finish,
    committed: live.committed,
  };
}

installWriteCapture({
  captures: (adapter, table) => capturesWrites(adapter, table) || capturesLiveChanges(adapter, table),
  begin: (adapter, source) => composed(captureRecordHistory(adapter, sinkOf(source)), captureLiveChanges(adapter, liveSinkOf(source))),
});
