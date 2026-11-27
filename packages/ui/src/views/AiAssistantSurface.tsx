/** First-class AI assistant presentation surfaces (sidebar, floating, fullscreen, page, inline) over UI SDK primitives. */
'use client';

import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
} from 'react';
import { Drawer, type DrawerSide } from '../Drawer.js';
import { Icon } from '../Icon.js';
import { ComponentStyleScope } from '../internal/ComponentStyleScope.js';
import { cx } from '../internal/cx.js';
import { viewportBox, viewportScale, viewportSize } from '../internal/ruler.js';
import { IconButton } from '../primitives/actions.js';
import { Tooltip } from '../Tooltip.js';
import { Resizable } from '../Resizable.js';
import type { AiPresentationMode } from './AiProposalAndChip.js';

/** Corner position when `AiAssistantSurface` is in `floating` mode. */
export type AiFloatingPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** Localized strings for `AiModeSwitcher` and `AiAssistantSurface`. */
export interface AiSurfaceWords {
  sidebar?: string;
  floating?: string;
  fullscreen?: string;
  exitFullscreen?: string;
  openPage?: string;
  close?: string;
  resize?: string;
  rail?: string;
  main?: string;
}

const DEFAULT_SURFACE_WORDS: Required<AiSurfaceWords> = {
  sidebar: 'Dock as sidebar',
  floating: 'Floating window',
  fullscreen: 'Full screen',
  exitFullscreen: 'Exit full screen',
  openPage: 'Open full page',
  close: 'Close assistant',
  resize: 'Resize assistant',
  rail: 'Conversations',
  main: 'Conversation',
};

const DEFAULT_PRESENTATIONS: ReadonlyArray<Exclude<AiPresentationMode, 'inline' | 'page'>> = ['sidebar', 'floating', 'fullscreen'];

const SIDEBAR_WIDTH_DEFAULT = 512;
const SIDEBAR_WIDTH_MIN = 384;
const SIDEBAR_WIDTH_MAX = 832;
const FLOATING_WIDTH_DEFAULT = 448;
const FLOATING_HEIGHT_DEFAULT = 608;
const FLOATING_WIDTH_MIN = 360;
const FLOATING_HEIGHT_MIN = 380;

function sidebarCeiling(maxWidth: number): number {
  const vw = viewportSize().width;
  return vw > 0 ? Math.max(SIDEBAR_WIDTH_MIN, Math.min(maxWidth, Math.floor(vw * 0.75))) : maxWidth;
}

function clampSidebarWidth(px: number, minWidth: number, maxWidth: number): number {
  return Math.round(Math.min(sidebarCeiling(maxWidth), Math.max(minWidth, px)));
}

function usePhoneViewport(): boolean {
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 640px)');
    const changed = () => setIsPhone(query.matches);
    query.addEventListener?.('change', changed);
    return () => query.removeEventListener?.('change', changed);
  }, []);
  return isPhone;
}

/* ============================================================================
 * 1. AiModeSwitcher
 * ========================================================================== */

/** Props for `AiModeSwitcher` presentation toggle buttons. */
export interface AiModeSwitcherProps {
  /** Active presentation mode. */
  presentation: AiPresentationMode;
  /** Modes offered as interactive toggles. Defaults to `['sidebar', 'floating', 'fullscreen']`. */
  presentations?: ReadonlyArray<Exclude<AiPresentationMode, 'inline' | 'page'>>;
  /** Called when the reader selects a mode. */
  onPresentationChange?: (mode: Exclude<AiPresentationMode, 'inline' | 'page'>) => void;
  /** Previous non-fullscreen mode so clicking Full screen again steps back to it. */
  restoreMode?: 'sidebar' | 'floating';
  /** Optional handler to jump to a dedicated full-page route (`placement: 'page'`). */
  onOpenPage?: () => void;
  /** Localized labels overriding English defaults. */
  words?: AiSurfaceWords;
  className?: string;
}

