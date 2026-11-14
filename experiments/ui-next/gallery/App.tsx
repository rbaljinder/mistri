import {
  Bank,
  Buildings,
  CalendarCheck,
  CalendarDots,
  ChartBar,
  ChartBarHorizontal,
  ClipboardText,
  FileText,
  Gauge,
  GearSix,
  House,
  Receipt,
  SignIn as SignIn_,
  SlidersHorizontal,
  SquaresFour,
  Palette,
  Swap,
  Users,
  Wrench,
} from '@phosphor-icons/react';
import type { Preference } from '@ui-sdk/core';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover';
import { Preferences, usePreference } from '@ui-sdk/react/preferences';
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control';
import { type ComponentType, lazy, Suspense, useEffect, useState } from 'react';
import { Toaster } from '../src';
import { toast } from '@ui-sdk/react/toast';
import { AccountMenu, AppShell, InboxBell, type NavGroup, type Notice, SignIn } from '../src';
import { CommandPalette } from './CommandPalette';
import { Charges } from './pages/Charges';
import { Components } from './pages/Components';
import { Applications, Homes, Residents } from './pages/Rooms';
import { Visits } from './pages/Visits';
import { Works } from './pages/Works';
import { Dashboard } from './pages/Dashboard';
import { Lease } from './pages/Lease';
import { RentRoll } from './pages/RentRoll';
import { Repairs } from './pages/Repairs';
import { Settings } from './pages/Settings';
import { Themes } from './pages/Themes';
import { LOOKS } from './theme';
import { setDress, useDress } from './theming';
import { Today } from './pages/Today';
import { accent, corners, density, mode, preferences } from './preferences';

/* The one page that draws mistri's own primitives: it brings @mistriwork/ui and Base UI with it, so it loads apart. */
const DropIn = lazy(() => import('../kit/gallery/DropIn'));

type Room = { id?: string; label: string; icon: ComponentType<{ 'aria-hidden'?: boolean }>; count?: number };

/* Lintel's menu, so the two pages are read where an App would show them. Only three rooms are real here. */
const MENU: { group?: string; rooms: Room[] }[] = [
  {
    rooms: [
      { id: 'today', label: 'Today', icon: Gauge },
      { id: 'homes', label: 'Homes to let', icon: House },
    ],
  },
  {
    group: 'Leasing',
    rooms: [
      { id: 'rent-roll', label: 'Rent roll', icon: Buildings },
      { id: 'lease', label: 'Leases', icon: FileText },
      { label: 'Occupancy', icon: CalendarCheck, count: 53 },
      { id: 'residents', label: 'Residents', icon: Users },
      { id: 'applications', label: 'Applications', icon: ClipboardText, count: 5 },
    ],
  },
  {
    group: 'Books',
    rooms: [
      { id: 'books', label: 'Dashboard', icon: ChartBar },
      { id: 'charges', label: 'Charges', icon: Receipt, count: 10000 },
      { label: 'Payments', icon: Bank },
    ],
  },
  {
    group: 'Maintenance',
    rooms: [
      { id: 'repairs', label: 'Repair board', icon: Wrench, count: 9 },
      { id: 'visits', label: 'Visits', icon: CalendarDots },
      { id: 'works', label: 'Planned works', icon: ChartBarHorizontal },
    ],
  },
  {
    group: 'ui-next',
    rooms: [
      { id: 'settings', label: 'Settings', icon: GearSix },
      { id: 'themes', label: 'Themes', icon: Palette },
      { id: 'sign-in', label: 'Sign in', icon: SignIn_ },
      { id: 'kit', label: 'Drop-in', icon: Swap },
      { id: 'components', label: 'Components', icon: SquaresFour },
    ],
  },
];

const ROOMS = new Set(MENU.flatMap((section) => section.rooms.flatMap((room) => (room.id ? [room.id] : []))));

