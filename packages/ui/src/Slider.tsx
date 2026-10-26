/**
 * An amount set by a slider and read out in a box above it, with the range's ends labelled. The slider is the native
 * range input, so the arrows, Home, End and Page keys are the browser's. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Field } from './Field.js';
import { frameOf, type FieldFrame } from './fieldFrame.js';
import { grouped } from './masks.js';

export interface SliderProps extends FieldFrame {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** How a number is said, in the box, at the ends and to assistive technology. Whole numbers with separators by default. */
  format?: (n: number) => string;
  disabled?: boolean;
}

export function Slider(props: SliderProps): ReactNode {
  const say = props.format ?? grouped;
  const span = props.max - props.min;
  const share = span > 0 ? ((props.value - props.min) / span) * 100 : 0;
  return (
    <Field {...frameOf(props)}>
      {(control) => (
        <>
          <div className="field-control field-readout" aria-hidden="true">
            {say(props.value)}
          </div>
          <input
            {...control}
            type="range"
            className="field-range"
            min={props.min}
            max={props.max}
            step={props.step}
            value={props.value}
            disabled={props.disabled}
            aria-valuetext={say(props.value)}
            style={{ '--range-share': `${share}%` } as CSSProperties}
            onChange={(e) => props.onChange(Number(e.target.value))}
          />
          <div className="field-range-ends" aria-hidden="true">
            <span>{say(props.min)}</span>
            <span>{say(props.max)}</span>
          </div>
        </>
      )}
    </Field>
  );
}
