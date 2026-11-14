import { Buildings, House, Stairs } from '@phosphor-icons/react';
import { toast } from '@ui-sdk/react/toast';
import { Accordion, PictureGallery, Tree, type TreeNode } from '../../src';
import { money, UNITS } from '../data';
import { Section, Specimen } from '../Specimen';

/* Lintel's homes as the tree their buildings and floors make: a building's rent is the sum of what is under it. */
const NODES: TreeNode[] = [...new Set(UNITS.map((unit) => unit.building))].map((building) => {
  const inside = UNITS.filter((unit) => unit.building === building);
  const floors = [...new Set(inside.map((unit) => unit.code.split('-')[1]?.[0] ?? '1'))];
  return {
    id: building,
    label: building,
    icon: <Buildings />,
    meta: money(inside.reduce((total, unit) => total + unit.rent, 0)),
    children: floors.map((floor) => {
      const homes = inside.filter((unit) => unit.code.split('-')[1]?.[0] === floor);
      return {
        id: `${building}/${floor}`,
        label: `Floor ${floor}`,
        icon: <Stairs />,
        meta: `${homes.length} homes`,
        children: homes.map((unit) => ({ id: unit.code, label: unit.code, icon: <House />, meta: money(unit.rent) })),
      };
    }),
  };
});

const scene = (hue: number, name: string) => ({
  src: `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 480'><rect width='640' height='480' fill='hsl(${hue} 45% 86%)'/><rect x='170' y='110' width='300' height='370' rx='6' fill='hsl(${hue} 24% 50%)'/><rect x='210' y='160' width='60' height='70' rx='4' fill='hsl(45 90% 78%)'/><rect x='370' y='160' width='60' height='70' rx='4' fill='hsl(${hue} 25% 36%)'/><rect x='290' y='340' width='60' height='140' rx='4' fill='hsl(${hue} 25% 30%)'/></svg>`,
  )}`,
  alt: name,
  caption: `${name}, drawn for the gallery.`,
});
const PICTURES = [
  scene(150, 'Front of the building'),
  scene(210, 'Courtyard side'),
  scene(20, 'Entrance at dusk'),
  scene(280, 'From the street'),
];

export function Presentations() {
  return (
    <Section
      id="presentations"
      title="Other ways to read a list"
      lede="Cards, a list with its detail and a queue are rooms of their own: Homes to let, Residents and Applications. A tree is here."
    >
      <Specimen name="Tree: one stop, arrows through what is open, typing a name goes to it; what is open is remembered" wide>
        <div style={{ maxWidth: '28rem' }}>
          <Tree label="Homes by building" nodes={NODES} open={1} remember="gallery-homes" onOpen={(id) => toast(`${id} would open here`)} />
        </div>
      </Specimen>
      <Specimen name="Accordion: sections that fold, any number open at once">
        <Accordion
          defaultValue={['terms']}
          sections={[
            {
              value: 'terms',
              title: 'Lease terms',
              meta: '4',
              content: 'Twelve months from November 1, rent due on the first, a deposit of one month.',
            },
            { value: 'charges', title: 'Charges', meta: '7', content: 'Seven charges since November, three still open.' },
            { value: 'people', title: 'People on the lease', meta: '2', content: 'Andre Okoye and Maya Lin.' },
          ]}
        />
      </Specimen>
      <Specimen name="Pictures: a tile opens large, arrows go from one to the next">
        <PictureGallery label="Alder Court" pictures={PICTURES} />
      </Specimen>
    </Section>
  );
}
