/**
 * The bell in the App bar: how many of the signed-in person's notices are
 * unread, and a menu of the latest (InboxList.tsx, loaded the first time it
 * opens). Drawn only where the App keeps an inbox for this account — the
 * sign-in answer says so (`/api/whoami`'s `inbox`) — beside the account menu.
 *
 * The count is asked again every minute while the page is open and when
 * its tab comes back to the front: a notice is written by someone else's
 * write, so nothing on this page knows it happened. The number is the
 * trigger's accessible name as well as its badge, so a screen reader hears
 * "Notifications, 3 unread" where a sighted reader sees the 3. Nothing
 * moves or pulses when it changes (docs/design.md, motion rule 1).
 */
import { useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@mistriwork/kit/client/core.js';
import {
  captureTenantLease,
  sessionIdentity,
  subscribeSessionIdentity,
  subscribeTenantLease,
  tenantLeaseActive,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { DropMenu } from '@mistriwork/ui/DropMenu.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { INBOX_QUERY, unreadWord } from './inboxModel.js';
import './InboxBell.css';

/** How often the bell asks again while nothing else does. */
const EVERY = 60_000;

const InboxMenu = onDemand(() => import('./InboxList.js'), 'InboxMenu', { quiet: true });

export function InboxBell() {
  const [open, setOpen] = useState(false);
  /* A tenant's inbox is asked only through its open lease. The bar can draw
     before the lease is, and a question sent then is refused on this side
     unsent, which left the bell at nothing until the next minute's ask. */
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  const leaseSnapshot = () =>
    identity.tenantRequired && tenantLeaseActive(identity) ? (captureTenantLease(identity)?.tenantId ?? '') : '';
  const tenant = useSyncExternalStore(subscribeTenantLease, leaseSnapshot, leaseSnapshot);
  const count = useQuery({
    queryKey: [INBOX_QUERY, 'count', tenant],
    queryFn: async () => (await api('/api/inbox', { limit: 1 })) as { unread: number },
    enabled: !identity.tenantRequired || tenant !== '',
    refetchInterval: EVERY,
    staleTime: EVERY / 2,
  });
  const unread = count.data?.unread ?? 0;
  const name = unread ? `Notifications, ${unreadWord(unread)} unread` : 'Notifications';
  return (
    <DropMenu
      className="inbox-bell"
      triggerClassName="icon-button inbox-trigger"
      triggerTitle={name}
      triggerLabel={name}
      label={
        <>
          <Icon name="bell" />
          {unread > 0 && (
            <span className="inbox-count" aria-hidden="true">
              {unreadWord(unread)}
            </span>
          )}
        </>
      }
      popupClassName="more-list inbox-popup"
      open={open}
      onOpenChange={setOpen}
    >
      <InboxMenu onClose={() => setOpen(false)} />
    </DropMenu>
  );
}
