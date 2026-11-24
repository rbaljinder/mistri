/** Canonical modal, alert confirmation, slide-over drawer, anchored popover, and tooltip overlays. */
'use client';

import {
  AlertDialog as SdkAlertDialog,
  AlertDialogBackdrop as SdkAlertDialogBackdrop,
  AlertDialogClose as SdkAlertDialogClose,
  AlertDialogContent as SdkAlertDialogContent,
  AlertDialogDescription as SdkAlertDialogDescription,
  AlertDialogTitle as SdkAlertDialogTitle,
  AlertDialogTrigger as SdkAlertDialogTrigger,
} from '@ui-sdk/react/alert-dialog';
import { Fragment, isValidElement, type CSSProperties, type ReactElement, type ReactNode, type Ref } from 'react';
import { Drawer, type DrawerProps, type DrawerSide } from '../Drawer.js';
import { HelpTip, type HelpTipProps } from '../FormParts.js';
import { Icon } from '../Icon.js';
import { cx, toDataTone, type Tone } from '../internal/cx.js';
import { Modal, type ModalHandle, type ModalProps } from '../Modal.js';
import { Popover, type PopoverProps } from '../Popover.js';
import { Tooltip, type TooltipProps } from '../Tooltip.js';

function isRenderableElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return isValidElement(node) && node.type !== Fragment;
}

/* ============================================================================
 * 1. Modal & Drawer (canonical slotted overlays)
 * ========================================================================== */

export { Drawer, Modal, type DrawerProps, type DrawerSide, type ModalHandle, type ModalProps };

/* ============================================================================
 * 2. AlertDialog & Imperative confirm
 * ========================================================================== */

/** Destructive or standard action styling variant for `AlertDialog`. */
export type AlertDialogVariant = 'default' | 'danger';

/** Props for the `AlertDialog` confirmation modal. */
export interface AlertDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  dismissible?: boolean;
  trigger?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  variant?: AlertDialogVariant;
  tone?: Tone;
  onConfirm?: () => unknown;
  confirmationFallbackTitle?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/** Modal confirmation dialog requiring explicit user acknowledgement before running an action. */
export function AlertDialog({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  dismissible,
  trigger,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant,
  tone,
  onConfirm,
  confirmationFallbackTitle = 'Confirmation',
  ariaLabel,
  className,
  style,
  ref,
  children,
}: AlertDialogProps) {
  const dataTone = toDataTone(tone as string | undefined);
  const isDanger =
    variant === 'danger' || dataTone === 'critical' || (tone as string | undefined) === 'default'
      ? variant === 'danger' || dataTone === 'critical'
      : false;
  const resolvedDataTone = dataTone ?? (isDanger ? 'critical' : 'neutral');

  return (
    <SdkAlertDialog
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
      onOpenChangeComplete={onOpenChangeComplete}
      dismissible={dismissible}
    >
      {trigger !== undefined &&
        (isRenderableElement(trigger) ? (
          <SdkAlertDialogTrigger render={trigger} />
        ) : (
          <SdkAlertDialogTrigger data-slot="button">{trigger}</SdkAlertDialogTrigger>
        ))}
      <SdkAlertDialogBackdrop />
      <SdkAlertDialogContent
        ref={ref}
        aria-label={ariaLabel}
        data-tone={isDanger ? 'danger' : resolvedDataTone}
        className={cx('nx-alert-dialog-content', className)}
        style={style}
      >
        <div className="nx-alert-dialog-main">
          {(isDanger || resolvedDataTone === 'warning') && (
            <span className="nx-alert-dialog-icon" aria-hidden="true">
              <Icon name="warning" size={18} weight="bold" />
            </span>
          )}
          <div className="nx-alert-dialog-copy">
            {title !== undefined ? (
              <SdkAlertDialogTitle className="nx-dialog-title">{title}</SdkAlertDialogTitle>
            ) : (
              <SdkAlertDialogTitle className="nx-sr-only">{confirmationFallbackTitle}</SdkAlertDialogTitle>
            )}
            {description !== undefined && (
              <SdkAlertDialogDescription className="nx-dialog-description">{description}</SdkAlertDialogDescription>
            )}
            {children}
          </div>
        </div>
        <div className="nx-dialog-footer nx-alert-dialog-footer">
          <SdkAlertDialogClose value="cancel" data-slot="button" data-variant="outline">
            {cancelLabel}
          </SdkAlertDialogClose>
          <SdkAlertDialogClose
            value="confirm"
            data-slot="button"
            data-variant={isDanger ? 'danger' : 'solid'}
            action={onConfirm ? () => onConfirm() : undefined}
          >
            {confirmLabel}
          </SdkAlertDialogClose>
        </div>
      </SdkAlertDialogContent>
    </SdkAlertDialog>
  );
}

/* ============================================================================
 * 3. Popover, Tooltip & HelpTip (canonical slotted layers)
 * ========================================================================== */

export { HelpTip, Popover, Tooltip, type HelpTipProps, type PopoverProps, type TooltipProps };
