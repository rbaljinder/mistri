/**
 * An amount set by a slider and read out in a box above it, with the range's ends labelled. The slider is the
 * browser's own range input, so the arrows, Home, End and the Page keys are the platform's, and it is the control of
 * UI SDK's field around it, which hands it its id, its name and what describes it as it does a text box. It is not
 * UI SDK's slider: that one is a track and a thumb over an input of its own whose id it decides, where this control
 * is one labelable element that takes the id a caller gives it. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { FieldControl } from '@ui-sdk/react/field';
import type { ChangeEvent, CSSProperties, ReactNode, Ref } from 'react';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import type { FieldFrame } from './fieldFrame.js';
import { grouped } from './masks.js';
import { Frame } from './internal/Frame.js';
import { resolveLocale } from './internal/locale.js';
import { useSurfaceSeam } from './internal/surfaceSeam.js';
import { slotted } from './internal/uiKitContext.js';

/** Props for the `Slider` numeric range control. */
export interface SliderProps extends FieldFrame {
  value: number;
  onValueChange?: (value: number, details: ChangeDetails<'slide'>) => void;
  min: number;
  max: number;
  step?: number;
  /** Custom value formatter overriding `format` preset and default grouped integer readout. */
  formatValue?: (n: number) => string;
  /** Built-in numeric format preset (`'number' | 'money' | 'percent'`). */
  format?: 'number' | 'money' | 'percent';
  /** ISO currency code for `format="money"`, as `FormattedValue` and `LineItemsEditor` take theirs. Defaults to `'USD'`. */
  currency?: string;
  locale?: string;
  disabled?: boolean;
  ref?: Ref<HTMLInputElement>;
}

function formatSliderPreset(n: number, preset: 'number' | 'money' | 'percent', locale?: string, currency = 'USD'): string {
  const tag = resolveLocale(locale);
  if (preset === 'percent') {
    return new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 1 }).format(n / 100);
  }
  if (preset === 'money') {
    return new Intl.NumberFormat(tag, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  }
  return new Intl.NumberFormat(tag).format(n);
}

function DefaultSlider(props: SliderProps): ReactNode {
  const seam = useSurfaceSeam();
  const legacyFormat = (props as { format?: unknown }).format;
  const say: (n: number) => string =
    props.formatValue ??
    (typeof legacyFormat === 'function'
      ? (legacyFormat as (n: number) => string)
      : props.format
        ? (n: number) =>
            /* A currency named on the slider is said as named; the host's preset takes no currency and would draw its own. */
            (props.currency ? undefined : seam?.formatPreset?.(n, props.format!, props.locale)) ??
            formatSliderPreset(n, props.format!, props.locale, props.currency)
        : grouped);
  const span = props.max - props.min;
  const share = span > 0 ? ((props.value - props.min) / span) * 100 : 0;
  return (
    <Frame {...props}>
      <div data-slot="slider-readout" aria-hidden="true">
        {say(props.value)}
      </div>
      <FieldControl
        id={props.id}
        ref={props.ref}
        type="range"
        data-kind="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        aria-valuetext={say(props.value)}
        style={{ '--range-share': `${share}%` } as CSSProperties}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const next = Number(event.target.value);
          const info = changeDetails('slide', event);
          const legacy = (props as { onChange?: (value: number, details: ChangeDetails<'slide'>) => void }).onChange;
          props.onValueChange?.(next, info);
          legacy?.(next, info);
        }}
      />
      <div data-slot="slider-ends" aria-hidden="true">
        <span>{say(props.min)}</span>
        <span>{say(props.max)}</span>
      </div>
    </Frame>
  );
}

/** Framed numeric range slider with live readout and labelled min/max bounds. */
export const Slider = slotted('Slider', DefaultSlider, { onValueChange: [1, 'slide'] });
