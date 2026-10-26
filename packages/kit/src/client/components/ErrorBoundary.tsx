/**
 * What stands between one part of a screen that throws while drawing and the
 * rest of the screen. Without one, React takes down the whole root: a
 * dashboard card with a bad value blanked the dashboard, a record section
 * the record. With one, the part that threw says so in its own place and
 * everything around it stays.
 *
 * Every page section, dashboard section and room has one, and so does every
 * root `mount` draws. The fallback is the shared problem note (Notes.tsx),
 * marked `data-section-error`: a caught error does not reach the browser as
 * an uncaught one, so the browser suites (e2e/support/harness.ts, and with
 * it `npm run smoke`) look for the mark and the console line this writes,
 * and fail on either. A drawing error is a bug, never a reader's problem,
 * so it is never quiet. Try again draws the part afresh; a part whose
 * `resetKey` changes (a room after navigating) starts afresh by itself.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { message } from '../messages.js';
import { Problem } from './Notes.js';
import { say } from '../copy/shell/components/ErrorBoundary.js';

/** The console line the browser suites watch for. */
export const SECTION_ERROR = say('tablewalkASectionCould');

interface Props {
  children: ReactNode;
  /** What stands in the part's place: its heading and the note, say. Defaults to the note alone. */
  fallback?: (note: ReactNode) => ReactNode;
  /** Which note: a section's, or a whole room's. */
  scope?: 'section' | 'room';
  /** A new key forgets the error: the part is a different part now. */
  resetKey?: unknown;
}

interface State {
  error: unknown;
  key: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: undefined, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error(say('unknownError')) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.key) ? null : { error: undefined, key: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(SECTION_ERROR, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    const note = (
      <Problem
        crashed
        text={message(this.props.scope === 'room' ? 'problem.roomNotDrawn' : 'problem.notDrawn')}
        retry={() => this.setState({ error: undefined })}
      />
    );
    return this.props.fallback ? this.props.fallback(note) : note;
  }
}
