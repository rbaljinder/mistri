import { Button as Behavior } from '@ui-sdk/react/button';
import type { ComponentProps } from 'react';
import type { UiKitSlots } from '@mistriwork/ui/UiKit.js';

type Intent = NonNullable<ComponentProps<UiKitSlots['Button']>['intent']>;
type Size = NonNullable<ComponentProps<UiKitSlots['Button']>['size']>;

const VARIANT: Record<Intent, string | undefined> = { primary: 'solid', secondary: undefined, quiet: 'quiet', danger: 'destructive' };
const SIZE: Record<Size, string | undefined> = { compact: 'sm', default: undefined, large: 'lg' };

/* Busy is not disabled (docs/design.md, Access): a disabled button drops the focus it holds, so a busy one says
   aria-disabled and refuses the press itself. */
export const Button: UiKitSlots['Button'] = ({
  intent = 'secondary',
  size = 'default',
  busy = false,
  busyLabel,
  block = false,
  type = 'button',
  onClick,
  children,
  ...rest
}) => (
  <Behavior
    {...rest}
    type={type}
    data-variant={VARIANT[intent]}
    data-size={SIZE[size]}
    data-block={block ? '' : undefined}
    data-busy={busy ? '' : undefined}
    aria-disabled={busy || rest['aria-disabled'] || undefined}
    onClick={(event) => {
      if (busy) {
        event.preventDefault();
        return;
      }
      onClick?.(event as React.MouseEvent<HTMLButtonElement>);
    }}
  >
    {busy && busyLabel !== undefined ? busyLabel : children}
  </Behavior>
);

/* A link dressed as a button: it goes somewhere rather than doing something here, so it is an anchor and nothing
   more, wearing the button's slot for its look. */
export const ButtonLink: UiKitSlots['ButtonLink'] = ({ intent = 'secondary', size = 'default', block, ...rest }) => (
  <a {...rest} data-slot="button" data-variant={VARIANT[intent]} data-size={SIZE[size]} data-block={block ? '' : undefined} />
);
