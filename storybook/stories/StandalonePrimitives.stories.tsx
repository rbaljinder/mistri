import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
/* The standalone primitives' rules ride standalone.css, not the kit's
   wholesale import: a page drawn with the primitives alone takes them
   the same way, through style.css, which joins this sheet. */
import '@mistriwork/ui/standalone.css';
import { Button } from '@mistriwork/ui/Button.js';
import { Switch } from '@mistriwork/ui/Switch.js';
import { Tabs } from '@mistriwork/ui/Tabs.js';
import { Drawer } from '@mistriwork/ui/Drawer.js';
import { Popover } from '@mistriwork/ui/Popover.js';
import { Avatar } from '@mistriwork/ui/Avatar.js';
import { Pagination } from '@mistriwork/ui/Pagination.js';
import { Carousel } from '@mistriwork/ui/Carousel.js';
import { Resizable } from '@mistriwork/ui/Resizable.js';
import { ScrollArea } from '@mistriwork/ui/ScrollArea.js';
import { Tooltip } from '@mistriwork/ui/Tooltip.js';

/* One story per standalone primitive, each state in one place so the
   visual matrix sees the PR #9 six and the remainder-wave four in every
   look, without opening an App. */
const meta = { title: 'Standalone Primitives', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;

const row = { display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' } as const;
const panel = { background: 'var(--raised)', padding: 16, borderRadius: 'var(--radius)' } as const;

export const Switches: StoryObj = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, maxWidth: 420 }}>
      <Switch label="Notify me" description="A message when a task is assigned to you." defaultChecked />
      <Switch label="Weekly digest" description="One summary every Monday, nothing else." />
      <Switch label="Syncing" description="Already pressed once; it refuses a second press." checked busy />
      <Switch label="Archived projects" disabled />
    </div>
  ),
};

export const TabsPanels: StoryObj = {
  render: () => (
    <Tabs
      ariaLabel="Settings sections"
      tabs={[
        { value: 'general', label: 'General', children: <p style={{ margin: 0 }}>The studio's name, timezone and currency.</p> },
        { value: 'members', label: 'Members', children: <p style={{ margin: 0 }}>Who can sign in, and what each role may do.</p> },
        {
          value: 'billing',
          label: 'Billing',
          children: <p style={{ margin: 0 }}>Invoices, payment methods and receipts.</p>,
          disabled: true,
        },
      ]}
    />
  ),
};

export const DrawerSheet: StoryObj = {
  render: function OpenDrawer() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button intent="secondary" onClick={() => setOpen(true)}>
          Open filters
        </Button>
        <Drawer open={open} title="Filters" onOpenChange={setOpen}>
          <p style={{ marginTop: 0 }}>Only the filters live here; the list stays behind the scrim.</p>
          <Button intent="primary" onClick={() => setOpen(false)}>
            Apply
          </Button>
        </Drawer>
      </>
    );
  },
};

export const PopoverLayer: StoryObj = {
  render: () => (
    <Popover trigger={<Button intent="secondary">What is this?</Button>} defaultOpen>
      <p style={{ margin: 0 }}>A layer anchored to its trigger: Escape or a click outside dismisses it.</p>
    </Popover>
  ),
};

export const Avatars: StoryObj = {
  render: () => (
    <div style={row}>
      <Avatar name="Ada Lovelace" size="sm" />
      <Avatar name="Ada Lovelace" size="md" />
      <Avatar name="Morgan Hughes" size="lg" />
      <Avatar name="Ada" size="md" />
    </div>
  ),
};

export const PaginationRows: StoryObj = {
  render: function Paged() {
    const [page, setPage] = useState(1);
    const [middle, setMiddle] = useState(10);
    return (
      <div style={{ display: 'grid', gap: 20 }}>
        <Pagination page={page} pages={20} ariaLabel="Invoices, pages" onPageChange={setPage} />
        <Pagination page={middle} pages={20} ariaLabel="Invoices, pages" onPageChange={setMiddle} />
      </div>
    );
  },
};

const slide = (title: string, body: string) => (
  <div style={{ ...panel, minHeight: 140 }}>
    <h3 style={{ margin: '0 0 8px' }}>{title}</h3>
    <p style={{ margin: 0 }}>{body}</p>
  </div>
);

export const CarouselSlides: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <Carousel
        ariaLabel="Project photos"
        slides={[
          { label: 'Studio', children: slide('Studio', 'The north light room, before the shoot.') },
          { label: 'Work', children: slide('Work', 'Boards, proofs and the wall of type.') },
          { label: 'Wall', children: slide('Wall', 'The studio wall, pinned and in progress.') },
        ]}
      />
    </div>
  ),
};

export const ResizablePanes: StoryObj = {
  render: () => (
    <div style={{ display: 'grid', gap: 24 }}>
      <div style={{ height: 220, border: '1px solid var(--line)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        <Resizable
          ariaLabel="Record and detail"
          panels={[
            { label: 'Record', defaultSize: 60, children: <div style={panel}>The record list, at sixty percent.</div> },
            {
              label: 'Detail',
              defaultSize: 40,
              children: <div style={panel}>Its detail, at forty percent. Drag the handle, or walk it with the arrows.</div>,
            },
          ]}
        />
      </div>
      <div style={{ height: 220, border: '1px solid var(--line)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        <Resizable
          direction="vertical"
          ariaLabel="Notes above preview"
          panels={[
            { label: 'Notes', defaultSize: 50, children: <div style={panel}>Notes on top.</div> },
            { label: 'Preview', defaultSize: 50, children: <div style={panel}>Preview below, on a vertical handle.</div> },
          ]}
        />
      </div>
    </div>
  ),
};

export const ScrollAreaRegion: StoryObj = {
  render: () => (
    <div style={{ maxWidth: 420 }}>
      <ScrollArea ariaLabel="Recent activity" maxHeight="240px">
        {Array.from({ length: 12 }, (_, i) => (
          <p key={i} style={{ margin: '0 0 12px' }}>
            Activity {i + 1}: a task moved, a note left, an invoice sent.
          </p>
        ))}
      </ScrollArea>
    </div>
  ),
};

export const TooltipNote: StoryObj = {
  render: () => (
    <div style={row}>
      <Tooltip trigger={<Button intent="secondary">Save</Button>} defaultOpen>
        Saves the record without leaving the page.
      </Tooltip>
      <p style={{ margin: 0, color: 'var(--ink-muted)' }}>Hover or focus the button; the note is extra, never the label.</p>
    </div>
  ),
};
