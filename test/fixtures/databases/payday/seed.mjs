/** Payday's disposable, single-company SQLite fixture. Synthetic people and
 * payroll figures only; refusing overwrite keeps the fixture reviewable.
 *
 * Every figure is derived here, once, from a few facts per person (salary or
 * rate, location, benefit elections), so a run's totals are the sum of its
 * statements and a statement's net is its gross less the lines above it. The
 * rates are round illustrations, not tax tables. The schema is the
 * migrations beside this file, applied as `tablewalk migrate up` applies
 * them, and `<file>.json` says where they are. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';
import { applyMigrations, provisionStores } from '@mistriwork/mistri/maintenance';

const MIGRATIONS = fileURLToPath(new URL('./migrations/', import.meta.url));

const DEPARTMENTS = [
  ['Operations', 'OPS-100'],
  ['Engineering', 'ENG-200'],
  ['Design', 'DES-210'],
  ['People', 'PPL-110'],
  ['Sales', 'SAL-300'],
  ['Marketing', 'MKT-310'],
  ['Customer success', 'CS-320'],
  ['Finance', 'FIN-120'],
];
const dept = (name) => DEPARTMENTS.findIndex(([n]) => n === name) + 1;

// name, email, department, title, location, start, pay type, salary, rate, manager, status
const PEOPLE = [
  [
    'Avery Johnson',
    'avery.johnson@example.test',
    'Operations',
    'Head of operations',
    'New York, NY',
    '2023-04-17',
    'salary',
    142000,
    null,
    null,
    'active',
  ],
  [
    'Mina Patel',
    'mina.patel@example.test',
    'Engineering',
    'Staff engineer',
    'Austin, TX',
    '2022-08-08',
    'salary',
    128000,
    null,
    12,
    'active',
  ],
  [
    'Jordan Brooks',
    'jordan.brooks@example.test',
    'Design',
    'Product designer',
    'Chicago, IL',
    '2024-02-12',
    'salary',
    94000,
    null,
    1,
    'active',
  ],
  [
    'Riley Chen',
    'riley.chen@example.test',
    'Engineering',
    'Software engineer',
    'Austin, TX',
    '2025-01-06',
    'salary',
    108000,
    null,
    12,
    'active',
  ],
  ['Sam Rivera', 'sam.rivera@example.test', 'People', 'People partner', 'New York, NY', '2021-11-15', 'salary', 88000, null, 1, 'active'],
  [
    'Taylor Morgan',
    'taylor.morgan@example.test',
    'Sales',
    'Account executive',
    'Denver, CO',
    '2023-09-11',
    'salary',
    76000,
    null,
    1,
    'active',
  ],
  [
    'Casey Williams',
    'casey.williams@example.test',
    'Sales',
    'Sales development rep',
    'Denver, CO',
    '2025-05-19',
    'hourly',
    null,
    32,
    6,
    'active',
  ],
  [
    'Quinn Davis',
    'quinn.davis@example.test',
    'Marketing',
    'Content strategist',
    'Brooklyn, NY',
    '2024-06-03',
    'salary',
    82000,
    null,
    1,
    'active',
  ],
  [
    'Morgan Lee',
    'morgan.lee@example.test',
    'Customer success',
    'Customer success manager',
    'Boston, MA',
    '2022-03-21',
    'salary',
    90000,
    null,
    1,
    'leave',
  ],
  ['Jamie Kim', 'jamie.kim@example.test', 'Finance', 'Finance manager', 'New York, NY', '2020-10-05', 'salary', 116000, null, 1, 'active'],
  [
    'Robin Taylor',
    'robin.taylor@example.test',
    'Operations',
    'Office coordinator',
    'New York, NY',
    '2025-07-14',
    'hourly',
    null,
    28,
    1,
    'active',
  ],
  [
    'Drew Wilson',
    'drew.wilson@example.test',
    'Engineering',
    'Engineering manager',
    'Austin, TX',
    '2019-01-14',
    'salary',
    146000,
    null,
    1,
    'active',
  ],
  // Two hires who start in October: paperwork and onboarding still open.
  [
    'Alex Nguyen',
    'alex.nguyen@example.test',
    'Customer success',
    'Support specialist',
    'Boston, MA',
    '2026-10-05',
    'hourly',
    null,
    26,
    9,
    'onboarding',
  ],
  [
    'Priya Shah',
    'priya.shah@example.test',
    'Finance',
    'Financial analyst',
    'New York, NY',
    '2026-10-19',
    'salary',
    98000,
    null,
    10,
    'onboarding',
  ],
];
const LEADS = { Operations: 1, Engineering: 12, Design: 3, People: 5, Sales: 6, Marketing: 8, 'Customer success': 9, Finance: 10 };
const STATE_RATE = { NY: 0.055, TX: 0, IL: 0.0495, CO: 0.044, MA: 0.05 };
const PAYROLL_PEOPLE = PEOPLE.slice(0, 12);
const HOURLY = new Set([7, 11]);
// July raises, and June's spot bonuses: the payroll-cost chart has a shape.
const RAISED = new Set([2, 3, 4]),
  SPOT = new Set([2, 4, 9]);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/* Benefit plans: monthly costs for employee-only cover. Coverage tiers
   multiply both sides; the 401(k) is a share of pay, not a premium. */
