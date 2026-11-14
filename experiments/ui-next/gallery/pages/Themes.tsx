import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { useEffect, useRef } from 'react';
import {
  Button,
  Chart,
  type Column,
  DataTable,
  FormGrid,
  FormSection,
  Properties,
  SelectField,
  Stats,
  Status,
  TextField,
  type Tone,
  wearTheme,
} from '../../src';
import { type Look, LOOKS, PALETTES, RECIPE_MENU, RECIPE_PARTS, type Rhythm, worn } from '../theme';
import { setDress, useDress } from '../theming';

/* The theme bench. Everything here is mistri's: the looks, the palettes and the recipe menu are read from the
   engine, and a choice is worn the way an App's `defineTheme` is. Nothing on this page is styled for a look. */

type Home = { id: string; home: string; resident: string; rent: number; state: string; tone: Tone };
const HOMES: Home[] = [
  { id: '1', home: 'Alder Court #101', resident: 'Maya Lin', rent: 1285, state: 'Paid', tone: 'good' },
  { id: '2', home: 'Alder Court #204', resident: 'Jonas Weber', rent: 1410, state: 'Due', tone: 'warning' },
  { id: '3', home: 'Birch House #102', resident: 'Tomasz Baran', rent: 990, state: 'Late', tone: 'critical' },
  { id: '4', home: 'Cedar Row #7', resident: 'Ines Duarte', rent: 1620, state: 'Paid', tone: 'good' },
];
const COLUMNS: Column<Home>[] = [
  { id: 'home', header: 'Home', primary: true, cell: (row) => row.home, sort: (row) => row.home },
  { id: 'resident', header: 'Resident', cell: (row) => row.resident, sort: (row) => row.resident },
  { id: 'rent', header: 'Rent', align: 'end', cell: (row) => `$${row.rent.toLocaleString()}`, sort: (row) => row.rent },
  { id: 'state', header: 'State', cell: (row) => <Status tone={row.tone}>{row.state}</Status> },
];

/* One of everything a recipe dresses, small enough to stand twice on a page. */
function Specimen({ name, pane }: { name: string; pane?: boolean }) {
  /* A section is a landmark, named by its title: the same specimen stands several times on this page. */
  const titled = (title: string) => (pane ? `${title} in ${name}` : title);
  return (
    <div data-part="theme-specimen">
      <Stats
        items={[
          { label: 'Collected', value: '$48,210', note: '92% of what is due', share: 0.92 },
          { label: 'Open repairs', value: '9', tone: 'warning', note: '2 urgent' },
          { label: 'Occupied', value: '53 of 56' },
        ]}
      />
      <Tabs defaultValue="homes">
        <TabsList aria-label={`${name}: what is shown`}>
          <TabsTab value="homes">Homes</TabsTab>
          <TabsTab value="money">Money</TabsTab>
          <TabsTab value="form">A form</TabsTab>
          <TabsIndicator />
        </TabsList>
        <TabsPanel value="homes">
          <DataTable label={`${name}: homes`} columns={COLUMNS} rows={HOMES} rowKey={(row) => row.id} rowName={(row) => row.home} />
        </TabsPanel>
        <TabsPanel value="money">
          <Chart
            title="Rent collected"
            note="By month, in dollars"
            headingLevel={3}
            height={180}
            categories={['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']}
            series={[
              { id: 'paid', label: 'Paid', values: [41200, 43900, 44100, 46800, 47500, 48210] },
              { id: 'late', label: 'Late', values: [3900, 2800, 3100, 2200, 1900, 4100] },
              { id: 'fees', label: 'Fees', values: [300, 225, 300, 150, 150, 375] },
            ]}
          />
        </TabsPanel>
        <TabsPanel value="form">
          <FormSection title={titled('Resident')} description="Who the lease is with.">
            <FormGrid>
              <TextField label="Name" name={`${name}-name`} defaultValue="Maya Lin" required />
              <TextField label="Email" name={`${name}-email`} type="email" defaultValue="maya@example.com" />
            </FormGrid>
          </FormSection>
        </TabsPanel>
      </Tabs>
      <Properties
        title={titled('Home')}
        name="Alder Court #101"
        items={[
          { label: 'Building', value: 'Alder Court' },
          { label: 'Rent', value: '$1,285' },
          { label: 'State', value: <Status tone="good">Active</Status> },
        ]}
      />
      <div data-part="theme-actions">
        <Button intent="primary">Record a payment</Button>
        <Button>Send a reminder</Button>
        <Button intent="quiet">Skip</Button>
      </div>
    </div>
  );
}

