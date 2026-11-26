/**
 * The one button: a variant, a size, and the states the platform already
 * has, over UI SDK's Button. A variant and a size are attributes of the one
 * button part (`data-variant`, `data-size`), which the stylesheet and every
 * look dress, so a form, a dialog and the sign-in card draw the same control
 * instead of each dressing a `<button>` of its own.
 *
 * Loading is not disabled (docs/design.md, Access): a disabled button drops the
 * focus it holds, so a loading one says `aria-disabled` and `aria-busy` and refuses
 * the press itself — a click, and the implicit submission Enter makes through it.
 */
import { Button as Behavior } from '@ui-sdk/react/button';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';
import type { ControlSize } from './internal/cx.js';
import { safeHref } from './internal/safeHref.js';
import { useSurfaceSeam } from './internal/surfaceSeam.js';
import { slotted } from './internal/uiKitContext.js';

/** Interaction metadata passed to `Button` press callbacks. */
export interface ButtonActionDetails {
  source: string;
}

/** Visual emphasis variant for `Button` and `ButtonLink`. */
export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'outline' | 'ghost' | 'danger' | 'danger-soft';

/** Control height scale for `Button` and `ButtonLink`. */
export type ButtonSize = ControlSize;

/** Props for the `Button` component. */
export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'children' | 'onClick' | 'onChange' | 'aria-label' | 'inlist' | 'className'
> {
  /** Primary is the one filled action; secondary the outlined rest; ghost a word in the link ink; danger what cannot be taken back. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Working: pressed once already. Says so and refuses another press, keeping the focus. */
  loading?: boolean;
  /** What the button says while loading ("Saving…"); its own words otherwise. */
  loadingLabel?: ReactNode;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  shortcut?: string;
  /** Full width of its row: the phone's actions, the sign-in card's submit. */
  block?: boolean;
  iconOnly?: boolean;
  'data-icon-only'?: '' | undefined;
  type?: 'button' | 'submit' | 'reset';
  ariaLabel?: string;
  /** Optional destination URL; renders as a button-styled link wired through the host router seam when provided. */
  href?: string;
  target?: string;
  rel?: string;
  download?: boolean | string;
  className?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>, details: ButtonActionDetails) => unknown;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/* What the button part says of each variant and size. The outlined secondary and the default md size are the part as
   it stands, so they say nothing (`[data-slot='button']:not([data-variant])`). */
const VARIANT: Record<ButtonVariant, string | undefined> = {
  primary: 'solid',
  secondary: undefined,
  soft: 'soft',
  outline: 'outline',
  ghost: 'quiet',
  danger: 'destructive',
  'danger-soft': 'danger-soft',
};
const SIZE: Record<ButtonSize, string | undefined> = {
  xs: 'xs',
  sm: 'sm',
  md: undefined,
  lg: 'lg',
};

/** Build canonical button utility classes for non-button elements that wear button styling. */
export function buttonClass({
  variant = 'secondary',
  size = 'md',
  block = false,
  className = '',
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
} = {}): string {
  return ['ui-button', `ui-button-${variant}`, size === 'md' ? '' : `ui-button-${size}`, block ? 'ui-button-block' : '', className]
    .filter(Boolean)
    .join(' ');
}