/** Compact mode-switcher controls (sidebar / floating / full screen / full page) over `@mistriwork/ui` IconButton + Tooltip. */
export function AiModeSwitcher({
  presentation,
  presentations = DEFAULT_PRESENTATIONS,
  onPresentationChange,
  restoreMode = 'sidebar',
  onOpenPage,
  words: givenWords,
  className,
}: AiModeSwitcherProps) {
  const words = { ...DEFAULT_SURFACE_WORDS, ...givenWords };
  if (presentations.length <= 1 && !onOpenPage) return null;

  return (
    <div data-slot="ai-mode-switcher" role="group" aria-label="Assistant layout" className={cx('nx-ai-mode-switcher', className)}>
      {presentations.includes('sidebar') ? (
        <Tooltip
          trigger={
            <IconButton
              variant="ghost"
              size="xs"
              ariaLabel={words.sidebar}
              aria-pressed={presentation === 'sidebar'}
              className="nx-ai-mode-btn"
              icon={<Icon name="sidebar-simple" size={14} />}
              onClick={() => onPresentationChange?.('sidebar')}
            />
          }
        >
          {words.sidebar}
        </Tooltip>
      ) : null}

      {presentations.includes('floating') ? (
        <Tooltip
          trigger={
            <IconButton
              variant="ghost"
              size="xs"
              ariaLabel={words.floating}
              aria-pressed={presentation === 'floating'}
              className="nx-ai-mode-btn"
              icon={<Icon name="squares-four" size={14} />}
              onClick={() => onPresentationChange?.('floating')}
            />
          }
        >
          {words.floating}
        </Tooltip>
      ) : null}

      {presentations.includes('fullscreen') ? (
        <Tooltip
          trigger={
            <IconButton
              variant="ghost"
              size="xs"
              ariaLabel={words.fullscreen}
              aria-pressed={presentation === 'fullscreen'}
              className="nx-ai-mode-btn nx-ai-mode-fullscreen"
              icon={<Icon name="arrows-out-simple" size={14} />}
              onClick={() => onPresentationChange?.(presentation === 'fullscreen' ? restoreMode : 'fullscreen')}
            />
          }
        >
          {presentation === 'fullscreen' ? words.exitFullscreen : words.fullscreen}
        </Tooltip>
      ) : null}

      {onOpenPage && presentation !== 'page' ? (
        <>
          {presentations.length > 0 ? <span className="nx-ai-mode-sep" aria-hidden="true" /> : null}
          <Tooltip
            trigger={
              <IconButton
                variant="ghost"
                size="xs"
                ariaLabel={words.openPage}
                className="nx-ai-mode-btn"
                icon={<Icon name="arrow-up-right" size={14} />}
                onClick={onOpenPage}
              />
            }
          >
            {words.openPage}
          </Tooltip>
        </>
      ) : null}
    </div>
  );
}

/* ============================================================================
 * 2. AiAssistantSurface
 * ========================================================================== */

