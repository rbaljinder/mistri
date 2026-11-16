/**
 * The one button: an intent, a size, and the states the platform already
 * has, over UI SDK's Button. An intent and a size are attributes of the one
 * button part (`data-variant`, `data-size`), which the stylesheet and every
 * look dress, so a form, a dialog and the sign-in card draw the same control
 * instead of each dressing a `<button>` of its own.
 *
 * Busy is not disabled (docs/design.md, Access): a disabled button drops the
 * focus it holds, so a busy one says `aria-disabled` and refuses the press
 * itself — a click, and the implicit submission Enter makes through it.
 */
import { Button as Behavior } from '@ui-sdk/react/button';
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

/* What the button part says of each intent and size. The outlined secondary and the default size are the part as
   it stands, so they say nothing. */
const VARIANT: Record<ButtonIntent, string | undefined> = { primary: 'solid', secondary: undefined, quiet: 'quiet', danger: 'destructive' };
const SIZE: Record<ButtonSize, string | undefined> = { compact: 'sm', default: undefined, large: 'lg' };

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
  return ['ui-button', `ui-button-${intent}`, size === 'default' ? '' : `ui-button-${size}`, block ? 'ui-button-block' : '', className]
    .filter(Boolean)
    .join(' ');
}

function DefaultButton({
  intent = 'secondary',
  size = 'default',
  busy = false,
  busyLabel,
  block = false,
  type = 'button',
  onClick,
  children,
  ...rest
}: ButtonProps) {
  /* UI SDK types the press by the part, which may be drawn as any element; here it is always the button. */
  const press = (event: MouseEvent<HTMLElement>) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    onClick?.(event as MouseEvent<HTMLButtonElement>);
  };
  return (
    <Behavior
      {...rest}
      type={type}
      data-variant={VARIANT[intent]}
      data-size={SIZE[size]}
      data-block={block ? '' : undefined}
      data-busy={busy ? '' : undefined}
      aria-disabled={busy || rest['aria-disabled'] || undefined}
      onClick={press}
    >
      {busy && busyLabel !== undefined ? busyLabel : children}
    </Behavior>
  );
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  intent?: ButtonIntent;
  size?: ButtonSize;
  block?: boolean;
  ref?: Ref<HTMLAnchorElement>;
}

/** A link dressed as a button: it goes somewhere (a download, another page) rather than doing something here, so it
    is an anchor and nothing more, wearing the button's part for its look. */
function DefaultButtonLink({ intent = 'secondary', size = 'default', block, ...rest }: ButtonLinkProps) {
  return <a {...rest} data-slot="button" data-variant={VARIANT[intent]} data-size={SIZE[size]} data-block={block ? '' : undefined} />;
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Button = slotted('Button', DefaultButton);
export const ButtonLink = slotted('ButtonLink', DefaultButtonLink);
