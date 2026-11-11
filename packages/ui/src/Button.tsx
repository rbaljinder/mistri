/**
 * The one button: an intent, a size, and the states the platform already
 * has. Every look dresses the classes it renders — `primary`, `ghost` and
 * `danger` are what the looks' rules already name, `btn` and its modifiers
 * are the primitive's own — so a form, a dialog and the sign-in card draw the
 * same control instead of each dressing a `<button>` of its own.
 *
 * Busy is not disabled (docs/design.md, Access): a disabled button drops the
 * focus it holds, so a busy one says `aria-disabled` and refuses the press
 * itself — a click, and the implicit submission Enter makes through it.
 */
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';
import { slotted } from './internal/uiKitContext.js';

export type ButtonIntent = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'compact' | 'default' | 'large';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Primary is the one filled action; secondary the outlined rest; quiet a word in the link ink; danger what cannot be taken back. */
  intent?: ButtonIntent;
  size?: ButtonSize;
  /** Working: pressed once already. Says so and refuses another press, keeping the focus. */
  busy?: boolean;
  /** What the button says while busy ("Saving…"); its own words otherwise. */
  busyLabel?: ReactNode;
  /** Full width of its row: the phone's actions, the sign-in card's submit. */
  block?: boolean;
  type?: 'button' | 'submit' | 'reset';
  ref?: Ref<HTMLButtonElement>;
}

/* The class a look already dresses for each intent, beside the primitive's own. */
const DRESS: Record<ButtonIntent, string> = {
  primary: 'primary btn-primary',
  secondary: 'ghost btn-secondary',
  quiet: 'btn-quiet',
  danger: 'danger btn-danger',
};

/** The classes, for the few controls that must stay another element (a link dressed as a button). */
export function buttonClass({
  intent = 'secondary',
  size = 'default',
  block = false,
  className = '',
}: {
  intent?: ButtonIntent;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
} = {}): string {
  return ['btn', DRESS[intent], size === 'default' ? '' : `btn-${size}`, block ? 'btn-block' : '', className].filter(Boolean).join(' ');
}

function DefaultButton({
  intent = 'secondary',
  size = 'default',
  busy = false,
  busyLabel,
  block = false,
  type = 'button',
  className,
  onClick,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const press = (event: MouseEvent<HTMLButtonElement>) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={buttonClass({ intent, size, block, className })}
      aria-disabled={busy || rest['aria-disabled'] || undefined}
      data-busy={busy || undefined}
      onClick={press}
    >
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  );
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  intent?: ButtonIntent;
  size?: ButtonSize;
  block?: boolean;
  ref?: Ref<HTMLAnchorElement>;
}

/** A link dressed as a button: it goes somewhere (a download, another page) rather than doing something here. */
function DefaultButtonLink({ intent, size, block, className, ...rest }: ButtonLinkProps) {
  return <a {...rest} className={buttonClass({ intent, size, block, className })} />;
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Button = slotted('Button', DefaultButton);
export const ButtonLink = slotted('ButtonLink', DefaultButtonLink);
