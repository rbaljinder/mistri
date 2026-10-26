/**
 * The bin map's examples: a small building — two aisles of four bays on
 * three levels, a reserve and a dock — filled unevenly, at a desk and on a
 * phone. Storybook draws each as a story, and BinMap.test.tsx checks them.
 */
import { example, examples, fixtures } from '@mistriwork/mistri/ui/testing';
import { warehouseBins } from '../pages/warehouse.ts';
import BinMap from './BinMap.tsx';

const bins: Array<Record<string, unknown>> = [];
let id = 0;
for (const aisle of ['A', 'B'])
  for (let bay = 1; bay <= 4; bay++)
    for (let level = 1; level <= 3; level++) {
      id += 1;
      bins.push({
        id,
        code: `ABE-${aisle}-0${bay}-${level}`,
        zone: 'pick',
        capacity: 120,
        units: (id * 37) % 130,
        active: !(aisle === 'B' && bay === 4 && level === 3),
      });
    }
bins.push({ id: 100, code: 'ABE-R-01', zone: 'reserve', capacity: 600, units: 420, active: true });
bins.push({ id: 101, code: 'ABE-R-02', zone: 'reserve', capacity: 600, units: 0, active: true });
bins.push({ id: 102, code: 'ABE-DOCK', zone: 'receiving', capacity: 2000, units: 150, active: true });

export default examples(BinMap, warehouseBins, { data: fixtures({ bin: bins }) });

export const Desk = example({ width: 960 });
export const Phone = example({ width: 360, mode: 'dark' });
