/**
 * Lintel on a disposable SQLite file, on `@mistriwork/mistri/testing` alone: the real
 * seed (examples/databases/lintel/seed.mjs), the App copied into the test's
 * workspace, served with its jobs module and its row policy as production
 * serves it, and a signed-in session per role.
 *
 * `mistri test init` writes a start like this one, policy and jobs
 * included. What is added here is what a generated suite has no way to know:
 * a seeded resident's address is made the resident test account's, since the
 * policy finds a resident's household by the signed-in email (policy.ts), a
 * seeded technician's the technician account's, so a visit booked for them
 * mails someone who can sign in, and each role's account takes a password a
 * browser can type.
 */
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createTestWorkspace, startTestApp, type TestClient, type TestDecisionScript } from '@mistriwork/mistri/testing';
import { seed } from '../../../databases/lintel/seed.mjs';

/** The App under test. LINTEL_APP points it at a changed copy: prove-red.mjs uses it to break one rule. */
export const appSource = process.env.LINTEL_APP ?? fileURLToPath(new URL('../', import.meta.url));
export const PASSWORD = 'lintel-fixture-password';
export const CALLBACK_SECRET = 'lintel-processor-test-secret';
export const ROLES = ['manager', 'leasing', 'technician', 'accountant', 'resident'] as const;
export type Role = (typeof ROLES)[number] | 'admin';
/** Each role's account: what `host.as(role)` would make, with a password a browser can type. */
export const emailOf = (role: Role) => `${role}@example.test`;

/** `decisions`: the routing decision's answers, scripted (decisions.test.ts); without them it has no provider and asks no one. */
export async function startLintel(options: { decisions?: (staff: Record<Role, number>) => TestDecisionScript } = {}) {
  const workspace = await createTestWorkspace();
  try {
    // A copied App resolves `@mistriwork/mistri/app` the way an installed one does.
    await mkdir(workspace.path('node_modules/@mistriwork'), { recursive: true });
    await symlink(
      dirname(createRequire(import.meta.url).resolve('@mistriwork/mistri/package.json')),
      workspace.path('node_modules/@mistriwork/mistri'),
      'dir',
    );
    const app = await workspace.copy(appSource, 'app');
    const mailSecret = 'lintel-unsubscribe-test-secret';
    process.env.LINTEL_MAIL_SECRET ??= mailSecret;
    const database = seed(workspace.path('data/lintel.db'));
    const resident = linkResident(database);
    const { names, ids } = linkStaff(database, resident.name);
    const host = await startTestApp({
      workspace,
      directory: app,
      config: `${database}.json`,
      // Named as production names them; a relative module is the App directory's.
      args: ['--jobs', 'jobs.ts', '--policy', 'policy.ts'],
      // The App, its jobs and its policy load from TypeScript source at every start: a busy machine is slow to.
      timeoutMs: 120_000,
      // Scripted after the seed, so an answer can name a technician the seed made.
      ...(options.decisions ? { decisions: options.decisions(ids) } : {}),
      environment: {
        LINTEL_MAIL_SECRET: process.env.LINTEL_MAIL_SECRET,
        PAYMENT_CALLBACK_SECRET: CALLBACK_SECRET,
        MISTRI_AUTH_ADMIN_EMAIL: emailOf('admin'),
        MISTRI_AUTH_ADMIN_PASSWORD: PASSWORD,
      },
    });
    const admin = host.client();
    await admin.signIn(emailOf('admin'), PASSWORD);
    // Accounts are made the way an administrator makes them: through the App's own accounts API.
    for (const role of ROLES) {
      const made = await admin.request('/api/accounts', {
        method: 'POST',
        json: { app: 'lintel', operation: 'create', name: names[role], email: emailOf(role), roles: [role], password: PASSWORD },
      });
      if (made.status !== 200) throw new Error(`Creating the ${role} account answered ${made.status}: ${await made.text()}`);
    }
    const sessions = new Map<Role, Promise<TestClient>>();
    /** A signed-in session for a role, made once per fixture. */
    const as = (role: Role) => {
      let session = sessions.get(role);
      if (!session) {
        const client = host.client();
        session = client.signIn(emailOf(role), PASSWORD).then(() => client);
        sessions.set(role, session);
      }
      return session;
    };
    /** Read-only rows straight from the file, for what HTTP does not show and for asserting nothing moved. */
    const rows = <T = Record<string, unknown>>(sql: string, ...values: Array<string | number>): T[] => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        return db
          .prepare(sql)
          .all(...values)
          .map((row) => ({ ...row }) as T);
      } finally {
        db.close();
      }
    };
    /** Every message the mail service wrote instead of sending, oldest first. */
    const mail = async () => {
      const text = await readFile(`${database}.mail.log`, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean);
    };
    /** The first message, from `since` on, that `matches`: mail is queued in the write's transaction and sent after it. */
    const mailed = async (matches: (line: string) => boolean, since = 0, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = (await mail()).slice(since).find(matches);
        if (found || Date.now() > deadline) return found;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };
    /** The processor's callback, signed as it signs one at `at` (epoch seconds, now by default); `secret` forges it. */
    const settle = (body: Record<string, unknown>, secret = CALLBACK_SECRET, at = Math.floor(Date.now() / 1000)) => {
      const raw = JSON.stringify(body);
      const timestamp = String(at);
      return host.client().request('/api/inbound/paymentSettled', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-processor-timestamp': timestamp,
          'x-processor-signature': createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex'),
        },
        body: raw,
      });
    };
    return {
      workspace,
      host,
      database,
      resident,
      as,
      anonymous: () => host.client(),
      rows,
      mail,
      mailed,
      settle,
      close: () => workspace.close(),
    };
  } catch (error) {
    await workspace.close();
    throw error;
  }
}
export type Lintel = Awaited<ReturnType<typeof startLintel>>;

