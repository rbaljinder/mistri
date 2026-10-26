/**
 * The form a headline's call to action opens over its record (`links: [{ to, open: 'modal' }]`): a public form from
 * the App's public forms route (FormDialog.tsx), or one of the App's own signed-in forms the reader is served, as its
 * room draws it (SignedInFormDialog.tsx). A view that is neither a form is its room, so the reader goes there.
 * Each is fetched the first time it is asked for, so a record page carries neither.
 */
import { useEffect } from 'react';
import { go, pageView } from '@mistriwork/kit/client/core.js';
import { pageBridge } from '@mistriwork/kit/client/uiBridge.js';
import { formAt, formPageId } from '@mistriwork/kit/client/components/appRooms.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';

const PublicDialog = onDemand(() => import('./FormDialog.js'), 'FormDialog', { quiet: true });
const SignedInDialog = onDemand(() => import('./SignedInFormDialog.js'), 'SignedInFormDialog', { quiet: true });

type Served = AppPayloadApp & { id?: string; name?: string; views?: Record<string, { command?: unknown }> };

export function ViewFormDialog({ view, prefill, onClose }: { view: string; prefill: string; onClose: () => void }) {
  const app = pageBridge.activeApp() as Served | null;
  const own = app?.views !== undefined && Object.hasOwn(app.views, view);
  const form = own && app!.views![view].command ? formAt(app as AppPayloadApp, formPageId(view)) : undefined;
  const room = own && !form;
  useEffect(() => {
    if (!room) return;
    onClose();
    go(pageView(formPageId(view)));
  }, [room, view, onClose]);
  if (!own) return <PublicDialog view={view} appId={app?.id} prefill={prefill} onClose={onClose} />;
  if (!form || form.error) return null;
  return <SignedInDialog form={form} appName={app?.name ?? ''} prefill={prefill} onClose={onClose} />;
}
