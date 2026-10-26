/**
 * The signed-in person's notices: the bell's menu of the latest, and the
 * room that lists them all (`/{app}/notifications`). Loaded the first time
 * either is opened (onDemand), so an App's first page carries the bell alone.
 *
 * The server answers for this reader (server/inbox.ts): only their own
 * notices, only those whose record they can still read, and the words only
 * where they may read every column those were filled from. This module says
 * what it was handed. Opening a notice marks it read and opens its record;
 * "Mark all read" is the reader's own notices, all of them.
 */
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api, go, rowView } from '@mistriwork/kit/client/core.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { inboxEntry } from '../publicAddress.js';
import { Button } from '@mistriwork/ui/Button.js';
import { useCrumbSlots } from '@mistriwork/kit/client/components/crumbSlot.js';
import { DropItem } from '@mistriwork/ui/DropMenu.js';
import { INBOX_QUERY, unreadWord } from './inboxModel.js';
import { Empty, Problem } from '@mistriwork/kit/client/components/Notes.js';
import './Inbox.css';
import { say } from '../copy/shell/components/InboxList.js';

export interface InboxNotice {
  id: number;
  at: string;
  title: string;
  resource: string;
  key: Record<string, string | number>;
  by?: string;
  action?: string;
  read: boolean;
}
interface InboxPage {
  notices: InboxNotice[];
  unread: number;
  more?: number;
  email?: boolean;
}

/** How many the bell's menu shows: the latest, read or not. */
const MENU_SIZE = 8;
/** A page of the room. */
const PAGE_SIZE = 30;

const when = (at: string): string => {
  const moment = new Date(at);
  return Number.isNaN(moment.getTime()) ? at : formatDateTime(moment);
};

/** Mark notices read (these ids, or every one), then let every inbox read ask again. */
function useMarkRead() {
  const client = useQueryClient();
  return async (which: { ids: number[] } | { all: true }) => {
    try {
      await api('/api/inbox/read', which);
    } finally {
      await client.invalidateQueries({ queryKey: [INBOX_QUERY] });
    }
  };
}

/** Open a notice's record, read now. A mark that fails still opens the record: the notice stays unread, which is true. */
function useOpenNotice() {
  const mark = useMarkRead();
  return (notice: InboxNotice) => {
    if (!notice.read) void mark({ ids: [notice.id] }).catch(() => {});
    go(rowView(notice.resource, notice.key, Object.values(notice.key).join(' · ')), 'reset');
  };
}

/** One notice's words: what happened, then who and when, quieter. */
function NoticeText({ notice }: { notice: InboxNotice }) {
  return (
    <>
      <span className="inbox-dot" aria-hidden="true" />
      <span className="inbox-text">
        {!notice.read && <span className="visually-hidden">{say('unread')} </span>}
        <span className="inbox-title">{notice.title}</span>
        <span className="inbox-meta">
          {notice.by ? `${notice.by} · ` : ''}
          <time dateTime={notice.at}>{when(notice.at)}</time>
        </span>
      </span>
    </>
  );
}

/** The bell's menu: the latest notices as items, Mark all read, and the way to the room. */
export function InboxMenu({ onClose }: { onClose: () => void }) {
  const latest = useQuery({
    queryKey: [INBOX_QUERY, 'menu'],
    queryFn: async () => (await api('/api/inbox', { limit: MENU_SIZE })) as InboxPage,
    staleTime: 0,
  });
  const open = useOpenNotice();
  const mark = useMarkRead();
  const notices = latest.data?.notices ?? [];
  const unread = latest.data?.unread ?? 0;
  return (
    <div className="inbox-menu">
      <div className="inbox-menu-head">
        <span className="inbox-menu-title">{say('notifications')}</span>
        {unread > 0 && (
          <DropItem className="inbox-menu-mark" closeOnClick={false} onClick={() => void mark({ all: true })}>
            {say('markAllRead')}
          </DropItem>
        )}
      </div>
      {latest.isPending ? (
        <p className="inbox-menu-note" role="status">
          {say('common.loading')}
        </p>
      ) : latest.isError ? (
        <p className="inbox-menu-note" role="alert">
          {(latest.error as Error).message}
        </p>
      ) : !notices.length ? (
        <p className="inbox-menu-note">{say('nothingYetWhenSomeone')}</p>
      ) : (
        notices.map((notice) => (
          <DropItem
            key={notice.id}
            className={`inbox-item${notice.read ? '' : ' unread'}`}
            onClick={() => {
              onClose();
              open(notice);
            }}
          >
            <NoticeText notice={notice} />
          </DropItem>
        ))
      )}
      <DropItem
        className="inbox-menu-all"
        onClick={() => {
          onClose();
          go(inboxEntry() as never, 'reset');
        }}
      >
        {say('seeAllNotifications')}
      </DropItem>
    </div>
  );
}

