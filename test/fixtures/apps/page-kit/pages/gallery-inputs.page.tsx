/** Runtime gallery page for all input and editor primitives (`/gallery-inputs`). */
import { Card, Stack, definePage, useState } from '@mistriwork/mistri/page';
import {
  CheckCards,
  Checkbox,
  ChoiceCards,
  CodeEditor,
  FileField,
  FormColumns,
  Input,
  JsonEditor,
  KeyValueEditor,
  LineItemsEditor,
  MaskedField,
  MoneyField,
  NumberInput,
  OTPInput,
  PasswordInput,
  SensitiveField,
  Slider,
  Switch,
  TagInput,
  TextArea,
  TextField,
  TokenInput,
  YesNo,
} from '@mistriwork/mistri/primitives';
import { Icon } from '@mistriwork/mistri/ui';

export default definePage({
  label: 'Gallery inputs',
  nav: false,
  reads: ['deal'],
  component: GalleryInputs,
});

function GalleryInputs() {
  const [email, setEmail] = useState('ops@fieldline.example');
  const [secret, setSecret] = useState('CorrectHorse99!');
  const [apiKey, setApiKey] = useState('9847654321');
  const [qty, setQty] = useState<number | null>(12);
  const [amount, setAmount] = useState('1250.50');
  const [phone, setPhone] = useState('4155550192');
  const [title, setTitle] = useState('Pump seal inspection');
  const [notes, setNotes] = useState('Replace worn gasket on unit 4B.');
  const [tags, setTags] = useState<string[]>(['hydraulics', 'urgent']);
  const [tokens, setTokens] = useState<string[]>(['status:open', 'zone:north']);
  const [otp, setOtp] = useState('482910');
  const [file, setFile] = useState<File | null>(null);
  const [slider, setSlider] = useState(65);
  const [checked, setChecked] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [yesNo, setYesNo] = useState<'yes' | 'no' | ''>('yes');
  const [choices, setChoices] = useState<string[]>(['dispatch']);
  const [checks, setChecks] = useState<string[]>(['safety']);
  const [code, setCode] = useState('SELECT id, stage, amount FROM deal WHERE amount > 10000;');
  const [json, setJson] = useState('{"service":"fieldline","concurrency":4}');
  const [kv, setKv] = useState([
    { id: '1', key: 'REGION', value: 'us-west' },
    { id: '2', key: 'RETENTION_DAYS', value: '90' },
  ]);
  const [items, setItems] = useState([
    { id: '1', description: 'Bearing assembly', quantity: 2, unitPrice: 145 },
    { id: '2', description: 'Pressure test', quantity: 1, unitPrice: 95 },
  ]);

  return (
    <Stack>
      <Card title="Adorned single-box text and numeric fields">
        <FormColumns columns={2}>
          <div data-gallery-field="adorned-input">
            <Input label="Dispatch email" leadingIcon={<Icon name="envelope" />} clearable value={email} onValueChange={setEmail} />
          </div>
          <div data-gallery-field="invalid-input">
            <Input
              label="Invalid reference"
              leadingIcon={<Icon name="hash" />}
              value="bad-ref"
              error="Enter a six-digit ticket code."
              invalid
              onValueChange={() => {}}
            />
          </div>
          <div data-gallery-field="password-input">
            <PasswordInput label="Operator password" value={secret} copyable onValueChange={setSecret} />
          </div>
          <div data-gallery-field="sensitive-field">
            <SensitiveField
              label="Webhook signing PIN"
              mask="digits"
              value={apiKey}
              onValueChange={setApiKey}
              showLabel="Show"
              hideLabel="Hide"
            />
          </div>
          <div data-gallery-field="number-input">
            <NumberInput label="Crew headcount" value={qty} min={0} max={500} step={1} onValueChange={setQty} />
          </div>
          <div data-gallery-field="money-field">
            <MoneyField label="Quoted service fee" symbol="$" value={amount} onValueChange={setAmount} />
          </div>
          <div data-gallery-field="masked-field">
            <MaskedField label="On-call phone" mask="phone" value={phone} onValueChange={setPhone} />
          </div>
          <div data-gallery-field="text-field">
            <TextField label="Work order summary" required value={title} onValueChange={setTitle} />
          </div>
        </FormColumns>
      </Card>

      <Card title="Token, tag, OTP, and multiline controls">
        <FormColumns columns={2}>
          <div data-gallery-field="tag-input">
            <TagInput
              label="Equipment tags"
              value={tags}
              onValueChange={(next) => setTags(next.map((t) => (typeof t === 'string' ? t : t.label)))}
              placeholder="Add tag"
            />
          </div>
          <div data-gallery-field="token-input">
            <TokenInput
              label="Filter tokens"
              value={tokens}
              onValueChange={(next) => setTokens(next.map((t) => (typeof t === 'string' ? t : t.label)))}
              placeholder="Add filter"
            />
          </div>
          <div>
            <OTPInput label="Verification code" length={6} value={otp} onValueChange={setOtp} />
          </div>
          <div>
            <FileField label="Inspection attachment" value={file} onValueChange={setFile} />
          </div>
        </FormColumns>
        <TextArea label="Field technician notes" rows={3} value={notes} onValueChange={setNotes} />
      </Card>

      <Card title="Boolean, range, and card choices">
        <FormColumns columns={2}>
          <Checkbox label="Require supervisor sign-off" checked={checked} onCheckedChange={setChecked} />
          <Switch label="Live telemetry sync" checked={enabled} onCheckedChange={setEnabled} />
          <YesNo label="Parts stocked on van" value={yesNo} yes="Stocked" no="Backordered" onValueChange={setYesNo} />
          <Slider label="Target load" min={0} max={100} value={slider} onValueChange={setSlider} formatValue={(n) => `${n}%`} />
        </FormColumns>
        <ChoiceCards
          label="Assignment mode"
          value={choices}
          onValueChange={setChoices}
          options={[
            { value: 'dispatch', label: 'Manual dispatch' },
            { value: 'nearest', label: 'Nearest crew' },
          ]}
        />
        <CheckCards
          ariaLabel="Pre-start checks"
          onToggle={(idx, on) => {
            const key = idx === 0 ? 'safety' : 'ppe';
            setChecks((prev) => (on ? [...prev, key] : prev.filter((x) => x !== key)));
          }}
          cards={[
            { key: 'safety', label: 'Lockout verified', help: 'Breaker tagged and tested', on: checks.includes('safety') },
            { key: 'ppe', label: 'PPE inspected', help: 'Gloves and eye shield ready', on: checks.includes('ppe') },
          ]}
        />
      </Card>

      <Card title="Structured, code, and JSON editors">
        <FormColumns columns={2}>
          <CodeEditor label="Diagnostic query" language="sql" value={code} onValueChange={setCode} />
          <JsonEditor label="Adapter payload" value={json} onValueChange={setJson} />
        </FormColumns>
        <KeyValueEditor label="Environment variables" value={kv} onValueChange={setKv} />
        <LineItemsEditor
          label="Invoice line items"
          currency="USD"
          columns={[
            { key: 'description', label: 'Description', kind: 'text', width: '2fr' },
            { key: 'quantity', label: 'Qty', kind: 'number', align: 'end' },
            { key: 'unitPrice', label: 'Unit price', kind: 'money', align: 'end' },
          ]}
          value={items}
          onValueChange={setItems}
        />
      </Card>
    </Stack>
  );
}
