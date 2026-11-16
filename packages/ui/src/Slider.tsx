/**
 * An amount set by a slider and read out in a box above it, with the range's ends labelled. The slider is the
 * browser's own range input, so the arrows, Home, End and the Page keys are the platform's, and it is the control of
 * UI SDK's field around it, which hands it its id, its name and what describes it as it does a text box. It is not
 * UI SDK's slider: that one is a track and a thumb over an input of its own whose id it decides, where this control
 * is one labelable element that takes the id a caller gives it. Props only. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { FieldControl } from '@ui-sdk/react/field';
import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import type { FieldFrame } from './fieldFrame.js';
import { grouped } from './masks.js';
import { Frame } from './internal/Frame.js';
import { slotted } from './internal/uiKitContext.js';

export interface SliderProps extends FieldFrame {
  value: number;
  onChange: (value: number, details: ChangeDetails<'slide'>) => void;
  min: number;
  max: number;
  step?: number;
  /** How a number is said, in the box, at the ends and to assistive technology. Whole numbers with separators by default. */
  format?: (n: number) => string;
  disabled?: boolean;
}

function DefaultSlider(props: SliderProps): ReactNode {
  const say = props.format ?? grouped;
  const span = props.max - props.min;
  // The filled share of the track, for the stylesheet to draw (a range's own fill cannot be dressed everywhere).
  const share = span > 0 ? ((props.value - props.min) / span) * 100 : 0;
  return (
    <Frame {...props}>
      <div data-slot="slider-readout" aria-hidden="true">
        {say(props.value)}
      </div>
      <FieldControl
        id={props.id}
        type="range"
        data-kind="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        aria-valuetext={say(props.value)}
        style={{ '--range-share': `${share}%` } as CSSProperties}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(Number(event.target.value), changeDetails('slide', event))}
      />
      <div data-slot="slider-ends" aria-hidden="true">
        <span>{say(props.min)}</span>
        <span>{say(props.max)}</span>
      </div>
    </Frame>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Slider = slotted('Slider', DefaultSlider, { onChange: [1, 'slide'] });