/** Whether this reader's notices are emailed too: shown only in an App that emails them (the reply says). */
function EmailChoice({ on }: { on: boolean }) {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState('');
  const change = async (email: boolean) => {
    setSaving(true);
    setFailed('');
    try {
      await api('/api/inbox/email', { email });
    } catch (error) {
      setFailed((error as Error).message);
    } finally {
      setSaving(false);
      await client.invalidateQueries({ queryKey: [INBOX_QUERY] });
    }
  };
  return (
    <div className="inbox-email">
      <label>
        <input type="checkbox" checked={on} disabled={saving} onChange={(event) => void change(event.target.checked)} />{' '}
        {say('emailMeTheseToo')}
      </label>
      {failed && (
        <span role="alert" className="inbox-email-note">
          {failed}
        </span>
      )}
    </div>
  );
}

/** The room: every notice, newest first, All or Unread, a page at a time. */
export function InboxRoom() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const pages = useInfiniteQuery({
    queryKey: [INBOX_QUERY, 'room', unreadOnly],
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam }) =>
      (await api('/api/inbox', {
        limit: PAGE_SIZE,
        ...(unreadOnly ? { unread: true } : {}),
        ...(pageParam === undefined ? {} : { before: pageParam }),
      })) as InboxPage,
    getNextPageParam: (last: InboxPage) => last.more,
    staleTime: 0,
  });
  const open = useOpenNotice();
  const mark = useMarkRead();
  const [marking, setMarking] = useState(false);
  const notices = pages.data?.pages.flatMap((page) => page.notices) ?? [];
  const unread = pages.data?.pages[0]?.unread ?? 0;
  const markAll = async () => {
    setMarking(true);
    try {
      await mark({ all: true });
    } finally {
      setMarking(false);
    }
  };
  /* The room names itself in the crumb bar, as a list does (docs/design.md):
     its title and count after the trail, Mark all read at the bar's end. */
  const crumbs = useCrumbSlots();
  const title = (
    <>
      <h1 className="applist-title" id="inbox-room-title">
        {say('notifications')}
      </h1>
      {unread > 0 && <span className="applist-count">{say('unreadCount', { count: unreadWord(unread) })}</span>}
    </>
  );
  const markAllButton =
    unread > 0 ? (
      <Button intent="quiet" size="compact" busy={marking} busyLabel={say('marking')} onClick={() => void markAll()}>
        {say('markAllRead')}
      </Button>
    ) : null;
  return (
    <section className="inbox-room" aria-labelledby="inbox-room-title">
      {crumbs.note ? (
        <>
          {createPortal(title, crumbs.note)}
          {crumbs.tools && markAllButton && createPortal(markAllButton, crumbs.tools)}
        </>
      ) : (
        <div className="inbox-room-head">
          {title}
          {markAllButton}
        </div>
      )}
      <div className="tabs" data-scrolls="" role="tablist" aria-label={say('whichNotifications')}>
        <button type="button" role="tab" className="tab" aria-selected={!unreadOnly} onClick={() => setUnreadOnly(false)}>
          <span>{say('common.all')}</span>
        </button>
        <button type="button" role="tab" className="tab" aria-selected={unreadOnly} onClick={() => setUnreadOnly(true)}>
          <span>{say('unreadTab')}</span>
        </button>
      </div>
      {typeof pages.data?.pages[0]?.email === 'boolean' && <EmailChoice on={pages.data.pages[0].email} />}
      {pages.isPending ? (
        <p className="loading" role="status">
          {say('common.loading')}
        </p>
      ) : pages.isError ? (
        <Problem text={(pages.error as Error).message} />
      ) : !notices.length ? (
        <Empty
          text={unreadOnly ? say('nothingUnread') : say('noNotificationsYet')}
          detail={unreadOnly ? undefined : say('whenSomeoneRepliesToYouAssigns')}
        />
      ) : (
        <ol className="inbox-list">
          {notices.map((notice) => (
            <li key={notice.id} className={`inbox-row${notice.read ? '' : ' unread'}`}>
              <button type="button" className="inbox-open" onClick={() => open(notice)}>
                <NoticeText notice={notice} />
              </button>
              {!notice.read && (
                <Button intent="quiet" size="compact" className="inbox-mark" onClick={() => void mark({ ids: [notice.id] })}>
                  {say('markRead')}
                  <span className="visually-hidden">: {notice.title}</span>
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      {pages.hasNextPage && (
        <div className="inbox-more">
          <Button
            intent="secondary"
            size="compact"
            busy={pages.isFetchingNextPage}
            busyLabel={say('common.loading')}
            onClick={() => void pages.fetchNextPage()}
          >
            {say('showOlder')}
          </Button>
        </div>
      )}
    </section>
  );
}
