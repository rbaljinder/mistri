/**
 * A warehouse's floor as its bin codes lay it out: each pick aisle a block
 * of bays across and levels up (`RNO-A-07-2` is aisle A, bay 7, level 2),
 * then the reserve's pallet positions and the receiving dock. Each bin is
 * shaded by how full it is — its units against its capacity — and opens as
 * a peek, so a lead sees where the space is and where the stock is at once.
 *
 * It only draws. The bins are the section's declared read (warehouseBins in
 * pages/warehouse.ts), planned and authorized like any related list; the
 * shade is the accent mixed into the surface by the fill, so every look and
 * both modes dress it.
 */
import { Empty, useFormat, useNavigate, useSectionSize, type SectionProps } from '@mistriwork/mistri/ui';
import type { Rows } from '../mistri-schema.d.ts';
import type { warehouseBins } from '../pages/warehouse.ts';
import './BinMap.css';

type Props = SectionProps<typeof warehouseBins, Rows, 'warehouse'>;
type Bin = Props['rows']['bins'][number];

/** Where a bin stands, read from its code after the warehouse's prefix: a pick face, a reserve position or the dock. */
export function placeOf(
  code: string,
): { kind: 'pick'; aisle: string; bay: number; level: number } | { kind: 'reserve'; bay: number } | { kind: 'dock' } | undefined {
  const parts = code.split('-').slice(1);
  if (parts[0] === 'DOCK') return { kind: 'dock' };
  if (parts[0] === 'R' && parts.length === 2) return { kind: 'reserve', bay: Number(parts[1]) };
  if (parts.length === 3 && /^[A-Z]+$/.test(parts[0]))
    return { kind: 'pick', aisle: parts[0], bay: Number(parts[1]), level: Number(parts[2]) };
  return undefined;
}

/** How full a bin is, 0 to 1: its units against its capacity. */
export const fillOf = (bin: Pick<Bin, 'capacity' | 'units'>) => {
  const capacity = Number(bin.capacity);
  const units = Number(bin.units ?? 0);
  return capacity > 0 ? Math.max(0, Math.min(1, units / capacity)) : 0;
};

/* How much of the accent a bin's shade takes, 0 to 100. A straight mix left
   a warehouse at a few percent of capacity one flat pale field — a bin a
   tenth full a shade from an empty one — so any stock starts at a visible
   step and the square root spreads the low fills apart, the way an area
   reads; a full bin is the accent itself. */
export const shadeOf = (fill: number) => (fill > 0 ? Math.round(12 + 88 * Math.sqrt(fill)) : 0);

/* A bin is its shade alone. Its bay is said once, over its column, and its
   level at its row's start, as a matrix's heads are: a figure on every bin
   needed a chip of surface behind it to read over the mid shades, a second
   shape inside each one. */
function Cell({ bin, open }: { bin: Bin; open: (bin: Bin) => void }) {
  const format = useFormat();
  const shade = shadeOf(fillOf(bin));
  const said = `${bin.code}: ${format.number(Number(bin.units ?? 0))} of ${format.number(Number(bin.capacity))} units${bin.active ? '' : ', inactive'}`;
  return (
    <button
      type="button"
      className="c-bin-map-bin"
      data-empty={Number(bin.units ?? 0) === 0 ? 'true' : undefined}
      data-inactive={bin.active ? undefined : 'true'}
      style={{ ['--c-bin-map-shade' as string]: `${shade}%` }}
      title={said}
      aria-label={said}
      onClick={() => open(bin)}
    ></button>
  );
}

