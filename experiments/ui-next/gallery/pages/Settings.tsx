import { toast } from '@ui-sdk/react/toast';
import {
  ActionBar,
  Button,
  CheckField,
  ComboField,
  FormGrid,
  FormSection,
  MoneyField,
  SelectField,
  SensitiveField,
  SliderField,
  SwitchField,
  TextField,
} from '../../src';

const ZONES = ['America/Denver', 'America/Chicago', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Amsterdam'].map(
  (zone) => ({ value: zone, label: zone.replace('_', ' ') }),
);

export function Settings() {
  return (
    <form data-slot="form-page" onSubmit={(event) => event.preventDefault()}>
      <header data-slot="list-head">
        <h1>Settings</h1>
      </header>
      <FormSection title="Organization" description="Who residents hear from, and where replies go.">
        <TextField label="Name" name="name" defaultValue="Lintel Property Co." required />
        <FormGrid>
          <TextField label="Reply-to email" name="email" type="email" defaultValue="office@lintel.example" />
          <TextField label="Phone" name="phone" type="tel" defaultValue="(720) 555-0100" optional />
        </FormGrid>
        <ComboField label="Time zone" name="zone" options={ZONES} defaultValue="America/Denver" hint="Due dates and reminders follow it." />
      </FormSection>
      <FormSection title="Rent" description="What a late payment costs, and when it starts to.">
        <FormGrid>
          <MoneyField label="Late fee" name="fee" defaultValue={75} />
          <SelectField
            label="Charged"
            name="when"
            defaultValue="once"
            options={[
              { value: 'once', label: 'Once per missed payment' },
              { value: 'weekly', label: 'Every week it stays open' },
            ]}
          />
        </FormGrid>
        <SliderField label="Grace period, in days" name="grace" defaultValue={5} min={0} max={14} />
        <SelectField
          label="Accepted payments"
          name="methods"
          multiple
          defaultValue={['transfer', 'card']}
          options={[
            { value: 'transfer', label: 'Bank transfer' },
            { value: 'card', label: 'Card' },
            { value: 'cheque', label: 'Cheque' },
            { value: 'cash', label: 'Cash' },
          ]}
        />
      </FormSection>
      <FormSection title="Notifications" description="What the office is told about, as it happens.">
        <SwitchField label="A payment arrives" name="paid" hint="One message per payment." defaultChecked />
        <SwitchField label="A repair is reported" name="repair" hint="With the photos the resident attached." defaultChecked />
        <SwitchField label="A lease is 60 days from its end" name="ending" />
        <CheckField label="Send a weekly digest too" name="digest" hint="Mondays at 8am, in the organization’s time zone." defaultChecked />
      </FormSection>
      <FormSection title="Bank feed" description="The key the bank gave you. It is shown once and kept encrypted.">
        <SensitiveField
          label="API key"
          name="key"
          defaultValue="lk_live_8fj29dkeo3"
          error="The bank refused this key on the last sync. Paste a new one."
        />
      </FormSection>
      <ActionBar note="Changed 2 minutes ago, not saved">
        <Button intent="quiet">Discard</Button>
        <Button intent="primary" onClick={() => toast.success('Settings saved')}>
          Save changes
        </Button>
      </ActionBar>
    </form>
  );
}