function renderAffixes(label: ReactNode, leadingIcon?: ReactNode, trailingIcon?: ReactNode, shortcut?: string) {
  return (
    <>
      {leadingIcon ? (
        <span data-slot="button-icon" data-side="start" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      {label}
      {trailingIcon ? (
        <span data-slot="button-icon" data-side="end" aria-hidden="true">
          {trailingIcon}
        </span>
      ) : null}
      {shortcut ? <kbd data-slot="button-shortcut">{shortcut}</kbd> : null}
    </>
  );
}

function DefaultButton({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel,
  leadingIcon,
  trailingIcon,
  shortcut,
  block = false,
  iconOnly = false,
  type = 'button',
  disabled,
  ariaLabel,
  href,
  target,
  rel,
  download,
  className,
  onClick,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const legacyAriaLabel = (rest as Record<string, unknown>)['aria-label'] as string | undefined;
  const resolvedAriaLabel = ariaLabel ?? legacyAriaLabel;
  const isIconOnly = iconOnly || rest['data-icon-only'] !== undefined;

  if (href !== undefined) {
    const anchorRest = { ...(rest as Record<string, unknown>) };
    delete anchorRest['data-icon-only'];
    return (
      <DefaultButtonLink
        {...(anchorRest as Omit<
          ButtonLinkProps,
          | 'variant'
          | 'size'
          | 'leadingIcon'
          | 'trailingIcon'
          | 'shortcut'
          | 'block'
          | 'iconOnly'
          | 'disabled'
          | 'ariaLabel'
          | 'href'
          | 'target'
          | 'rel'
          | 'download'
          | 'className'
          | 'ref'
          | 'onClick'
          | 'children'
        >)}
        variant={variant}
        size={size}
        leadingIcon={loading ? undefined : leadingIcon}
        trailingIcon={loading ? undefined : trailingIcon}
        shortcut={shortcut}
        block={block}
        iconOnly={isIconOnly}
        disabled={disabled || loading}
        ariaLabel={resolvedAriaLabel}
        href={href}
        target={target}
        rel={rel}
        download={download}
        className={className}
        ref={ref as unknown as Ref<HTMLAnchorElement>}
        onClick={
          onClick
            ? (event) => {
                onClick(event as unknown as MouseEvent<HTMLButtonElement>, { source: 'pointer' });
              }
            : undefined
        }
      >
        {loading && loadingLabel !== undefined ? loadingLabel : children}
      </DefaultButtonLink>
    );
  }

  const press = (event: MouseEvent<HTMLElement>, details: ButtonActionDetails): unknown => {
    if (loading) {
      event.preventDefault();
      event.stopPropagation();
      return undefined;
    }
    return onClick?.(event as MouseEvent<HTMLButtonElement>, details);
  };
  const activeLabel = loading && loadingLabel !== undefined ? loadingLabel : children;
  const hasAffixes = leadingIcon !== undefined || trailingIcon !== undefined || shortcut !== undefined;
  return (
    <Behavior
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      className={className}
      aria-label={resolvedAriaLabel}
      data-variant={VARIANT[variant]}
      data-size={SIZE[size]}
      data-block={block ? '' : undefined}
      data-icon-only={isIconOnly ? '' : undefined}
      data-busy={loading ? '' : undefined}
      aria-busy={loading || undefined}
      aria-disabled={loading || disabled || rest['aria-disabled'] || undefined}
      onClick={press}
    >
      {hasAffixes
        ? () => renderAffixes(activeLabel, loading ? undefined : leadingIcon, loading ? undefined : trailingIcon, shortcut)
        : activeLabel}
    </Behavior>
  );
}

/** Props for the `ButtonLink` component. */
export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'onChange' | 'aria-label' | 'inlist'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  shortcut?: string;
  block?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  ref?: Ref<HTMLAnchorElement>;
}

/** A link dressed as a button: it goes somewhere (a download, another page) rather than doing something here, so it
    is an anchor and nothing more, wearing the button's part for its look. A held one (`disabled` or `aria-disabled`)
    says so in the part's own state attribute, so it is drawn as a held button and refuses to go. */
function DefaultButtonLink({
  variant = 'secondary',
  size = 'md',
  leadingIcon,
  trailingIcon,
  shortcut,
  block = false,
  iconOnly = false,
  disabled = false,
  ariaLabel,
  href,
  onClick,
  children,
  ...rest
}: ButtonLinkProps) {
  const seam = useSurfaceSeam();
  const legacyAriaLabel = (rest as Record<string, unknown>)['aria-label'] as string | undefined;
  const resolvedAriaLabel = ariaLabel ?? legacyAriaLabel;
  const held = disabled || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  const rawFollow = (event: MouseEvent<HTMLElement>) => {
    if (held) {
      event.preventDefault();
      return;
    }
    onClick?.(event as MouseEvent<HTMLAnchorElement>);
  };
  const cleanHref = safeHref(href);
  const routed = seam?.useLinkProps ? seam.useLinkProps(held ? undefined : cleanHref, rawFollow) : { href: cleanHref, onClick: rawFollow };
  return (
    <a
      {...rest}
      href={held ? undefined : (safeHref(routed.href) ?? cleanHref)}
      aria-label={resolvedAriaLabel}
      onClick={(event) => {
        if (held) {
          event.preventDefault();
          return;
        }
        (routed.onClick ?? rawFollow)(event);
      }}
      data-slot="button"
      data-variant={VARIANT[variant]}
      data-size={SIZE[size]}
      data-block={block ? '' : undefined}
      data-icon-only={iconOnly ? '' : undefined}
      data-disabled={held ? '' : undefined}
      aria-disabled={held ? true : rest['aria-disabled']}
    >
      {renderAffixes(children, leadingIcon, trailingIcon, shortcut)}
    </a>
  );
}

/** Interactive action button with variants, sizes, loading focus retention, and optional link routing. */
export const Button = slotted('Button', DefaultButton);

/** Anchor element styled with canonical `Button` variants, sizes, and affixes. */
export const ButtonLink = slotted('ButtonLink', DefaultButtonLink);