export default function BinMap({ rows }: Props) {
  const { compact } = useSectionSize();
  const { openRecord } = useNavigate();
  const format = useFormat();
  const bins = rows.bins;
  if (!bins.length) return <Empty title="This warehouse has no bins yet." />;
  const open = (bin: Bin) => openRecord('bin', { id: bin.id }, { mode: 'drawer', label: String(bin.code) });
  const aisles = new Map<string, Map<number, Map<number, Bin>>>();
  const reserve: Array<[number, Bin]> = [];
  const dock: Bin[] = [];
  for (const bin of bins) {
    const place = placeOf(String(bin.code));
    if (place?.kind === 'pick') {
      const bays = aisles.get(place.aisle) ?? new Map<number, Map<number, Bin>>();
      aisles.set(place.aisle, bays);
      const levels = bays.get(place.bay) ?? new Map<number, Bin>();
      bays.set(place.bay, levels);
      levels.set(place.level, bin);
    } else if (place?.kind === 'reserve') reserve.push([place.bay, bin]);
    else if (place?.kind === 'dock') dock.push(bin);
  }
  const units = bins.reduce((sum, bin) => sum + Number(bin.units ?? 0), 0);
  const capacity = bins.reduce((sum, bin) => sum + Number(bin.capacity ?? 0), 0);
  return (
    <div className="c-bin-map" data-compact={compact ? 'true' : undefined}>
      <p className="c-bin-map-summary">
        {format.number(units)} units in {format.number(bins.length)} bins, {format.percent(capacity ? (units / capacity) * 100 : 0)} of
        capacity.
      </p>
      <div className="c-bin-map-aisles">
        {[...aisles]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([aisle, bays]) => {
            const bayNumbers = [...bays.keys()].sort((a, b) => a - b);
            const levels = [...new Set([...bays.values()].flatMap((level) => [...level.keys()]))].sort((a, b) => b - a);
            return (
              <section key={aisle} className="c-bin-map-aisle" aria-label={`Aisle ${aisle}`}>
                <h4 className="c-bin-map-aisle-name">Aisle {aisle}</h4>
                <div className="c-bin-map-grid" style={{ gridTemplateColumns: `auto repeat(${bayNumbers.length}, minmax(0, 1fr))` }}>
                  <span aria-hidden="true" />
                  {bayNumbers.map((bay) => (
                    <span key={`b${bay}`} className="c-bin-map-bay" aria-hidden="true">
                      {bay}
                    </span>
                  ))}
                  {levels.map((level) => [
                    <span key={`l${level}`} className="c-bin-map-level" aria-hidden="true">
                      {level}
                    </span>,
                    ...bayNumbers.map((bay) => {
                      const bin = bays.get(bay)?.get(level);
                      return bin ? <Cell key={`${bay}-${level}`} bin={bin} open={open} /> : <span key={`${bay}-${level}`} />;
                    }),
                  ])}
                </div>
              </section>
            );
          })}
      </div>
      {(reserve.length > 0 || dock.length > 0) && (
        <div className="c-bin-map-floor">
          {reserve.length > 0 && (
            <section className="c-bin-map-aisle" aria-label="Reserve">
              <h4 className="c-bin-map-aisle-name">Reserve</h4>
              <div className="c-bin-map-grid" style={{ gridTemplateColumns: `repeat(${reserve.length}, minmax(0, 1fr))` }}>
                {reserve
                  .sort(([a], [b]) => a - b)
                  .map(([bay]) => (
                    <span key={`b${bay}`} className="c-bin-map-bay" aria-hidden="true">
                      {bay}
                    </span>
                  ))}
                {reserve.map(([, bin]) => (
                  <Cell key={String(bin.id)} bin={bin} open={open} />
                ))}
              </div>
            </section>
          )}
          {dock.map((bin) => (
            <section key={String(bin.id)} className="c-bin-map-aisle c-bin-map-dock" aria-label="Receiving dock">
              <h4 className="c-bin-map-aisle-name">Dock</h4>
              <div className="c-bin-map-row">
                <Cell bin={bin} open={open} />
              </div>
            </section>
          ))}
        </div>
      )}
      <p className="c-bin-map-legend" aria-hidden="true">
        <span className="c-bin-map-swatch" data-empty="true" /> Empty
        <span className="c-bin-map-swatch" style={{ ['--c-bin-map-shade' as string]: `${shadeOf(0.5)}%` }} /> Half
        <span className="c-bin-map-swatch" style={{ ['--c-bin-map-shade' as string]: `${shadeOf(1)}%` }} /> Full
      </p>
    </div>
  );
}