function useRoom() {
  const read = () => {
    const name = window.location.hash.slice(1).split('?')[0] ?? '';
    return ROOMS.has(name) ? name : 'today';
  };
  const [room, setRoom] = useState(read);
  useEffect(() => {
    const onChange = () => {
      setRoom(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return room;
}

function Knob<T extends string>({ label, preference }: { label: string; preference: Preference<T> }) {
  const { value } = usePreference(preference);
  return (
    <div data-part="knob">
      <span id={`knob-${label}`}>{label}</span>
      <SegmentedControl
        aria-labelledby={`knob-${label}`}
        value={value}
        onValueChange={(next) => {
          if (next !== null) preference.set(next as T);
        }}
      >
        <SegmentedControlIndicator />
        {preference.values.map((option) => (
          <SegmentedControlItem key={option} value={option}>
            {option}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}

/* The look, in a menu: six are too many for a row of segments. The palettes and recipes are in the Themes room. */
function LookKnob() {
  const dress = useDress();
  return (
    <div data-part="knob">
      <label htmlFor="knob-look">Look</label>
      <select
        id="knob-look"
        value={dress.look}
        onChange={(event) => setDress({ look: event.target.value as (typeof LOOKS)[number] | 'own' })}
      >
        <option value="own">ui-next&apos;s own</option>
        {LOOKS.map((look) => (
          <option key={look} value={look}>
            {look.charAt(0).toUpperCase() + look.slice(1)}
          </option>
        ))}
      </select>
      {dress.look !== 'own' && <a href="#themes">Palettes and recipes</a>}
    </div>
  );
}

function Appearance() {
  const themed = useDress().look !== 'own';
  return (
    <Popover>
      <PopoverTrigger aria-label="Appearance" data-variant="quiet">
        <SlidersHorizontal aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} data-part="appearance">
        <PopoverTitle>Appearance</PopoverTitle>
        <Knob label="Mode" preference={mode} />
        <LookKnob />
        {/* An accent and a corner are a look's own to say: these two are ui-next's, for where no look is worn. */}
        {!themed && <Knob label="Accent" preference={accent} />}
        {!themed && <Knob label="Corners" preference={corners} />}
        <Knob label="Density" preference={density} />
      </PopoverContent>
    </Popover>
  );
}

const NAV: NavGroup[] = MENU.map((section) => ({
  label: section.group,
  items: section.rooms.map((item) => ({
    id: item.id ?? item.label,
    label: item.label,
    href: `#${item.id ?? ''}`,
    icon: <item.icon aria-hidden />,
    count: item.count,
    idle: !item.id,
  })),
}));

const NOTICES: Notice[] = [
  {
    id: 'n1',
    title: 'Boiler loses pressure overnight',
    detail: 'AC-204 reported it as urgent',
    when: '2 h',
    unread: true,
    href: '#repairs',
  },
  { id: 'n2', title: 'Tomasz Baran applied', detail: 'Birch House BH-102', when: '5 h', unread: true, href: '#applications' },
  { id: 'n3', title: 'Payment received', detail: '$1,285 for Alder Court #101', when: 'Yesterday', href: '#lease' },
];

export function App() {
  const room = useRoom();
  const [notices, setNotices] = useState(NOTICES);
  /* Where the menu stands is the reader's to choose here, to see both: it is kept for the next visit. */
  const [layout, setLayout] = useState<'side' | 'top'>(() => {
    try {
      return window.localStorage.getItem('m-gallery:layout') === 'top' ? 'top' : 'side';
    } catch {
      return 'side';
    }
  });
  return (
    <Preferences preferences={preferences}>
      <AppShell
        brand={{ name: 'Lintel', href: '#today', mark: <Buildings weight="fill" /> }}
        nav={NAV}
        current={room}
        layout={layout}
        remember="gallery"
        bar={<CommandPalette />}
        end={
          <>
            <InboxBell
              notices={notices}
              onOpen={(notice) => setNotices((now) => now.map((one) => (one.id === notice.id ? { ...one, unread: false } : one)))}
              onReadAll={() => setNotices((now) => now.map((one) => ({ ...one, unread: false })))}
            />
            <Appearance />
            <AccountMenu
              name="Maya Lin"
              items={[
                { value: 'settings', label: 'Settings' },
                { value: '~layout', label: layout === 'side' ? 'Menu along the top' : 'Menu down the side' },
                { value: 'sign-in', label: 'Sign out', separated: true },
              ]}
              onAction={(value) => {
                if (value !== '~layout') {
                  window.location.hash = value;
                  return;
                }
                const next = layout === 'side' ? 'top' : 'side';
                setLayout(next);
                try {
                  window.localStorage.setItem('m-gallery:layout', next);
                } catch {
                  // Nothing kept: the menu still moves.
                }
              }}
            />
          </>
        }
        foot={
          <p data-part="rail-note">
            <strong>@mistriwork/ui-next</strong> An experiment over UI SDK. The rooms in grey are scenery.
          </p>
        }
      >
        {room === 'today' && <Today />}
        {room === 'rent-roll' && <RentRoll onOpen={() => (window.location.hash = 'lease')} />}
        {room === 'lease' && <Lease />}
        {room === 'homes' && <Homes />}
        {room === 'residents' && <Residents />}
        {room === 'applications' && <Applications />}
        {room === 'visits' && <Visits />}
        {room === 'works' && <Works />}
        {room === 'books' && <Dashboard />}
        {room === 'charges' && <Charges />}
        {room === 'repairs' && <Repairs />}
        {room === 'settings' && <Settings />}
        {room === 'themes' && <Themes />}
        {room === 'sign-in' && <Door />}
        {room === 'kit' && (
          <Suspense fallback={null}>
            <DropIn />
          </Suspense>
        )}
        {room === 'components' && <Components />}
      </AppShell>
      <Toaster />
    </Preferences>
  );
}

/* The way in, as a room, so it is seen beside the rest. Any password but `lintel` is refused. */
function Door() {
  return (
    <div data-part="door">
      <SignIn
        name="Lintel"
        mark={<Buildings weight="fill" />}
        providers={[{ id: 'sso', label: 'single sign-on' }]}
        onProvider={() => toast('Single sign-on would start here')}
        onSubmit={async ({ password }) => {
          await new Promise((settle) => window.setTimeout(settle, 600));
          if (password !== 'lintel') throw new Error('That address and password do not match an account.');
          window.location.hash = 'today';
        }}
        foot={
          <>
            Forgot it? <a href="#sign-in">Reset your password</a>. In this gallery the password is lintel.
          </>
        }
      />
    </div>
  );
}
