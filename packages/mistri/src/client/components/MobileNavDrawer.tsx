/** The App menu on a phone: the sidebar's own tree in a modal drawer. */
import { useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Sidebar } from '@mistriwork/kit/client/components/Sidebar.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { message, messageLanguage, subscribeMessages } from '@mistriwork/kit/client/messages.js';
import { openPalette } from '@mistriwork/kit/client/palette.js';
import { headerSearchShown } from '../publicVisitor.js';
import { say } from '@mistriwork/kit/client/copy/shell/components/MobileNavDrawer.js';

interface MobileNavDrawerProps {
  app: Partial<Pick<AppPayloadApp, 'name' | 'ui'>>;
}

export function MobileNavDrawer({ app }: MobileNavDrawerProps) {
  useSyncExternalStore(subscribeMessages, messageLanguage, messageLanguage);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="tn-mobile-menu"
        aria-expanded={open}
        aria-controls="mobile-app-navigation"
        onClick={() => setOpen(true)}
      >
        <Icon name="list" />
        <span>{message('navigation.menu')}</span>
      </button>
      {open ? <MobileDrawerContents app={app} onClose={() => setOpen(false)} finalFocus={trigger} /> : null}
    </>
  );
}

function MobileDrawerContents({
  app,
  onClose,
  finalFocus,
}: MobileNavDrawerProps & { onClose: () => void; finalFocus: RefObject<HTMLElement | null> }) {
  const [list, setList] = useState<HTMLUListElement | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const name = app.name ?? 'App';
  return (
    <Modal
      className="mobile-nav-drawer"
      onClose={onClose}
      initialFocus={close}
      finalFocus={finalFocus}
      fullscreen={false}
      ariaLabel={say('navigation', { name })}
    >
      <nav id="mobile-app-navigation" className="mobile-nav-sidebar sidebar" aria-label={say('menu', { name })}>
        <header className="mobile-nav-head">
          <strong>{name}</strong>
          <span className="mobile-nav-head-actions">
            {headerSearchShown(app.ui?.shell?.search) ? (
              <button
                type="button"
                className="mobile-nav-search"
                onClick={() => {
                  onClose();
                  queueMicrotask(openPalette);
                }}
              >
                {message('navigation.search')}
              </button>
            ) : null}
            <button ref={close} type="button" className="mobile-nav-close" aria-label={message('navigation.closeMenu')} onClick={onClose}>
              ×
            </button>
          </span>
        </header>
        <ul ref={setList} className="mobile-nav-list" />
        <div ref={setFooter} className="mobile-nav-footer" />
        {list ? createPortal(<Sidebar tabNavigation host={list} footerHost={footer} onSelect={onClose} />, list) : null}
      </nav>
    </Modal>
  );
}
