import { toast } from '@ui-sdk/react/toast';
import { useEffect, useId } from 'react';
import {
  Button,
  ChoiceField,
  DateField,
  FileField,
  FormGrid,
  FormProblems,
  MoneyField,
  NumberField,
  SelectField,
  SidePanel,
  SwitchField,
  TextAreaField,
  TextField,
  useForm,
} from '../../src';

const BUILDINGS = ['Alder Court', 'Birch House', 'Cedar Mews'].map((name) => ({ value: name, label: name }));

const BEDS = [
  { value: '0', label: 'Studio' },
  { value: '1', label: '1 bed' },
  { value: '2', label: '2 beds' },
  { value: '3', label: '3 beds' },
];

/* Codes a home already has, as a server would know them: sending one of these is refused, a moment later. */
const TAKEN = new Set(['AC-101', 'AC-102', 'AC-107']);

export function NewHome({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId();
  /* The form holds what goes wrong. The plain mistakes are caught before anything is sent; the code being taken is
     something only whoever keeps the homes can say, so it comes back a moment later and lands on its field. */
  const hold = useForm({
    validate: (said) => ({
      code: /^[A-Z]{2}-\d{3}$/.test(said.code ?? '') ? undefined : 'A code is two letters, a dash and three digits: AC-108.',
      rent: Number(said.rent) > 0 ? undefined : 'Say what the rent is.',
    }),
    submit: async (said) => {
      await new Promise((done) => setTimeout(done, 900));
      if (TAKEN.has(said.code ?? '')) return { fields: { code: `${said.code} is already a home. Try the next number.` } };
      onOpenChange(false);
      toast.success('Home added', { description: `${said.code} is on the rent roll.` });
      return undefined;
    },
  });
  useEffect(() => {
    if (open) hold.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <SidePanel
      open={open}
      onOpenChange={onOpenChange}
      unsaved={hold.touched}
      title="New home"
      description="It joins the rent roll as vacant until a lease starts."
      footer={
        <>
          <Button intent="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button intent="primary" type="submit" form={id} busy={hold.busy}>
            Add home
          </Button>
        </>
      }
    >
      <form id={id} data-slot="form" {...hold.form}>
        <FormProblems hold={hold} labels={{ code: 'Code', rent: 'Asking rent' }} />
        <FormGrid>
          <TextField
            label="Code"
            name="code"
            defaultValue="AC-107"
            required
            hint="Shown on leases and charges."
            error={hold.problem('code')}
          />
          <SelectField label="Building" name="building" options={BUILDINGS} defaultValue="Alder Court" />
        </FormGrid>
        <ChoiceField label="Beds" name="beds" options={BEDS} defaultValue="1" />
        <FormGrid>
          <NumberField label="Size" name="size" defaultValue={690} min={100} suffix="sq ft" />
          <MoneyField label="Asking rent" name="rent" defaultValue={1495} suffix="/ month" error={hold.problem('rent')} />
        </FormGrid>
        <DateField label="Available from" name="available" defaultValue="2026-12-01" />
        <SwitchField label="Advertise online" name="listed" hint="Lists it on Homes to let once it has a photo." defaultChecked />
        <FileField label="Photos" name="photos" accept="image/*" multiple optional prompt="Drop photos here, or" />
        <TextAreaField label="Notes" name="notes" optional placeholder="Anything a viewing agent should know" />
      </form>
    </SidePanel>
  );
}
