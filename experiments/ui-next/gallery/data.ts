import type { Tone } from '../src';

export type Unit = {
  code: string;
  building: string;
  beds: number;
  size: number;
  rent: number;
  status: 'Occupied' | 'Vacant' | 'On notice' | 'Turnover';
  resident: string | null;
  available: string | null;
  listed: boolean;
};

export const STATUS_TONE: Record<Unit['status'], Tone> = {
  Occupied: 'good',
  Vacant: 'warning',
  'On notice': 'info',
  Turnover: 'neutral',
};

const BUILDINGS: [string, string, number][] = [
  ['AC', 'Alder Court', 0],
  ['BH', 'Birch House', 40],
  ['CM', 'Cedar Mews', 95],
];
const PLANS: [number, number, number][] = [
  [0, 480, 1285],
  [1, 690, 1495],
  [1, 720, 1545],
  [2, 980, 1895],
  [2, 940, 1795],
  [3, 1240, 2385],
];
const RESIDENTS = [
  'Andre Okoye',
  'Lucas Mendes',
  'Iris Bennett',
  'Owen Kim',
  'Lena Patel',
  'Ethan Cruz',
  'Liam Chen',
  'Omar Ramirez',
  'Elena Ito',
  'Mateo Colón',
  'Valeria Huang',
  'Andre Lowe',
  'Imani Medina',
  'Amara Sullivan',
  'Darius Delgado',
  'Nora Whitfield',
  'Kofi Asante',
  'Priya Nair',
  'Tomás Rivera',
  'Hana Sato',
  'Jonas Becker',
  'Aisha Rahman',
  'Felix Laurent',
  'Mei Tanaka',
  'Samir Haddad',
  'Greta Olsen',
  'Diego Vargas',
  'Zara Malik',
  'Noah Fischer',
  'Chloe Dubois',
  'Ravi Menon',
  'Sofia Greco',
  'Malik Johnson',
  'Yuki Mori',
  'Elias Berg',
  'Carmen Ortiz',
  'Tariq Aziz',
  'Freya Lind',
  'Hugo Martin',
  'Leila Farah',
  'Arjun Shah',
  'Maya Cohen',
  'Kai Nakamura',
  'Ines Moreau',
  'Dylan Price',
  'Rosa Jimenez',
  'Emil Novak',
  'Tessa Quinn',
  'Bao Tran',
  'Lucia Romano',
  'Idris Bello',
  'Anya Petrov',
  'Marco Silva',
  'Signe Holm',
];
/* Which of the 54 homes is not simply occupied. */
const OTHER: Record<number, [Unit['status'], string | null, boolean]> = {
  4: ['Vacant', 'Sep 12, 2026', true],
  8: ['On notice', 'Oct 1, 2026', false],
  19: ['Turnover', 'Sep 20, 2026', false],
  23: ['Vacant', 'Sep 5, 2026', true],
  31: ['Turnover', 'Sep 28, 2026', false],
  37: ['Vacant', 'Sep 15, 2026', true],
  44: ['Turnover', 'Oct 4, 2026', false],
  50: ['Vacant', 'Sep 9, 2026', false],
};

export const UNITS: Unit[] = BUILDINGS.flatMap(([prefix, building, premium], b) =>
  [1, 2, 3].flatMap((floor) =>
    PLANS.map(([beds, size, rent], plan) => {
      const index = b * 18 + (floor - 1) * 6 + plan;
      const [status, available, listed] = OTHER[index] ?? ['Occupied', null, false];
      const vacant = status === 'Vacant' || status === 'Turnover';
      return {
        code: `${prefix}-${floor}0${plan + 1}`,
        building,
        beds,
        size,
        rent: rent + premium + (floor - 1) * 25,
        status,
        resident: vacant ? null : RESIDENTS[index],
        available,
        listed,
      };
    }),
  ),
);

export const money = (amount: number) => amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export type Charge = { id: string; description: string; due: string; overdue: boolean; amount: number; status: 'Open' | 'Paid' };

export const CHARGES: Charge[] = [
  { id: 'c9', description: 'Rent, September 2026', due: '3 days ago', overdue: true, amount: 1285, status: 'Open' },
  { id: 'c8', description: 'Late fee, August 2026', due: 'Aug 7, 2026', overdue: true, amount: 75, status: 'Open' },
  { id: 'c7', description: 'Rent, August 2026', due: 'Aug 1, 2026', overdue: true, amount: 1285, status: 'Open' },
  { id: 'c6', description: 'Rent, July 2026', due: 'Jul 1, 2026', overdue: false, amount: 1285, status: 'Paid' },
  { id: 'c5', description: 'Rent, June 2026', due: 'Jun 1, 2026', overdue: false, amount: 1285, status: 'Paid' },
  { id: 'c4', description: 'Rent, May 2026', due: 'May 1, 2026', overdue: false, amount: 1285, status: 'Paid' },
  { id: 'c3', description: 'Rent, April 2026', due: 'Apr 1, 2026', overdue: false, amount: 1285, status: 'Paid' },
];

export const HISTORY = [
  { id: 'h1', title: 'Late fee charged', dateTime: '2026-08-07', time: 'Aug 7', description: '$75, five days after rent fell due.' },
  { id: 'h2', title: 'Payment received', dateTime: '2026-07-01', time: 'Jul 1', description: '$1,285 by bank transfer.' },
  { id: 'h3', title: 'Lease activated', dateTime: '2025-11-01', time: 'Nov 1, 2025', description: 'Signed by Andre Okoye and Maya Lin.' },
  { id: 'h4', title: 'Draft created', dateTime: '2025-10-18', time: 'Oct 18, 2025' },
];