/** Props for the `AiAssistantSurface` multi-mode presentation shell. */
export interface AiAssistantSurfaceProps {
  /** Whether the surface is open (ignored in `inline` and `page` modes). */
  open?: boolean;
  /** Called when the surface requests to open or close. */
  onOpenChange?: (open: boolean) => void;
  /** Controlled presentation mode. */
  presentation?: AiPresentationMode;
  /** Uncontrolled initial presentation mode. Defaults to `'sidebar'`. */
  defaultPresentation?: AiPresentationMode;
  /** Called when the presentation changes (e.g. Escape stepping down from fullscreen). */
  onPresentationChange?: (mode: AiPresentationMode) => void;
  /** Edge used in `sidebar` mode. Defaults to `'right'`. */
  side?: DrawerSide;
  /** Corner used in `floating` mode. Defaults to `'bottom-right'`. */
  floatingPosition?: AiFloatingPosition;
  /** Controlled sidebar width in px. */
  width?: number | null;
  /** Uncontrolled initial sidebar width in px. */
  defaultWidth?: number;
  /** Called as the reader resizes the sidebar. */
  onWidthChange?: (width: number | null) => void;
  /** Minimum sidebar width in px. Defaults to `384`. */
  minWidth?: number;
  /** Maximum sidebar width in px. Defaults to `832`. */
  maxWidth?: number;
  /** Allow pointer & keyboard resizing in `sidebar` and `floating` modes. Defaults to `true`. */
  resizable?: boolean;
  /**
   * Optional left offset (in layout px) for `fullscreen` mode so the expanded surface fills a host
   * content area beside its navigation rail instead of covering navigation. When omitted, covers the full viewport.
   */
  fullscreenLeft?: number | null;
  /** Whether `fullscreen` mode traps focus with a modal scrim. Defaults to `true` when `fullscreenLeft` is absent, else `false`. */
  fullscreenModal?: boolean;
  /** Optional conversation-history rail rendered beside the main body in `page` or `fullscreen` mode. */
  rail?: ReactNode;
  /** Whether the mobile rail drawer is open in `page` / `fullscreen` mode. */
  railOpen?: boolean;
  /** Called when the mobile rail drawer opens or closes. */
  onRailOpenChange?: (open: boolean) => void;
  /** Accessible name for the assistant surface. */
  ariaLabel?: string;
  /** Explicit ARIA role override (e.g. `'complementary'` for non-modal assistant landmark). */
  role?: string;
  /** Optional DOM id on the surface frame. */
  id?: string;
  /** Keyboard handler invoked before the surface's own Escape handling. */
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  /** Localized strings for resize handle and rail labels. */
  words?: AiSurfaceWords;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}

/**
 * First-class presentation container for AI assistants supporting `sidebar` (non-modal docked UI SDK Drawer),
 * `floating` (non-modal corner-pinned window over the same persistent Drawer), `fullscreen` (full-viewport or
 * content-bounded overlay), `page` (full-page split workspace with UI SDK Resizable rail & mobile Drawer),
 * and `inline` modes.
 */
