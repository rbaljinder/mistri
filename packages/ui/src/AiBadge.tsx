/** Sparkle badge marking AI-generated or AI-assisted content. */
'use client';

import type { ComponentProps, ReactNode } from 'react';
import { Icon } from './Icon.js';
import { cx } from './internal/cx.js';
import { useSurfaceSeam } from './internal/surfaceSeam.js';

/** Props for the `AiBadge` provenance indicator. */
export interface AiBadgeProps extends Omit<ComponentProps<'span'>, 'onChange' | 'aria-label' | 'inlist'> {
  ariaLabel?: string;
  quiet?: boolean;
  pill?: boolean;
  label?: ReactNode;
}

/** Sparkle badge marking AI-generated or AI-assisted content. */
export function AiBadge({ quiet = false, label, pill = true, ariaLabel, className, children, ref, ...props }: AiBadgeProps) {
  const seam = useSurfaceSeam();
  const content = children ?? label ?? seam?.aiLabel?.() ?? 'AI';
  return (
    <span
      ref={ref}
      aria-label={ariaLabel}
      data-quiet={quiet ? '' : undefined}
      data-pill={pill ? '' : undefined}
      className={cx('ai-mark nx-badge nx-ai-badge', className)}
      {...props}
    >
      <Icon name="sparkle" size={11.5} weight="bold" />
      <span className={quiet ? 'kit-visually-hidden nx-sr-only visually-hidden' : undefined}>{content}</span>
    </span>
  );
}
