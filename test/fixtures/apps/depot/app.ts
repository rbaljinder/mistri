import { defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { api } from './api.ts';
import { operations, purchasing } from './dashboards.ts';
import { navigation } from './navigation.ts';
import { pages } from './pages/index.ts';
import { resources } from './resources.ts';
import { views } from './views.ts';

/* Who does what. The floor receives, moves, picks, packs, ships and counts;
   it triages orders in place but never touches the catalog or the buying.
   Purchasing keeps the catalog and the suppliers and drafts, sends and
   cancels purchase orders. A manager does both, keys and releases phone
   orders, adjusts stock with a reason and closes a count, which writes its
   variances to the ledger. Stock itself is never an edit for anyone: every
   unit moves through a command, into the ledger. */
const floor = ['receiveLine', 'transferStock', 'pickList', 'packLists', 'shipList', 'startCount', 'recordCount'] as const;
const buying = ['draftPurchaseOrder', 'sendPurchaseOrder', 'cancelPurchaseOrder'] as const;
/* A manager gives the word a large order waits for (the approval flow's rows, jobs.ts). */
const managing = [
  ...floor,
  ...buying,
  'adjustStock',
  'releaseOrder',
  'completeCount',
  'approvePurchaseOrder',
  'rejectPurchaseOrder',
] as const;
/* A supplier's contact details are edited in place and by the API's update-supplier command, which keeps its
   revision in `version`: so the role's grant leaves `version` out and only the command moves it. */
const supplier = {
  read: ['id', 'name', 'contact', 'email', 'phone', 'city', 'state', 'lead_time_days', 'terms'],
  write: ['name', 'contact', 'email', 'phone', 'city', 'state', 'lead_time_days', 'terms'],
} as const;
/* A pick list moves by its commands alone; the one thing written on it by hand is the receiver's signature, kept as
   a picture of its own. */
const signing = { pick_list: { write: ['signature_id'] } } as const;
const manager = {
  read: true,
  write: [
    'product',
    'product_photo',
    'attribute',
    'supplier',
    'bin',
    'sales_order',
    'order_line',
    'po_flow',
    'po_flow_step',
    'pick_list',
    'delivery_signature',
  ],
  commands: managing,
  fields: { supplier, ...signing },
} as const;

export default defineApp({
  id: 'depot',
  name: 'Depot',
  sources: { depot: { connection: 'depot' } },
  resources,
  auth: {
    providers: ['email'],
    defaultRole: 'operator',
    roles: {
      operator: {
        label: 'Operator',
        read: true,
        write: ['sales_order', 'pick_list', 'delivery_signature'],
        commands: floor,
        fields: signing,
      },
      purchaser: {
        label: 'Purchaser',
        read: true,
        // Purchasing writes the flows its orders run (po_flow and po_flow_step): the steps are rows, edited while the App runs.
        write: ['product', 'product_photo', 'attribute', 'supplier', 'po_flow', 'po_flow_step'],
        commands: buying,
        fields: { supplier },
      },
      manager: { ...manager, label: 'Manager' },
      // The account a first start bootstraps (MISTRI_AUTH_ADMIN_EMAIL): a manager, who also operates the flows' runs.
      admin: { ...manager, label: 'Admin', operations: ['workflows'] },
      // What the flows' runner does by itself (jobs.ts): asks for approval and sends an approved order. No person holds it,
      // so it is a service role, offered no page.
      automation: { label: 'Automation', service: true, read: true, commands: ['requestApproval', 'sendPurchaseOrder'] },
    },
  },
  views: { ...views, operations, purchasing },
  pages,
  api,
  home: [{ view: 'purchasing', roles: ['purchaser'] }, { view: 'operations' }],
  nav: navigation,
  ui: {
    logo: 'package',
    theme: { preset: 'lumen' },
    shell: {
      placement: 'side',
      rail: true,
      counts: true,
      // Every way to make something, in one button by the bell; each person sees the ones their role may make.
      new: [
        { command: 'draftPurchaseOrder', label: 'Purchase order', icon: 'receipt' },
        { command: 'startCount', label: 'Cycle count', icon: 'clipboard-text' },
        { view: 'products', icon: 'package' },
        { view: 'suppliers', icon: 'truck' },
      ],
      sidebar: { footer: { title: 'Switchback Supply', description: 'Reno · Columbus · Allentown' } },
    },
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    currency: 'USD',
  },
} satisfies App);
