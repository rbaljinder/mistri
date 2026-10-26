import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { AppBoardList } from '../../packages/mistri/src/shared/appModel.js';
import { BoardList } from '../../packages/mistri/src/client/components/BoardList.js';
import { applicationFixture } from '../mocks/core.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const opportunity: TableMeta = {
  id: 'opportunity',
  name: 'opportunity',
  schema: '',
  isView: false,
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT', { nullable: false }),
    col('stage', 'TEXT', { nullable: false, allowed: ['qualified', 'proposal', 'negotiation', 'won'] }),
    col('segment', 'TEXT', { allowed: ['Enterprise', 'Mid-market', 'Startup'] }),
    col('amount', 'NUMERIC'),
    col('closes_on', 'DATE'),
    col('owner', 'TEXT'),
  ] as TableMeta['columns'],
};

const rows = [
  ['Harborview Health renewal', 'qualified', 'Enterprise', 148_000, '2026-11-18', 'Maya Chen'],
  ['Lakeside Logistics pilot', 'qualified', 'Mid-market', 36_500, '2026-12-04', 'Owen Brooks'],
  ['Brightpath onboarding suite', 'proposal', 'Startup', 18_900, '2026-10-30', 'Priya Shah'],
  ['Cascade Foods expansion', 'proposal', 'Enterprise', 212_000, '2026-11-12', 'Noah Williams'],
  ['Summit Credit Union platform', 'negotiation', 'Enterprise', 305_000, '2026-10-24', 'Maya Chen'],
  ['Redwood Dental group', 'negotiation', 'Mid-market', 52_400, '2026-10-29', 'Elena Rossi'],
  ['Pioneer Outfitters', 'won', 'Mid-market', 41_250, '2026-10-02', 'Owen Brooks'],
].map(([name, stage, segment, amount, closes_on, owner], i) => ({ id: i + 1, name, stage, segment, amount, closes_on, owner }));

/* `category` is the colored tag over the title, in the color its display rule's `colors` gives the value; `footer` is
   up to four facts along the card's foot, each with an optional mark, and a person stands at its right end. */
const spec: AppBoardList = {
  kind: 'board',
  by: 'stage',
  primary: 'name',
  category: 'segment',
  footer: [{ column: 'amount', icon: 'currency-dollar' }, { column: 'closes_on', icon: 'calendar' }, { column: 'owner' }],
};

const setup = (writable: boolean) => async () => {
  await applicationFixture({
    tables: [opportunity],
    writable,
    app: {
      id: 'sales',
      name: 'Sales',
      ui: {},
      nav: [],
      views: {},
      resources: {
        opportunity: {
          table: 'opportunity',
          display: {
            amount: { format: 'money', currency: 'USD' },
            owner: { avatar: true },
            segment: { colors: { Enterprise: 1, 'Mid-market': 2, Startup: 3 } },
            stage: { tone: { qualified: 'info', proposal: 'warn', negotiation: 'warn', won: 'good' } },
          },
        },
      },
    },
  });
};

const meta = {
  title: 'Lists/Board cards',
  component: BoardList,
  args: { table: opportunity, rows, spec, label: 'Opportunities' },
  beforeEach: setup(true),
} satisfies Meta<typeof BoardList>;
export default meta;

export const CategoryAndFooter: StoryObj<typeof meta> = {};
/* Without `category` or `footer` the same board keeps to its title and one line. */
export const Plain: StoryObj<typeof meta> = { args: { spec: { kind: 'board', by: 'stage', primary: 'name', lines: ['owner'] } } };
export const ReadOnly: StoryObj<typeof meta> = { args: { interactive: false }, beforeEach: setup(false) };
