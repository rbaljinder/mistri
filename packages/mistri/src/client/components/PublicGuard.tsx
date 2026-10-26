/**
 * A public form's guard, loaded on demand so no signed-in page and no first paint carries it: the decoy a script
 * fills and a person never meets, and — where the App names a human check with a widget (`auth.challenge`, server
 * commands/challenges.ts) — the provider's own script, loaded once, drawing its widget with the App's public site key.
 *
 * The form asks the guard for what to send (`take`): the decoy's value where something filled it, and the widget's
 * token, waited for while the widget is still solving. A provider's token is good once, so after every answer the form
 * calls `reset`, and the widget is asked for a fresh one: a retry after a refusal keeps its submission key and its
 * receipt, and sends a new token.
 *
 * Provider-neutral by the shape the common ones share: the script registers a global (`turnstile`, `hcaptcha`) with
 * `render(element, { sitekey, action, callback, 'expired-callback', 'error-callback' })`, `reset(id)` and `remove(id)`.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';

export interface ChallengeWidget {
  script: string;
  api: string;
  siteKey: string;
  action?: string;
}

/** What a public form sends beside its input: its decoy's value, where something filled it, and its check's token. */
export interface FormGuard {
  trap?: string;
  challenge?: string;
}

/** The guard's handle, which the form holds while the guard is drawn. */
export interface GuardHandle {
  /** At once where there is no widget, so the send leaves in the press's own turn; else once the widget has a token. */
  take(): FormGuard | Promise<FormGuard>;
  reset(): void;
}

interface WidgetApi {
  render(element: HTMLElement, options: Record<string, unknown>): unknown;
  reset?(id: unknown): void;
  remove?(id: unknown): void;
}

/* How long a submit waits for the widget's token before it is sent without one (and the server says so). */
const TOKEN_WAIT_MS = 10_000;

const loading = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let loaded = loading.get(src);
  if (!loaded) {
    loaded = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        loading.delete(src);
        reject(new Error(src));
      };
      document.head.append(script);
    });
    loading.set(src, loaded);
  }
  return loaded;
}

const apiOf = (widget: ChallengeWidget) => (globalThis as unknown as Record<string, WidgetApi | undefined>)[widget.api];

export function PublicGuard({ widget, handle }: { widget?: ChallengeWidget; handle: MutableRefObject<GuardHandle | undefined> }) {
  const trap = useRef<HTMLInputElement>(null);
  const host = useRef<HTMLDivElement>(null);
  /* The widget's latest token, and whoever is waiting for the next one. */
  const token = useRef<string | undefined>(undefined);
  const waiting = useRef<Array<(token: string | undefined) => void>>([]);
  const id = useRef<unknown>(undefined);
  const given = (next: string | undefined) => {
    token.current = next;
    if (next === undefined) return;
    for (const resolve of waiting.current.splice(0)) resolve(next);
  };

  useEffect(() => {
    handle.current = {
      take() {
        const trapped = trap.current?.value;
        const guard: FormGuard = trapped ? { trap: trapped } : {};
        if (!widget) return guard;
        const spend = (ready: string | undefined): FormGuard => {
          // Spent by this send: the next one waits for the fresh token `reset` asks for.
          token.current = undefined;
          return ready ? { ...guard, challenge: ready } : guard;
        };
        if (token.current !== undefined) return spend(token.current);
        return new Promise<string | undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), TOKEN_WAIT_MS);
          waiting.current.push((next) => {
            clearTimeout(timer);
            resolve(next);
          });
        }).then(spend);
      },
      reset() {
        token.current = undefined;
        if (widget && id.current !== undefined) apiOf(widget)?.reset?.(id.current);
      },
    };
    return () => {
      handle.current = undefined;
    };
  }, [handle, widget]);

  useEffect(() => {
    if (!widget) return;
    let gone = false;
    void loadScript(widget.script)
      .then(() => {
        const api = apiOf(widget);
        if (gone || !host.current || !api?.render) return;
        id.current = api.render(host.current, {
          sitekey: widget.siteKey,
          ...(widget.action ? { action: widget.action } : {}),
          callback: (next: string) => given(next),
          'expired-callback': () => given(undefined),
          'error-callback': () => given(undefined),
        });
      })
      .catch(() => given(undefined));
    return () => {
      gone = true;
      if (id.current !== undefined) apiOf(widget)?.remove?.(id.current);
      id.current = undefined;
    };
  }, [widget?.script, widget?.api, widget?.siteKey, widget?.action]);

  return (
    <>
      {/* The decoy: hidden, out of the tab order and the accessibility tree, under a name no autofill knows and marked
          as a new password, so a browser or a password manager leaves it empty and only a script fills it. */}
      <div className="visually-hidden" aria-hidden="true">
        <input ref={trap} name="mx_hp_7f" tabIndex={-1} autoComplete="new-password" aria-hidden="true" />
      </div>
      {widget && <div ref={host} className="form-challenge" />}
    </>
  );
}
