import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { addHostListener, removeHostListener } from '../shellHost.js';

const cancellations = new Set<() => void>();

/** Intent belongs to the record, even when another field has a deferred blur. */
export function cancelEditInteractions() {
  for (const cancel of cancellations) cancel();
}

interface EditInteractionOptions {
  enabled: boolean;
  blocked?: boolean;
  owner?: string;
  captureGuard: (current: () => boolean) => () => boolean;
  onLeave: (guard: () => boolean) => void;
  onCancel: () => void;
}

const action = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(
    target.closest('a, [role="link"], [data-edit-intent]') ||
    (!target.closest('[data-edit-field]') &&
      target.closest(
        'button, summary, .clickable, [role="button"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"]), input, select, textarea',
      )),
  );

/** A blur is evidence to examine, not permission to submit. Focus and pointer
 * ownership are checked after Base UI has settled selection/return focus. */
export function useEditInteraction(options: EditInteractionOptions) {
  const latest = useRef(options);
  latest.current = options;
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const state = useRef({
    mounted: false,
    generation: 0,
    armed: false,
    departed: false,
    open: false,
    pointer: false,
    decision: undefined as undefined | { mounted: () => boolean; guard: () => boolean },
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const owns = useCallback(
    (target: EventTarget | null) => target instanceof Node && Boolean(root.current?.contains(target) || popup.current?.contains(target)),
    [],
  );
  const cancel = useCallback(() => {
    const s = state.current;
    s.generation++;
    s.armed = false;
    s.departed = false;
    s.decision = undefined;
    clearTimeout(s.timer);
  }, []);
  const changed = useCallback(() => {
    if (!latest.current.enabled) return;
    const s = state.current;
    s.generation++;
    s.armed = true;
    s.departed = false;
    s.decision = undefined;
    clearTimeout(s.timer);
  }, []);
  useLayoutEffect(() => cancel, [cancel, options.owner]);
  const settle = useCallback(() => {
    const s = state.current;
    if (!s.mounted || !s.armed || !s.departed || !latest.current.enabled) return;
    clearTimeout(s.timer);
    if (!s.decision) {
      const generation = s.generation;
      const mounted = () => s.mounted && generation === s.generation && latest.current.enabled && Boolean(root.current?.isConnected);
      s.decision = { mounted, guard: latest.current.captureGuard(mounted) };
    }
    const { mounted, guard } = s.decision;
    s.timer = setTimeout(() => {
      if (!mounted() || !s.armed || !s.departed || s.open || s.pointer) return;
      const active = document.activeElement;
      if (owns(active)) {
        s.departed = false;
        return;
      }
      if (action(active)) {
        cancelEditInteractions();
        latest.current.onCancel();
        return;
      }
      const current = () =>
        mounted() && !s.open && !s.pointer && !owns(document.activeElement) && !action(document.activeElement) && guard();
      // Consume this user change even if preflight or the store refuses it.
      s.armed = false;
      s.departed = false;
      s.decision = undefined;
      latest.current.onLeave(current);
    }, 0);
  }, [owns]);
  const popupRef = useCallback((node: HTMLDivElement | null) => {
    popup.current = node;
    if (node) {
      node.setAttribute('data-edit-field', '');
      node.inert = Boolean(latest.current.blocked);
    }
  }, []);
  useLayoutEffect(() => {
    if (popup.current) popup.current.inert = Boolean(options.blocked);
  }, [options.blocked]);
  const onOpenChange = useCallback(
    (open: boolean) => {
      state.current.open = open;
      if (!open) settle();
    },
    [settle],
  );

  useEffect(() => {
    const s = state.current;
    s.mounted = true;
    cancellations.add(cancel);
    const cancelIntent = () => {
      cancelEditInteractions();
      latest.current.onCancel();
    };
    const focusOut = (event: FocusEvent) => {
      if (!owns(event.target)) return;
      s.departed = true;
      if (action(event.relatedTarget) && !owns(event.relatedTarget)) cancelIntent();
      else settle();
    };
    const focusIn = (event: FocusEvent) => {
      if (owns(event.target)) {
        s.departed = false;
        s.decision = undefined;
        clearTimeout(s.timer);
      } else if (s.armed && action(event.target)) cancelIntent();
    };
    const pointerDown = (event: PointerEvent) => {
      if (!s.armed && !owns(event.target)) return;
      if (!owns(event.target) && action(event.target)) {
        cancelIntent();
        return;
      }
      s.pointer = true;
    };
    const pointerUp = () => {
      s.pointer = false;
      settle();
    };
    const pointerCancel = () => {
      s.pointer = false;
      cancelIntent();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || ((event.key === 'Enter' || event.key === ' ') && !owns(event.target) && action(event.target)))
        cancelIntent();
    };
    const click = (event: MouseEvent) => {
      if (!owns(event.target) && action(event.target)) cancelIntent();
    };
    const input = (event: Event) => {
      if (owns(event.target)) changed();
    };
    addHostListener(document, 'focusout', focusOut, true);
    addHostListener(document, 'focusin', focusIn, true);
    addHostListener(document, 'pointerdown', pointerDown, true);
    addHostListener(document, 'pointerup', pointerUp, true);
    addHostListener(document, 'pointercancel', pointerCancel, true);
    addHostListener(document, 'keydown', keyDown, true);
    addHostListener(document, 'click', click, true);
    addHostListener(document, 'input', input, true);
    addHostListener(window, 'blur', cancelIntent);
    return () => {
      s.mounted = false;
      cancel();
      cancellations.delete(cancel);
      removeHostListener(document, 'focusout', focusOut, true);
      removeHostListener(document, 'focusin', focusIn, true);
      removeHostListener(document, 'pointerdown', pointerDown, true);
      removeHostListener(document, 'pointerup', pointerUp, true);
      removeHostListener(document, 'pointercancel', pointerCancel, true);
      removeHostListener(document, 'keydown', keyDown, true);
      removeHostListener(document, 'click', click, true);
      removeHostListener(document, 'input', input, true);
      removeHostListener(window, 'blur', cancelIntent);
    };
  }, [cancel, changed, owns, settle]);

  return { root, popupRef, onOpenChange, changed, isOpen: () => state.current.open };
}