export function AiAssistantSurface({
  open = true,
  onOpenChange,
  presentation: controlledPresentation,
  defaultPresentation = 'sidebar',
  onPresentationChange,
  side = 'right',
  floatingPosition = 'bottom-right',
  width: controlledWidth,
  defaultWidth,
  onWidthChange,
  minWidth = SIDEBAR_WIDTH_MIN,
  maxWidth = SIDEBAR_WIDTH_MAX,
  resizable = true,
  fullscreenLeft = null,
  fullscreenModal,
  rail,
  railOpen = false,
  onRailOpenChange,
  ariaLabel = 'Assistant',
  role,
  id,
  onKeyDown,
  words: givenWords,
  className,
  style,
  ref,
  children,
}: AiAssistantSurfaceProps) {
  const words = { ...DEFAULT_SURFACE_WORDS, ...givenWords };
  const componentScope = useContext(ComponentStyleScope);
  const onPhone = usePhoneViewport();

  const [internalPresentation, setInternalPresentation] = useState<AiPresentationMode>(defaultPresentation);
  const mode = controlledPresentation ?? internalPresentation;
  const lastCompactModeRef = useRef<'sidebar' | 'floating'>(defaultPresentation === 'floating' ? 'floating' : 'sidebar');
  useEffect(() => {
    if (mode === 'sidebar' || mode === 'floating') lastCompactModeRef.current = mode;
  }, [mode]);

  const setMode = (next: AiPresentationMode) => {
    if (controlledPresentation === undefined) setInternalPresentation(next);
    onPresentationChange?.(next);
  };

  const [internalWidth, setInternalWidth] = useState<number | null>(defaultWidth ?? null);
  const sidebarWidth = controlledWidth !== undefined ? controlledWidth : internalWidth;
  const updateSidebarWidth = (next: number | null) => {
    if (controlledWidth === undefined) setInternalWidth(next);
    onWidthChange?.(next);
  };

  const [floatingSize, setFloatingSize] = useState<{ width: number; height: number } | null>(null);
  const frameRef = useRef<HTMLElement | null>(null);
  const resizeDragRef = useRef<{
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    prevWidth: number | null;
  } | null>(null);

  const assignFrame = (node: HTMLElement | null) => {
    frameRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref && 'current' in ref) (ref as { current: HTMLElement | null }).current = node;
  };

  /* Keep sidebar width clamped when the browser window shrinks. */
  useLayoutEffect(() => {
    if (mode !== 'sidebar' || sidebarWidth === null) return;
    const clampOnResize = () => {
      const clamped = clampSidebarWidth(sidebarWidth, minWidth, maxWidth);
      if (clamped !== sidebarWidth) updateSidebarWidth(clamped);
    };
    window.addEventListener('resize', clampOnResize);
    return () => window.removeEventListener('resize', clampOnResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, sidebarWidth, minWidth, maxWidth]);

  const handleSurfaceKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== 'Escape') return;
    if (mode === 'page' || mode === 'inline') {
      if (railOpen) {
        event.preventDefault();
        onRailOpenChange?.(false);
      }
      return;
    }
    if (mode === 'fullscreen' && !onPhone) {
      event.preventDefault();
      setMode(lastCompactModeRef.current);
      return;
    }
    event.preventDefault();
    onOpenChange?.(false);
  };

  /* Inline mode: simple embedded surface. */
  if (mode === 'inline') {
    return (
      <section
        ref={assignFrame as Ref<HTMLElement>}
        id={id}
        role={role}
        aria-label={ariaLabel}
        data-slot="ai-assistant-surface"
        data-mode="inline"
        data-component={componentScope}
        className={cx('nx-ai-surface nx-ai-surface-inline', className)}
        style={style}
        onKeyDown={handleSurfaceKeyDown}
      >
        {children}
      </section>
    );
  }

  /* Page mode: full-page workspace with Resizable rail on desktop and UI SDK Drawer rail on mobile. */
  if (mode === 'page') {
    const mainPane = <div className="nx-ai-surface-main">{children}</div>;
    return (
      <section
        ref={assignFrame as Ref<HTMLElement>}
        id={id}
        role={role}
        aria-label={ariaLabel}
        data-slot="ai-assistant-surface"
        data-mode="page"
        data-component={componentScope}
        className={cx('nx-ai-surface nx-ai-surface-page', className)}
        style={style}
        onKeyDown={handleSurfaceKeyDown}
      >
        {rail && !onPhone ? (
          <Resizable
            direction="horizontal"
            ariaLabel={ariaLabel}
            className="nx-ai-surface-split"
            panels={[
              {
                label: words.rail,
                defaultSize: 22,
                minSize: 15,
                children: (
                  <nav className="nx-ai-surface-rail" aria-label={words.rail}>
                    {rail}
                  </nav>
                ),
              },
              {
                label: words.main,
                defaultSize: 78,
                minSize: 45,
                children: mainPane,
              },
            ]}
          />
        ) : (
          <>
            {rail ? (
              <Drawer
                open={railOpen}
                onOpenChange={(next) => onRailOpenChange?.(next)}
                side="left"
                ariaLabel={words.rail}
                className="nx-ai-surface-rail-drawer"
              >
                <nav className="nx-ai-surface-rail" aria-label={words.rail}>
                  {rail}
                </nav>
              </Drawer>
            ) : null}
            {mainPane}
          </>
        )}
      </section>
    );
  }

  if (!open) return null;

  /* Unified top-layer overlay (sidebar / floating / fullscreen) over one persistent UI SDK Drawer so switching
     between modes never unmounts the conversation subtree, loses composer focus, or interrupts an active stream. */
  const isSidebar = mode === 'sidebar';
  const isFloating = mode === 'floating';
  const isFullscreen = mode === 'fullscreen';
  const bounded = isFullscreen && fullscreenLeft !== null && !onPhone;
  const resolvedModal = isFullscreen ? (fullscreenModal ?? !bounded) : false;
  const effectiveWidth = isSidebar && sidebarWidth !== null ? clampSidebarWidth(sidebarWidth, minWidth, maxWidth) : undefined;
  const sign = side === 'right' ? 1 : -1;
  const isRight = floatingPosition.endsWith('right');
  const isBottom = floatingPosition.startsWith('bottom');

  const overlayStyle: CSSProperties = {
    ...style,
    ...(isSidebar && effectiveWidth !== undefined ? ({ '--sheet-width': `${effectiveWidth}px` } as CSSProperties) : {}),
    ...(isFloating && floatingSize && !onPhone
      ? ({
          '--ai-float-width': `${floatingSize.width}px`,
          '--ai-float-height': `${floatingSize.height}px`,
        } as CSSProperties)
      : {}),
    ...(bounded ? ({ '--ai-fullscreen-left': `${Math.max(0, Math.round(fullscreenLeft))}px` } as CSSProperties) : {}),
  };

  const mainContent =
    isFullscreen && rail && !onPhone ? (
      <Resizable
        direction="horizontal"
        ariaLabel={ariaLabel}
        className="nx-ai-surface-split"
        panels={[
          {
            label: words.rail,
            defaultSize: 22,
            minSize: 15,
            children: (
              <nav className="nx-ai-surface-rail" aria-label={words.rail}>
                {rail}
              </nav>
            ),
          },
          {
            label: words.main,
            defaultSize: 78,
            minSize: 45,
            children: <div className="nx-ai-surface-main">{children}</div>,
          },
        ]}
      />
    ) : (
      <div className="nx-ai-surface-main">{children}</div>
    );

  return (
    <Drawer
      ref={assignFrame as Ref<HTMLDivElement>}
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === 'escape-key') return;
        onOpenChange?.(next);
      }}
      side={side}
      beside={!resolvedModal}
      modal={resolvedModal}
      docked={isSidebar}
      hideHeader
      dismissible={false}
      initialFocus="none"
      dataMode={mode}
      dataPosition={isFloating ? floatingPosition : undefined}
      dataBounded={bounded}
      ariaModal={resolvedModal}
      id={id}
      role={role ?? (resolvedModal ? 'dialog' : 'complementary')}
      ariaLabel={ariaLabel}
      style={overlayStyle}
      onKeyDown={handleSurfaceKeyDown as KeyboardEventHandler<HTMLDivElement>}
      className={cx(
        'nx-ai-surface',
        isSidebar && 'nx-ai-surface-sidebar',
        isFloating && 'nx-ai-surface-floating',
        isFullscreen && 'nx-ai-surface-fullscreen',
        className,
      )}
    >
      {isSidebar && resizable && !onPhone ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={words.resize}
          title={words.resize}
          tabIndex={0}
          aria-valuenow={effectiveWidth ?? SIDEBAR_WIDTH_DEFAULT}
          aria-valuemin={minWidth}
          aria-valuemax={sidebarCeiling(maxWidth)}
          data-slot="ai-surface-resize"
          data-side={side}
          className="nx-ai-surface-resize"
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            const panel = frameRef.current;
            const current = panel
              ? Math.round(viewportBox(panel).width) || effectiveWidth || SIDEBAR_WIDTH_DEFAULT
              : (effectiveWidth ?? SIDEBAR_WIDTH_DEFAULT);
            resizeDragRef.current = {
              startX: event.clientX,
              startY: event.clientY,
              startWidth: current,
              startHeight: 0,
              prevWidth: sidebarWidth,
            };
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* Renderers without pointer capture still deliver move events to the handle. */
            }
          }}
          onPointerMove={(event) => {
            const drag = resizeDragRef.current;
            if (!drag) return;
            const delta = ((drag.startX - event.clientX) * sign) / viewportScale();
            updateSidebarWidth(clampSidebarWidth(drag.startWidth + delta, minWidth, maxWidth));
          }}
          onPointerUp={() => {
            resizeDragRef.current = null;
          }}
          onPointerCancel={() => {
            const drag = resizeDragRef.current;
            if (!drag) return;
            resizeDragRef.current = null;
            updateSidebarWidth(drag.prevWidth);
          }}
          onDoubleClick={() => updateSidebarWidth(null)}
          onKeyDown={(event) => {
            if (event.altKey && event.key === 'Backspace') {
              event.preventDefault();
              updateSidebarWidth(null);
              return;
            }
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            const step = event.shiftKey ? 64 : 24;
            const base = effectiveWidth ?? SIDEBAR_WIDTH_DEFAULT;
            const delta = event.key === 'ArrowLeft' ? step * sign : -step * sign;
            const next =
              event.key === 'Home'
                ? minWidth
                : event.key === 'End'
                  ? sidebarCeiling(maxWidth)
                  : clampSidebarWidth(base + delta, minWidth, maxWidth);
            updateSidebarWidth(next);
          }}
        />
      ) : null}

      {isFloating && resizable && !onPhone ? (
        <div
          role="separator"
          aria-label={words.resize}
          title={words.resize}
          tabIndex={0}
          data-slot="ai-floating-resize"
          data-position={floatingPosition}
          className="nx-ai-floating-resize"
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            const box = frameRef.current ? viewportBox(frameRef.current) : null;
            resizeDragRef.current = {
              startX: event.clientX,
              startY: event.clientY,
              startWidth: Math.round(box?.width ?? floatingSize?.width ?? FLOATING_WIDTH_DEFAULT),
              startHeight: Math.round(box?.height ?? floatingSize?.height ?? FLOATING_HEIGHT_DEFAULT),
              prevWidth: null,
            };
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
          }}
          onPointerMove={(event) => {
            const drag = resizeDragRef.current;
            if (!drag) return;
            const scale = viewportScale();
            const vp = viewportSize();
            const dx = ((drag.startX - event.clientX) * (isRight ? 1 : -1)) / scale;
            const dy = ((drag.startY - event.clientY) * (isBottom ? 1 : -1)) / scale;
            const maxW = Math.max(FLOATING_WIDTH_MIN, Math.min(720, Math.floor(vp.width - 32)));
            const maxH = Math.max(FLOATING_HEIGHT_MIN, Math.min(840, Math.floor(vp.height - 64)));
            setFloatingSize({
              width: Math.round(Math.min(maxW, Math.max(FLOATING_WIDTH_MIN, drag.startWidth + dx))),
              height: Math.round(Math.min(maxH, Math.max(FLOATING_HEIGHT_MIN, drag.startHeight + dy))),
            });
          }}
          onPointerUp={() => {
            resizeDragRef.current = null;
          }}
          onPointerCancel={() => {
            resizeDragRef.current = null;
          }}
          onDoubleClick={() => setFloatingSize(null)}
          onKeyDown={(event) => {
            if (event.altKey && event.key === 'Backspace') {
              event.preventDefault();
              setFloatingSize(null);
              return;
            }
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const step = event.shiftKey ? 48 : 24;
            const vp = viewportSize();
            const maxW = Math.max(FLOATING_WIDTH_MIN, Math.min(720, Math.floor(vp.width - 32)));
            const maxH = Math.max(FLOATING_HEIGHT_MIN, Math.min(840, Math.floor(vp.height - 64)));
            const curW = floatingSize?.width ?? FLOATING_WIDTH_DEFAULT;
            const curH = floatingSize?.height ?? FLOATING_HEIGHT_DEFAULT;
            const dx = event.key === 'ArrowLeft' ? step * (isRight ? 1 : -1) : event.key === 'ArrowRight' ? -step * (isRight ? 1 : -1) : 0;
            const dy = event.key === 'ArrowUp' ? step * (isBottom ? 1 : -1) : event.key === 'ArrowDown' ? -step * (isBottom ? 1 : -1) : 0;
            setFloatingSize({
              width: Math.round(Math.min(maxW, Math.max(FLOATING_WIDTH_MIN, curW + dx))),
              height: Math.round(Math.min(maxH, Math.max(FLOATING_HEIGHT_MIN, curH + dy))),
            });
          }}
        />
      ) : null}

      {mainContent}
    </Drawer>
  );
}
