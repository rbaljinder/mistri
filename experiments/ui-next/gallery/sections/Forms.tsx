import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@ui-sdk/react/combobox';
import { DatePicker, DatePickerContent, DatePickerInput, DatePickerTrigger } from '@ui-sdk/react/date-picker';
import { Field, FieldDescription, FieldError, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { NumberInput, NumberInputControl, NumberInputDecrement, NumberInputGroup, NumberInputIncrement } from '@ui-sdk/react/number-input';
import { OTPInput, OTPInputGroup, OTPInputSlot } from '@ui-sdk/react/otp-input';
import { PasswordInput, PasswordInputControl, PasswordInputToggle } from '@ui-sdk/react/password-input';
import { Radio, RadioGroup, RadioIndicator } from '@ui-sdk/react/radio';
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui-sdk/react/select';
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack, SliderValue } from '@ui-sdk/react/slider';
import { Switch, SwitchThumb } from '@ui-sdk/react/switch';
import { Textarea } from '@ui-sdk/react/textarea';
import { Section, Specimen } from '../Specimen';

const OWNERS = ['Ada Okafor', 'Bram Visser', 'Chen Liu', 'Divya Raman', 'Elena Sorokina', 'Farid Haddad'];

export function Forms() {
  return (
    <Section id="forms" title="Forms" lede="Label over value, a clear edge at rest, the ring in place of it on focus.">
      <Specimen name="Text field">
        <Field name="company">
          <FieldLabel>Company</FieldLabel>
          <Input defaultValue="Stonebridge Supply" required />
          <FieldDescription>As it appears on invoices.</FieldDescription>
          <FieldError />
        </Field>
      </Specimen>
      <Specimen name="Invalid">
        <Field name="email" invalid>
          <FieldLabel>Email</FieldLabel>
          <Input defaultValue="ada@stonebridge" type="email" />
          <FieldError>Enter a complete address, like ada@stonebridge.co.</FieldError>
        </Field>
      </Specimen>
      <Specimen name="Select">
        <Field>
          <FieldLabel>Stage</FieldLabel>
          <Select name="stage" defaultValue="working">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="working">Working</SelectItem>
              <SelectItem value="qualified">Qualified</SelectItem>
              <SelectItem value="lost">Lost</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Specimen>
      <Specimen name="Combobox">
        <Field>
          <FieldLabel>Owner</FieldLabel>
          <Combobox name="owner">
            <ComboboxInput placeholder="Search people" />
            <ComboboxContent>
              <ComboboxEmpty>No one by that name.</ComboboxEmpty>
              <ComboboxList>
                {OWNERS.map((owner) => (
                  <ComboboxItem key={owner} value={owner}>
                    {owner}
                  </ComboboxItem>
                ))}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </Field>
      </Specimen>
      <Specimen name="Date picker">
        <Field>
          <FieldLabel>Follow up on</FieldLabel>
          <DatePicker defaultValue="2026-11-20">
            <div>
              <DatePickerInput />
              <DatePickerTrigger aria-label="Choose a date" />
            </div>
            <DatePickerContent />
          </DatePicker>
        </Field>
      </Specimen>
      <Specimen name="Number">
        <Field>
          <FieldLabel>Seats</FieldLabel>
          <NumberInput defaultValue={12} min={1} max={500}>
            <NumberInputGroup>
              <NumberInputDecrement aria-label="Fewer seats" />
              <NumberInputControl />
              <NumberInputIncrement aria-label="More seats" />
            </NumberInputGroup>
          </NumberInput>
        </Field>
      </Specimen>
      <Specimen name="Password">
        <Field>
          <FieldLabel>Password</FieldLabel>
          <PasswordInput name="password" defaultValue="correct horse">
            <PasswordInputControl />
            <PasswordInputToggle aria-label="Show password" />
          </PasswordInput>
        </Field>
      </Specimen>
      <Specimen name="Textarea">
        <Field>
          <FieldLabel>Notes</FieldLabel>
          <Textarea name="notes" placeholder="What did they ask for?" />
        </Field>
      </Specimen>
      <Specimen name="Choices">
        <div data-part="stack">
          <Field>
            <Checkbox name="newsletter" defaultChecked>
              <CheckboxIndicator />
            </Checkbox>
            <FieldLabel>Send the weekly digest</FieldLabel>
          </Field>
          <Field>
            <Switch name="notify" defaultChecked>
              <SwitchThumb />
            </Switch>
            <FieldLabel>Notify the owner</FieldLabel>
          </Field>
          <Field>
            <FieldLabel>Priority</FieldLabel>
            <RadioGroup name="priority" defaultValue="normal">
              {['Low', 'Normal', 'Urgent'].map((label) => (
                <label key={label}>
                  <Radio value={label.toLowerCase()}>
                    <RadioIndicator />
                  </Radio>
                  {label}
                </label>
              ))}
            </RadioGroup>
          </Field>
        </div>
      </Specimen>
      <Specimen name="Segmented control">
        <SegmentedControl aria-label="View" defaultValue="list">
          <SegmentedControlIndicator />
          <SegmentedControlItem value="list">List</SegmentedControlItem>
          <SegmentedControlItem value="board">Board</SegmentedControlItem>
          <SegmentedControlItem value="calendar">Calendar</SegmentedControlItem>
        </SegmentedControl>
      </Specimen>
      <Specimen name="Slider">
        <Slider defaultValue={60}>
          <SliderValue />
          <SliderControl>
            <SliderTrack>
              <SliderIndicator />
              <SliderThumb aria-label="Win probability" />
            </SliderTrack>
          </SliderControl>
        </Slider>
      </Specimen>
      <Specimen name="One-time code">
        <OTPInput maxLength={6} aria-label="Verification code" defaultValue="402">
          <OTPInputGroup>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <OTPInputSlot key={index} index={index} />
            ))}
          </OTPInputGroup>
        </OTPInput>
      </Specimen>
    </Section>
  );
}