/* A part of the page in a theme of its own, whatever the page wears: the theme is put on this element. */
function Worn({ look, palette, mode }: { look: Look; palette?: string; mode: 'light' | 'dark' }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = box.current;
    if (!on) return;
    wearTheme(worn(look, palette), on);
    return () => wearTheme(null, on);
  }, [look, palette]);
  return (
    <section ref={box} data-part="theme-pane" style={{ colorScheme: mode }} aria-label={`${look}, ${mode}`}>
      <h3>
        {look} <span>{mode}</span>
      </h3>
      <Specimen name={`${look}, ${mode}`} pane />
    </section>
  );
}

const sentence = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).replace(/-/g, ' ');

export function Themes() {
  const dress = useDress();
  const themed = dress.look !== 'own';
  const base = themed ? (worn(dress.look, dress.palette)?.attributes ?? {}) : {};
  return (
    <div data-slot="form-page">
      <header data-slot="list-head">
        <h1>Themes</h1>
      </header>
      <p data-part="theme-lead">
        ui-next has no theme language of its own. It wears mistri&apos;s: the five looks, the twelve palettes and the recipes an App picks
        in <code>defineTheme</code> are read here from the engine and worn as the same attributes and tokens mistri puts on a page. Pick a
        look and the whole gallery changes clothes; every other room is the same code.
      </p>
      <FormSection title="What the gallery wears" description="Kept for your next visit. Mode and density are in Appearance.">
        <FormGrid>
          <SelectField
            label="Look"
            name="look"
            value={dress.look}
            onValueChange={(value) => typeof value === 'string' && setDress({ look: value as Look | 'own' })}
            options={[{ value: 'own', label: "ui-next's own" }, ...LOOKS.map((look) => ({ value: look, label: sentence(look) }))]}
          />
          <SelectField
            label="Palette"
            name="palette"
            value={themed ? dress.palette : 'default'}
            disabled={!themed}
            hint={themed ? undefined : 'A palette is a look’s to wear: pick a look first.'}
            onValueChange={(value) => typeof value === 'string' && setDress({ palette: value })}
            options={[{ value: 'default', label: 'The look’s own' }, ...PALETTES.map((one) => ({ value: one.id, label: one.label }))]}
          />
          <SelectField
            label="Rhythm"
            name="rhythm"
            value={themed ? dress.rhythm : 'house'}
            disabled={!themed}
            hint="How far apart things stand: the page's air, never a control's own padding."
            onValueChange={(value) => typeof value === 'string' && setDress({ rhythm: value as Rhythm })}
            options={[
              { value: 'house', label: 'House' },
              { value: 'tight', label: 'Tight, a quarter closer' },
              { value: 'airy', label: 'Airy, a quarter wider' },
            ]}
          />
        </FormGrid>
      </FormSection>
      {themed && (
        <FormSection
          title="Recipes"
          description="One treatment a part, from mistri's menu. A look picks each; an App's theme picks over it, and so can you."
        >
          <div data-part="theme-recipes">
            {RECIPE_PARTS.map((part) => {
              const attribute = `data-look-${part.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
              const own = base[attribute];
              return (
                <SelectField
                  key={part}
                  label={sentence(part.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`))}
                  name={`recipe-${part}`}
                  value={dress.recipes[part] ?? own ?? null}
                  onValueChange={(value) => {
                    if (typeof value !== 'string') return;
                    const { [part]: _dropped, ...rest } = dress.recipes;
                    setDress({ recipes: value === own ? rest : { ...rest, [part]: value } });
                  }}
                  options={Object.keys(RECIPE_MENU[part]).map((value) => ({ value, label: sentence(value) }))}
                />
              );
            })}
          </div>
          <div data-part="theme-actions">
            <Button disabled={Object.keys(dress.recipes).length === 0} onClick={() => setDress({ recipes: {} })}>
              Back to the look&apos;s own
            </Button>
          </div>
        </FormSection>
      )}
      <FormSection title="As it is worn" description="The parts a recipe dresses, in what the gallery wears now.">
        <Specimen name="Worn" />
      </FormSection>
      <FormSection
        title="Side by side"
        description="A theme is read from whatever wears it, so a part of a page can wear another: a preview beside the real thing, a tenant's brand in one panel. Each of these is the same specimen."
      >
        <div data-part="theme-panes">
          <Worn look="lumen" mode="light" />
          <Worn look="sage" mode="light" />
          <Worn look="mono" mode="light" />
          <Worn look="workshop" mode="light" />
          <Worn look="ledger" mode="light" />
          <Worn look="ledger" mode="dark" />
        </div>
      </FormSection>
    </div>
  );
}