/**
 * The resident test account's household: the seeded resident on a current lease with a repair still open and the most repairs, one the
 * office has left an internal note on if any, given the account's address and mail consent. Their id and lease come back for the tests to name.
 */
function linkResident(database: string) {
  const db = new DatabaseSync(database);
  try {
    const found = db
      .prepare(
        `SELECT r.id AS id, r.name AS name, l.id AS lease, l.unit_id AS unit,
                (SELECT COUNT(*) FROM request_note n JOIN maintenance_request m ON m.id = n.request_id
                  WHERE m.resident_id = r.id AND n.kind = 'internal') AS internal,
                (SELECT COUNT(*) FROM maintenance_request m WHERE m.resident_id = r.id) AS repairs,
                (SELECT COUNT(*) FROM maintenance_request m
                  WHERE m.resident_id = r.id AND m.status NOT IN ('closed', 'cancelled')) AS open
           FROM resident r JOIN lease l ON l.resident_id = r.id AND l.status = 'active'
          ORDER BY internal > 0 DESC, open > 0 DESC, repairs DESC, r.id LIMIT 1`,
      )
      .get() as { id: number; name: string; lease: number; unit: number };
    db.prepare('UPDATE resident SET email = ?, email_ok = 1 WHERE id = ?').run(emailOf('resident'), found.id);
    return { id: found.id, lease: found.lease, unit: found.unit, name: found.name };
  } finally {
    db.close();
  }
}

/**
 * The office accounts are the people the seed's staff rows name: each takes its staff row's email, so `me` reads
 * the row and Today greets Maya, not an anonymous manager. The technician is the one with the most scheduled visits:
 * the seed hands its few open repairs to technicians at random, so the first one can have none on a given day.
 */
function linkStaff(database: string, resident: string): { names: Record<Role, string>; ids: Record<Role, number> } {
  const db = new DatabaseSync(database);
  try {
    const names = { resident, admin: 'Taylor Brooks' } as Record<Role, string>;
    const ids = {} as Record<Role, number>;
    for (const role of ['manager', 'leasing', 'technician', 'accountant'] as const) {
      const row = db
        .prepare(
          `SELECT s.id, s.name FROM staff s WHERE s.role = ? AND s.active = 1
            ORDER BY (SELECT count(*) FROM maintenance_request m WHERE m.assigned_to = s.id AND m.status = 'scheduled') DESC, s.id
            LIMIT 1`,
        )
        .get(role) as {
        id: number;
        name: string;
      };
      db.prepare('UPDATE staff SET email = ? WHERE id = ?').run(emailOf(role), row.id);
      names[role] = row.name;
      ids[role] = row.id;
    }
    return { names, ids };
  } finally {
    db.close();
  }
}
