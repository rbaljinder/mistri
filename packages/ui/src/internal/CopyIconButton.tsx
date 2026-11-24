/** Inline clipboard copy icon button used by key-value, formatted-value, and JSON tree primitives. */
'use client';

import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon.js';
import { cx } from './cx.js';

export function CopyIconButton({
  text,
  label = 'Copy value',
  copiedLabel = 'Copied',
  className,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(text);
      }
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    },
    [text],
  );

  return (
    <button
      type="button"
      onClick={handleCopy}
      data-copied={copied ? '' : undefined}
      className={cx('nx-copy-btn nx-focusable', className)}
      aria-label={copied ? copiedLabel : label}
    >
      {copied ? <Icon name="check" size={13} weight="bold" /> : <Icon name="copy" size={13} />}
    </button>
  );
}