const PLANS = [
  ['Core Health', 'medical', 'Bluepoint Health', 'HMO with a $1,500 deductible and $25 primary care visits.', 120, 480],
  ['Health Plus', 'medical', 'Bluepoint Health', 'PPO with a $500 deductible and out-of-network cover.', 210, 560],
  ['Dental Basic', 'dental', 'Brightline Dental', 'Two cleanings a year and 80% of basic procedures.', 12, 28],
  ['Vision Care', 'vision', 'ClearView Vision', 'Annual eye exam and a $150 frame allowance.', 4, 8],
  ['401(k) Retirement', 'retirement', 'Harbor Retirement', '4% default contribution with a 3% employer match.', null, null],
];
const TIERS = { 'Employee only': 1, 'Employee + spouse': 2, Family: 2.8 };
// person → [medical plan or null, coverage, dental?, vision?, 401k?]
const ELECTIONS = {
  1: [2, 'Family', true, true, true],
  2: [2, 'Employee + spouse', true, true, true],
  3: [1, 'Employee only', true, false, true],
  4: [1, 'Employee only', true, true, true],
  5: [2, 'Family', true, true, true],
  6: [1, 'Employee only', false, false, false],
  7: [1, 'Employee only', false, false, false],
  8: [null, null, true, true, true],
  9: [2, 'Employee + spouse', true, false, true],
  10: [1, 'Employee + spouse', true, true, true],
  11: [null, null, false, false, false],
  12: [2, 'Family', true, true, true],
};

const POLICIES = [
  ['Vacation', 'vacation', 'Accrues 4 hours each pay period', 96, 40, 1],
  ['Sick leave', 'sick', 'Accrues 2 hours each pay period', 48, 24, 1],
  ['Parental leave', 'parental', 'Granted at birth or placement', 480, 0, 1],
  ['Personal', 'personal', 'Granted each January', 16, 0, 1],
];

