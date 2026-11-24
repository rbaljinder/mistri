/** Class name joiner and canonical shared UI vocabulary types (`Tone`, `ControlSize`, `EmptyStateSpec`). */
import { isValidElement, type ReactNode } from 'react';

/** Semantic tone shared across badges, status indicators, alerts, cards, and charts. */
export type Tone = 'neutral' | 'info' | 'good' | 'warning' | 'critical' | 'accent';

/** Control size shared across buttons, fields, pickers, switches, and meters. */
export type ControlSize = 'xs' | 'sm' | 'md' | 'lg';

/** Structured empty-state content shared across lists, tables, pickers, and views. */
export interface EmptyStateSpec {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}

/** Join truthy class name tokens with single spaces. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Normalize canonical and legacy runtime tone strings to canonical `data-tone` values. */
export function toDataTone(tone?: string): Tone | undefined {
  if (!tone) return undefined;
  switch (tone) {
    case 'good':
    case 'success':
      return 'good';
    case 'critical':
    case 'danger':
    case 'bad':
      return 'critical';
    case 'warning':
    case 'warn':
      return 'warning';
    case 'info':
      return 'info';
    case 'accent':
      return 'accent';
    case 'neutral':
    default:
      return 'neutral';
  }
}

/** Normalize canonical and legacy runtime tone strings to `.tone-*` and `.kit-card-title-*` suffix values. */
export function toKitTone(tone?: string): 'neutral' | 'info' | 'good' | 'warn' | 'bad' | 'accent' | undefined {
  if (!tone) return undefined;
  switch (tone) {
    case 'good':
    case 'success':
      return 'good';
    case 'warning':
    case 'warn':
      return 'warn';
    case 'critical':
    case 'danger':
    case 'bad':
      return 'bad';
    case 'info':
      return 'info';
    case 'accent':
      return 'accent';
    case 'neutral':
    default:
      return 'neutral';
  }
}

/** Type guard distinguishing a structured `EmptyStateSpec` object from a plain `ReactNode` or `ReactElement`. */
export function isEmptyStateSpec(value: unknown): value is EmptyStateSpec {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isValidElement(value) && 'title' in value;
}
