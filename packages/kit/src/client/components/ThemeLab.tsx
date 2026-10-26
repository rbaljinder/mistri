import { useEffect, useRef, useState } from 'react';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { Dropdown } from './Dropdown.js';
import { DonutChart, LineChart } from './Chart.js';
import { GridSkeleton } from './Skeleton.js';
import { setTheme, themeChoice } from '../theme.js';
import {
  setVisualPalette,
  visualPaletteChoice,
  visualPaletteOptions,
  setVisualTheme,
  visualThemeChoice,
  visualThemeOptions,
  VISUAL_THEME_EVENT,
  VISUAL_THEME_REGISTRY_EVENT,
} from '../visualTheme.js';
import { say } from '../copy/workbench/components/ThemeLab.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

const SERIES = [
  { key: '2026-01', value: 12 },
  { key: '2026-02', value: 19 },
  { key: '2026-03', value: 16 },
  { key: '2026-04', value: 28 },
];

/** Shared controls and deterministic sample data; no business API requests. */
export function ThemeLab({ onDone }: { onDone: () => void }) {
  const modal = useRef<ModalHandle>(null);
  const chart = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(480);
  const [, refresh] = useState(0);
  const [name, setName] = useState('Northwind');
  const [status, setStatus] = useState('active');
  const [confirmation, setConfirmation] = useState(false);
  const after = (write: () => void) => {
    write();
    refresh((n) => n + 1);
  };
  useEffect(() => {
    const node = chart.current;
    if (!node) return;
    const measure = () => setChartWidth(Math.max(120, node.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const update = () => refresh((n) => n + 1);
    addHostListener(window, VISUAL_THEME_REGISTRY_EVENT, update);
    addHostListener(window, VISUAL_THEME_EVENT, update);
    return () => {
      removeHostListener(window, VISUAL_THEME_REGISTRY_EVENT, update);
      removeHostListener(window, VISUAL_THEME_EVENT, update);
    };
  }, []);
  return (
    <Modal className="theme-lab" aria-label={say('themeLab')} ref={modal} onClose={onDone}>
      <header className="theme-lab-head">
        <h2>{say('themeLab')}</h2>
        <button type="button" className="ghost" onClick={() => modal.current?.close()}>
          {say('common.close')}
        </button>
      </header>
      <div className="theme-lab-controls">
        <label>
          {say('preferences.visualTheme')}
          <Dropdown
            ariaLabel={say('preferences.visualTheme')}
            value={visualThemeChoice()}
            items={visualThemeOptions().map((item) => ({ ...item, swatches: [...item.swatches] }))}
            onChange={(value) => after(() => setVisualTheme(value))}
          />
        </label>
        {visualPaletteOptions().length > 1 && (
          <label>
            {say('preferences.palette')}
            <Dropdown
              ariaLabel={say('preferences.palette')}
              value={visualPaletteChoice()}
              items={visualPaletteOptions().map((item) => ({ ...item, swatches: [...item.swatches] }))}
              onChange={(value) => after(() => setVisualPalette(value))}
            />
          </label>
        )}
        <label>
          {say('preferences.colorMode')}
          <Dropdown
            ariaLabel={say('preferences.colorMode')}
            value={themeChoice()}
            items={[
              { value: 'system', label: say('preferences.system') },
              { value: 'light', label: say('preferences.light') },
              { value: 'dark', label: say('preferences.dark') },
            ]}
            onChange={(value) => after(() => setTheme(value))}
          />
        </label>
      </div>
      <div className="theme-lab-grid">
        <section className="theme-lab-section">
          <h3>{say('fieldsHeading')}</h3>
          <div className="theme-lab-fields">
            <label>
              {say('common.name')}
              <input
                className="cell-edit"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={!name.trim()}
                aria-describedby={!name.trim() ? 'theme-lab-name-error' : undefined}
              />
            </label>
            {!name.trim() && (
              <span id="theme-lab-name-error" role="alert">
                {say('nameIsRequired')}
              </span>
            )}
            <label>
              {say('common.status')}
              <Dropdown
                ariaLabel={say('sampleStatus')}
                value={status}
                onChange={setStatus}
                items={[
                  { value: 'active', label: say('active') },
                  { value: 'pending', label: say('pending') },
                  { value: 'closed', label: say('closed') },
                ]}
              />
            </label>
            <label>
              {say('amount')}
              <input className="cell-edit" type="number" defaultValue={1250} min={0} step={50} />
            </label>
            <label>
              {say('reference')}
              <input value="INV-1042" disabled />
            </label>
          </div>
          <div className="theme-lab-actions">
            <label>
              <input type="checkbox" defaultChecked /> {say('active')}
            </label>
            <button type="button" onClick={() => setConfirmation(true)}>
              {say('confirmSample')}
            </button>
            <button type="button" disabled>
              {say('unavailable')}
            </button>
          </div>
        </section>
        <section className="theme-lab-section">
          <h3>{say('common.records')}</h3>
          <div className="theme-lab-table">
            <table>
              <thead>
                <tr>
                  <th>{say('invoice')}</th>
                  <th>{say('amount')}</th>
                  <th>{say('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>INV-1042</td>
                  <td>$1,250.00</td>
                  <td>
                    <span className="tone tone-good">{say('paid')}</span>
                  </td>
                </tr>
                <tr>
                  <td>INV-1043</td>
                  <td>$875.50</td>
                  <td>
                    <span className="tone tone-warn">{say('pending')}</span>
                  </td>
                </tr>
                <tr>
                  <td>INV-1044</td>
                  <td>$320.00</td>
                  <td>
                    <span className="tone tone-bad">{say('overdue')}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul className="theme-lab-colors">
            {[
              [say('accent'), '--accent'],
              [say('positive'), '--status-good'],
              [say('warning'), '--status-warning'],
              [say('negative'), '--status-critical'],
            ].map(([label, token]) => (
              <li key={token}>
                <span className="theme-lab-swatch" style={{ background: `var(${token})` }} />
                {label}
              </li>
            ))}
          </ul>
          <pre tabIndex={0}>
            <code>{'invoice status = paid\nshow reference, total\nsort total desc'}</code>
          </pre>
        </section>
        <section className="theme-lab-section">
          <h3>{say('revenue')}</h3>
          <div ref={chart}>
            <LineChart rows={SERIES} wide={chartWidth} />
          </div>
        </section>
        <section className="theme-lab-section">
          <h3>{say('sources')}</h3>
          <DonutChart
            rows={[
              { key: 'Direct', value: 42 },
              { key: 'Referral', value: 31 },
              { key: 'Partner', value: 27 },
            ]}
          />
        </section>
        <section className="theme-lab-section">
          <h3>{say('loading')}</h3>
          <GridSkeleton columns={3} rows={3} />
        </section>
        <section className="theme-lab-section">
          <h3>{say('empty')}</h3>
          <DonutChart rows={[]} />
        </section>
      </div>
      {confirmation && (
        <Modal className="confirm" aria-label={say('confirmSample')} onClose={() => setConfirmation(false)}>
          <h2>{say('confirmSample')}</h2>
          <p>{name || say('common.untitled')}</p>
          <div className="theme-lab-actions">
            <button type="button" onClick={() => setConfirmation(false)}>
              {say('common.cancel')}
            </button>
            <button type="button" onClick={() => setConfirmation(false)}>
              {say('confirm')}
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
