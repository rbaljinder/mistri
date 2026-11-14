import { Button as Behavior } from '@ui-sdk/react/button';
import type { ComponentProps } from 'react';

type Intent = 'primary' | 'default' | 'quiet' | 'danger';
type Size = 'sm' | 'md' | 'lg';

/* UI SDK's stylesheet already draws `solid` and `destructive`; `quiet` and the sizes are this theme's
   (theme/parts.css). One action per surface is primary (docs/design.md, rule 5). */
const VARIANT: Record<Intent, string | undefined> = {
  primary: 'solid',
  default: undefined,
  quiet: 'quiet',
  danger: 'destructive',
};

export type ButtonProps = ComponentProps<typeof Behavior> & {
  intent?: Intent;
  size?: Size;
  /* The work the button started is still running, where a caller knows that and the press's own promise does not
     say it (a form submitting, a job elsewhere). It turns its ring, keeps the keyboard, and ignores a press. */
  busy?: boolean;
  /* As wide as what it stands in. */
  block?: boolean;
};

export function Button({ intent = 'default', size = 'md', busy, block, onClick, ...rest }: ButtonProps) {
  return (
    <Behavior
      data-variant={VARIANT[intent]}
      data-size={size === 'md' ? undefined : size}
      data-block={block ? '' : undefined}
      data-pending={busy ? '' : undefined}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      {...rest}
      onClick={busy ? (event) => event.preventDefault() : onClick}
    />
  );
}

export type ButtonLinkProps = Omit<ButtonProps, 'render' | 'type'> & {
  href: string;
  target?: string;
  rel?: string;
  download?: string | boolean;
};

/* Something that goes somewhere, dressed as a button: a real link, so it opens in a new tab, is copied and is
   followed by a keyboard as one. */
export function ButtonLink({ href, target, rel, download, ...rest }: ButtonLinkProps) {
  return (
    <Button
      {...rest}
      render={<a href={href} target={target} rel={rel ?? (target === '_blank' ? 'noreferrer' : undefined)} download={download} />}
    />
  );
}