export async function seed(file) {
  file = resolve(file);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new database path.`);
  mkdirSync(dirname(file), { recursive: true });
  await applyMigrations({ sqlite: file }, MIGRATIONS);
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN');

    const d = db.prepare('INSERT INTO department(id,name,cost_center) VALUES(?,?,?)');
    DEPARTMENTS.forEach(([name, cc], i) => d.run(i + 1, name, cc));
    const e = db.prepare(
      'INSERT INTO employee(id,name,email,department_id,title,location,employment_status,start_date,pay_type,salary,pay_rate) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    );
    PEOPLE.forEach((p, i) => e.run(i + 1, p[0], p[1], dept(p[2]), p[3], p[4], p[10], p[5], p[6], p[7], p[8]));
    const m = db.prepare('UPDATE employee SET manager_id=? WHERE id=?');
    PEOPLE.forEach((p, i) => {
      if (p[9]) m.run(p[9], i + 1);
    });
    const l = db.prepare('UPDATE department SET lead_id=? WHERE name=?');
    Object.entries(LEADS).forEach(([name, lead]) => l.run(lead, name));

    /* Benefits first: a statement's deductions read each person's elections. */
    const plan = db.prepare('INSERT INTO benefit_plan VALUES(?,?,?,?,?,?,?)');
    PLANS.forEach((p, i) => plan.run(i + 1, ...p));
    const enroll = db.prepare(
      'INSERT INTO benefit(employee_id,plan_id,coverage,status,enrolled_on,employee_cost,employer_cost) VALUES(?,?,?,?,?,?,?)',
    );
    const monthlyDeduction = {},
      monthly401k = {};
    const annualPay = (id) => {
      const p = PEOPLE[id - 1];
      return p[7] ?? p[8] * 2080;
    };
    for (const [id, [medical, coverage, dental, vision, retirement]] of Object.entries(ELECTIONS).map(([k, v]) => [Number(k), v])) {
      const tier = TIERS[coverage ?? 'Employee only'];
      let employee = 0;
      const elect = (planId, cover) => {
        const [, , , , ee, er] = PLANS[planId - 1];
        const eeCost = Math.round(ee * tier),
          erCost = Math.round(er * tier);
        employee += eeCost;
        enroll.run(id, planId, cover, 'enrolled', '2026-01-01', eeCost, erCost);
      };
      if (medical) elect(medical, coverage);
      else enroll.run(id, 1, null, 'waived', '2026-01-01', 0, 0);
      if (dental) elect(3, coverage ?? 'Employee only');
      if (vision) elect(4, coverage ?? 'Employee only');
      if (retirement) {
        const ee = Math.round((annualPay(id) * 0.04) / 12),
          er = Math.round((annualPay(id) * 0.03) / 12);
        monthly401k[id] = ee;
        enroll.run(id, 5, null, 'enrolled', '2026-01-01', ee, er);
      }
      monthlyDeduction[id] = employee;
    }
    // The October hires have elections waiting on their first day.
    enroll.run(13, 1, 'Employee only', 'pending', '2026-10-05', 120, 480);
    enroll.run(14, 2, 'Employee only', 'pending', '2026-10-19', 210, 560);
    enroll.run(14, 5, null, 'pending', '2026-10-19', Math.round((98000 * 0.04) / 12), Math.round((98000 * 0.03) / 12));

    /* Semi-monthly payroll, January to September. Runs 1–3 keep the ids the
       journeys and tests name: the one in review, the last paid, the draft. */
    const periods = [];
    for (let month = 1; month <= 9; month++) {
      const end = lastDay(2026, month);
      periods.push({
        start: iso(2026, month, 1),
        end: iso(2026, month, 15),
        pay: iso(2026, month, 18),
        title: `${MONTHS[month - 1]} 1–15 payroll`,
      });
      const next = month === 12 ? [2027, 1] : [2026, month + 1];
      periods.push({
        start: iso(2026, month, 16),
        end: iso(2026, month, end),
        pay: iso(next[0], next[1], month === 9 ? 2 : 4),
        title: `${MONTHS[month - 1]} 16–${end} payroll`,
      });
    }
    const fixed = { '2026-09-01': [1, 'review'], '2026-08-16': [2, 'paid'], '2026-09-16': [3, 'draft'] };
    const run = db.prepare('INSERT INTO pay_run VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const stub = db.prepare('INSERT INTO pay_stub VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    let nextRun = 4,
      nextStub = 1000;
    periods.forEach((period, index) => {
      const [id, status] = fixed[period.start] ?? [nextRun++, 'paid'];
      const stubStatus = status === 'review' ? 'pending' : status === 'draft' ? 'draft' : 'paid';
      const totals = { gross: 0, taxes: 0, deductions: 0, net: 0, employer: 0 };
      const rows = PAYROLL_PEOPLE.map((p, i) => {
        const person = i + 1;
        let regular = null,
          overtime = null,
          gross;
        if (HOURLY.has(person)) {
          regular = 80;
          overtime = (index * 3 + person) % 5;
          gross = Math.round(p[8] * (regular + overtime * 1.5));
        } else gross = Math.round((p[7] * (index >= 12 && RAISED.has(person) ? 1.04 : 1)) / 24);
        // The annual bonus rides the March 16–31 run; June's carries three spot bonuses.
        const bonus = index === 5 && p[7] ? Math.round(p[7] * 0.05) : index === 11 && SPOT.has(person) ? 1000 : 0;
        gross += bonus;
        const state = STATE_RATE[p[4].slice(-2)];
        const federal = Math.round(gross * 0.12),
          stateTax = Math.round(gross * state);
        const social = Math.round(gross * 0.062),
          medicare = Math.round(gross * 0.0145);
        const benefits = Math.round((monthlyDeduction[person] ?? 0) / 2),
          retirement = Math.round((monthly401k[person] ?? 0) / 2);
        const net = gross - federal - stateTax - social - medicare - benefits - retirement;
        totals.gross += gross;
        totals.taxes += federal + stateTax + social + medicare;
        totals.deductions += benefits + retirement;
        totals.net += net;
        totals.employer += social + medicare + Math.round(gross * 0.006);
        return [
          person,
          period.pay,
          regular,
          overtime,
          bonus,
          gross,
          federal,
          stateTax,
          social,
          medicare,
          benefits,
          retirement,
          net,
          stubStatus,
        ];
      });
      const approved =
        status === 'paid' ? ['Jamie Kim', `${addDays(period.pay, -3)}T15:30:00Z`, 'Reviewed hours and new elections.'] : [null, null, null];
      run.run(
        id,
        `PAY-${period.start}`,
        period.title,
        period.start,
        period.end,
        addDays(period.pay, -2),
        period.pay,
        status,
        rows.length,
        totals.gross,
        totals.taxes,
        totals.deductions,
        totals.net,
        totals.employer,
        ...approved,
        status === 'paid' ? 1 : 0,
      );
      // Statement ids: run 1 → 1–12, run 2 → 100–111, run 3 → 200–211, the rest from 1000.
      rows.forEach((row, i) => stub.run(id === 1 ? i + 1 : id === 2 ? 100 + i : id === 3 ? 200 + i : nextStub++, id, ...row));
    });

    /* Time off: policies, requests, then balances that agree with them. */
    const policy = db.prepare('INSERT INTO time_off_policy VALUES(?,?,?,?,?,?,?)');
    POLICIES.forEach((p, i) => policy.run(i + 1, ...p));
    const time = db.prepare('INSERT INTO time_off VALUES(?,?,?,?,?,?,?,?,?,?)');
    const REQUESTS = [
      [1, 3, 1, '2026-09-28', '2026-10-02', 40, 'pending', 'A long weekend for a family visit.', null],
      [2, 8, 4, '2026-09-21', '2026-09-22', 16, 'approved', '', null],
      [3, 11, 1, '2026-10-12', '2026-10-16', 40, 'pending', '', null],
      [4, 2, 1, '2026-07-06', '2026-07-10', 40, 'approved', 'Summer trip.', null],
      [5, 4, 2, '2026-09-09', '2026-09-09', 8, 'approved', '', null],
      [6, 6, 1, '2026-10-26', '2026-10-30', 40, 'approved', '', null],
      [7, 12, 1, '2026-09-24', '2026-09-25', 16, 'pending', 'Moving apartments.', null],
      [8, 7, 2, '2026-09-14', '2026-09-14', 8, 'approved', '', null],
      [9, 10, 1, '2026-08-17', '2026-08-21', 40, 'approved', '', null],
      [10, 5, 4, '2026-10-09', '2026-10-09', 8, 'approved', '', null],
      [11, 1, 1, '2026-12-21', '2026-12-31', 56, 'pending', 'Holidays with family.', null],
      [12, 8, 1, '2026-09-28', '2026-09-30', 24, 'declined', '', 'Overlaps the fall launch; can we find another week?'],
      [13, 3, 2, '2026-06-03', '2026-06-03', 8, 'approved', '', null],
      [14, 9, 3, '2026-08-24', '2026-11-13', 480, 'approved', 'Parental leave after the baby arrives.', null],
      [15, 5, 1, '2026-05-26', '2026-05-29', 32, 'approved', '', null],
      [16, 12, 2, '2026-03-11', '2026-03-12', 16, 'approved', '', null],
      [17, 2, 1, '2026-11-23', '2026-11-25', 24, 'approved', '', null],
      [18, 11, 2, '2026-08-04', '2026-08-04', 8, 'approved', '', null],
      // More than Quinn's personal balance holds: approval is refused, not driven negative.
      [19, 8, 4, '2026-10-23', '2026-10-23', 8, 'pending', 'Moving day.', null],
    ];
    REQUESTS.forEach((request) => time.run(...request, 0));
    const used = {};
    REQUESTS.filter((r) => r[6] === 'approved').forEach((r) => {
      const k = `${r[1]}:${r[2]}`;
      used[k] = (used[k] ?? 0) + r[5];
    });
    const balance = db.prepare(
      'INSERT INTO time_off_balance(employee_id,policy_id,accrued_hours,used_hours,available_hours) VALUES(?,?,?,?,?)',
    );
    PAYROLL_PEOPLE.forEach((_, i) => {
      const person = i + 1;
      // Seventeen pay periods have accrued by September 15, plus last year's carryover.
      const carry = (person * 7) % 41;
      const accrued = { 1: 17 * 4 + carry, 2: 17 * 2 + (person % 3) * 8, 4: 16 };
      if (person === 9) accrued[3] = 480;
      for (const [policyId, hours] of Object.entries(accrued)) {
        const spent = used[`${person}:${policyId}`] ?? 0;
        balance.run(person, Number(policyId), hours, spent, hours - spent);
      }
    });

    /* Weekly timesheets for the two hourly teammates, August into this week. */
    const sheet = db.prepare('INSERT INTO timesheet VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const entry = db.prepare('INSERT INTO time_entry(timesheet_id,work_date,hours,note) VALUES(?,?,?,?)');
    let sheetId = 1;
    for (const person of [7, 11]) {
      for (let week = 0; week < 8; week++) {
        const start = addDays('2026-08-03', week * 7),
          end = addDays(start, 6);
        const current = week === 7,
          submitted = week === 6 || (week === 5 && person === 11);
        const days = current ? 1 : 5;
        const hours = Array.from({ length: days }, (_, day) => 8 + ((week + day + person) % 4 === 0 ? 2 : (week + day) % 5 === 0 ? 1 : 0));
        const total = hours.reduce((a, b) => a + b, 0);
        const status = current ? 'open' : submitted ? 'submitted' : 'approved';
        sheet.run(
          sheetId,
          person,
          start,
          end,
          Math.min(40, total),
          Math.max(0, total - 40),
          total,
          status,
          status === 'open' ? null : addDays(start, 4),
          status === 'approved' ? 'Avery Johnson' : null,
          status === 'approved' ? `${addDays(start, 7)}T14:00:00Z` : null,
          status === 'approved' ? 1 : 0,
        );
        hours.forEach((h, day) =>
          entry.run(sheetId, addDays(start, day), h, h > 8 ? (person === 7 ? 'Quarter-end call block' : 'Office move prep') : null),
        );
        sheetId++;
      }
    }

    /* Documents: the hiring packet everyone signed, this year's handbook
       acknowledgment still out with four people, and the October hires' packets. */
    const doc = db.prepare(
      'INSERT INTO document(employee_id,title,kind,status,requested_on,due_date,signed_on,reminded_on) VALUES(?,?,?,?,?,?,?,?)',
    );
    const PACKET = [
      ['Offer letter', 'offer', -14],
      ['Form W-4', 'tax', 0],
      ['Form I-9', 'identity', 3],
      ['Direct deposit authorization', 'payroll', 0],
    ];
    const handbookPending = new Set([6, 7, 8, 11]);
    PEOPLE.forEach((p, i) => {
      const person = i + 1,
        start = p[5],
        hire = person > 12;
      PACKET.forEach(([title, kind, offset]) => {
        const requested = addDays(start, offset < 0 ? offset - 2 : -10);
        if (hire && kind !== 'offer')
          doc.run(
            person,
            title,
            kind,
            'pending',
            '2026-09-15',
            addDays(start, kind === 'identity' ? 3 : -1),
            null,
            person === 13 && kind === 'tax' ? '2026-09-21' : null,
          );
        else doc.run(person, title, kind, 'signed', requested, addDays(start, offset), addDays(start, offset), null);
      });
      if (!hire)
        doc.run(
          person,
          'Employee handbook 2026 acknowledgment',
          'policy',
          handbookPending.has(person) ? 'pending' : 'signed',
          '2026-09-01',
          '2026-09-30',
          handbookPending.has(person) ? null : addDays('2026-09-02', person % 9),
          person === 7 ? '2026-09-15' : null,
        );
    });

    const task = db.prepare('INSERT INTO onboarding_task VALUES(?,?,?,?,?,?)');
    task.run(1, 4, 'Complete security training', 'training', '2026-09-22', 'open');
    task.run(2, 4, 'Choose equipment', 'equipment', '2026-09-19', 'open');
    task.run(3, 7, 'Meet your manager', 'welcome', '2025-06-02', 'done');
    const HIRE_TASKS = [
      ['Sign offer letter', 'paperwork', -21, 'done'],
      ['Complete Form W-4 and Form I-9', 'paperwork', -1, 'open'],
      ['Add direct deposit details', 'paperwork', -1, 'open'],
      ['Order laptop and accessories', 'equipment', -7, 'done'],
      ['Choose benefits', 'paperwork', 14, 'open'],
      ['Schedule first-week check-in', 'welcome', 0, 'open'],
      ['Complete security training', 'training', 5, 'open'],
    ];
    for (const person of [13, 14])
      HIRE_TASKS.forEach(([title, category, offset, status]) => {
        task.run(
          null,
          person,
          title,
          category,
          addDays(PEOPLE[person - 1][5], offset),
          person === 14 && title.startsWith('Order') ? 'open' : status,
        );
      });

    /* The company's one profile row: what payroll runs under, edited from Settings, never a list. */
    db.prepare(
      'INSERT INTO company(id,name,legal_name,ein,address,pay_schedule,payroll_contact,overtime_after_hours) VALUES(1,?,?,?,?,?,?,?)',
    ).run(
      'Payday demo workspace',
      'Payday Demo Workspace, Inc.',
      '12-3456789',
      '100 Market Street, Suite 400, San Francisco, CA 94105',
      'semimonthly',
      'avery.johnson@example.test',
      40,
    );
    /* The company calendar: this year's work anniversaries, first days and holidays. */
    const event = db.prepare('INSERT INTO company_event(event_date,kind,title,employee_id) VALUES(?,?,?,?)');
    PEOPLE.forEach((p, i) => {
      const years = 2026 - Number(p[5].slice(0, 4));
      if (years >= 1) event.run(`2026${p[5].slice(4)}`, 'anniversary', `${p[0]} · ${years} year${years === 1 ? '' : 's'}`, i + 1);
      else event.run(p[5], 'first_day', `${p[0]} starts`, i + 1);
    });
    [
      ['2026-01-01', 'New Year’s Day'],
      ['2026-01-19', 'Martin Luther King Jr. Day'],
      ['2026-05-25', 'Memorial Day'],
      ['2026-07-03', 'Independence Day (observed)'],
      ['2026-09-07', 'Labor Day'],
      ['2026-11-26', 'Thanksgiving'],
      ['2026-11-27', 'Day after Thanksgiving'],
      ['2026-12-25', 'Christmas Day'],
    ].forEach(([date, title]) => event.run(date, 'holiday', title, null));
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  // Where a teammate hears the decision on their time off (features/timeoff.ts).
  await provisionStores({ sqlite: file }, { only: ['inbox'] });
  writeFileSync(
    `${file}.json`,
    `${JSON.stringify({ connections: [{ name: 'payday', url: file, writable: true, migrations: { dir: MIGRATIONS } }] }, null, 2)}\n`,
    { flag: 'wx' },
  );
  return file;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx test/fixtures/databases/payday/seed.mjs <new-file.db>');
  console.log(await seed(process.argv[2]));
}
