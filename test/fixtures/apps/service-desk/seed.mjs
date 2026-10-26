import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function seed(file) {
  file = resolve(file);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new database path.`);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      BEGIN;
      CREATE TABLE location(id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, timezone TEXT NOT NULL);
      CREATE TABLE department(id INTEGER PRIMARY KEY, name TEXT NOT NULL, cost_center TEXT NOT NULL UNIQUE);
      CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, department_id INTEGER NOT NULL REFERENCES department(id), location_id INTEGER NOT NULL REFERENCES location(id), role TEXT NOT NULL);
      CREATE TABLE support_team(id INTEGER PRIMARY KEY, name TEXT NOT NULL, lead_id INTEGER NOT NULL REFERENCES person(id), coverage TEXT NOT NULL);
      CREATE TABLE team_member(id INTEGER PRIMARY KEY, name TEXT NOT NULL, team_id INTEGER NOT NULL REFERENCES support_team(id), person_id INTEGER NOT NULL REFERENCES person(id), UNIQUE(team_id, person_id));
      CREATE TABLE vendor(id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact_email TEXT NOT NULL, support_tier TEXT NOT NULL);
      CREATE TABLE sla_policy(id INTEGER PRIMARY KEY, name TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('critical','high','normal','low')), response_minutes INTEGER NOT NULL CHECK(response_minutes>0), resolution_minutes INTEGER NOT NULL CHECK(resolution_minutes>0), calendar TEXT NOT NULL);
      CREATE TABLE service(id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES person(id), team_id INTEGER NOT NULL REFERENCES support_team(id), criticality TEXT NOT NULL CHECK(criticality IN ('critical','high','normal')), status TEXT NOT NULL CHECK(status IN ('operational','degraded','maintenance')), vendor_id INTEGER REFERENCES vendor(id));
      CREATE TABLE asset(id INTEGER PRIMARY KEY, name TEXT NOT NULL, asset_tag TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('server','laptop','network','application')), service_id INTEGER NOT NULL REFERENCES service(id), location_id INTEGER NOT NULL REFERENCES location(id), assigned_to INTEGER REFERENCES person(id), vendor_id INTEGER NOT NULL REFERENCES vendor(id), status TEXT NOT NULL CHECK(status IN ('in_service','maintenance','retired')), purchased_on DATE NOT NULL);
      CREATE TABLE asset_relation(id INTEGER PRIMARY KEY, name TEXT NOT NULL, asset_id INTEGER NOT NULL REFERENCES asset(id), depends_on INTEGER NOT NULL REFERENCES asset(id), kind TEXT NOT NULL CHECK(kind IN ('depends_on','hosted_on','connects_to')), CHECK(asset_id<>depends_on));
      CREATE TABLE problem(id INTEGER PRIMARY KEY, name TEXT NOT NULL, service_id INTEGER NOT NULL REFERENCES service(id), owner_id INTEGER NOT NULL REFERENCES person(id), status TEXT NOT NULL DEFAULT 'investigating' CHECK(status IN ('investigating','known_error','resolved')), root_cause TEXT, workaround TEXT);
      CREATE TABLE incident(id INTEGER PRIMARY KEY, name TEXT NOT NULL, reference TEXT NOT NULL UNIQUE DEFAULT ('INC-' || lower(hex(randomblob(4)))), description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','triage','in_progress','pending','resolved','closed')), priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('critical','high','normal','low')), caller_id INTEGER NOT NULL REFERENCES person(id), service_id INTEGER NOT NULL REFERENCES service(id), asset_id INTEGER REFERENCES asset(id), team_id INTEGER NOT NULL REFERENCES support_team(id), assignee_id INTEGER REFERENCES person(id), problem_id INTEGER REFERENCES problem(id), sla_id INTEGER NOT NULL REFERENCES sla_policy(id), opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, due_at TIMESTAMP, resolution TEXT);
      CREATE TABLE incident_note(id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, incident_id INTEGER NOT NULL REFERENCES incident(id), author_id INTEGER NOT NULL REFERENCES person(id), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE change_request(id INTEGER PRIMARY KEY, name TEXT NOT NULL, reference TEXT NOT NULL UNIQUE DEFAULT ('CHG-' || lower(hex(randomblob(4)))), service_id INTEGER NOT NULL REFERENCES service(id), owner_id INTEGER NOT NULL REFERENCES person(id), team_id INTEGER NOT NULL REFERENCES support_team(id), kind TEXT NOT NULL DEFAULT 'normal' CHECK(kind IN ('standard','normal','emergency')), risk TEXT NOT NULL DEFAULT 'medium' CHECK(risk IN ('low','medium','high')), status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','assess','authorize','scheduled','implement','review','closed','canceled')), starts_at TIMESTAMP, ends_at TIMESTAMP, reason TEXT NOT NULL, implementation_plan TEXT, rollback_plan TEXT, validation_plan TEXT, problem_id INTEGER REFERENCES problem(id), CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at>starts_at));
      CREATE TABLE change_task(id INTEGER PRIMARY KEY, name TEXT NOT NULL, change_id INTEGER NOT NULL REFERENCES change_request(id), owner_id INTEGER NOT NULL REFERENCES person(id), status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done','blocked')), due_at TIMESTAMP, instructions TEXT);
      CREATE TABLE change_approval(id INTEGER PRIMARY KEY, name TEXT NOT NULL, change_id INTEGER NOT NULL REFERENCES change_request(id), reviewer_id INTEGER NOT NULL REFERENCES person(id), decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected')), rationale TEXT);
      CREATE TABLE change_note(id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, change_id INTEGER NOT NULL REFERENCES change_request(id), author_id INTEGER NOT NULL REFERENCES person(id), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE catalog_category(id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL);
      CREATE TABLE catalog_item(id INTEGER PRIMARY KEY, name TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES catalog_category(id), service_id INTEGER NOT NULL REFERENCES service(id), description TEXT NOT NULL, price REAL NOT NULL CHECK(price>=0), fulfillment_days INTEGER NOT NULL CHECK(fulfillment_days>=0), approval_required BOOLEAN NOT NULL DEFAULT 1, active BOOLEAN NOT NULL DEFAULT 1);
      CREATE TABLE service_request(id INTEGER PRIMARY KEY, name TEXT NOT NULL, reference TEXT NOT NULL UNIQUE DEFAULT ('REQ-' || lower(hex(randomblob(4)))), requested_for INTEGER NOT NULL REFERENCES person(id), department_id INTEGER NOT NULL REFERENCES department(id), status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','awaiting_approval','approved','fulfilling','completed','canceled')), justification TEXT NOT NULL, opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, needed_on DATE);
      CREATE TABLE request_item(id INTEGER PRIMARY KEY, name TEXT NOT NULL, request_id INTEGER NOT NULL REFERENCES service_request(id), catalog_item_id INTEGER NOT NULL REFERENCES catalog_item(id), quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity>0), status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','ordered','delivered','canceled')), specifications TEXT);
      CREATE TABLE request_approval(id INTEGER PRIMARY KEY, name TEXT NOT NULL, request_id INTEGER NOT NULL REFERENCES service_request(id), reviewer_id INTEGER NOT NULL REFERENCES person(id), decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected')), rationale TEXT);
      CREATE TABLE purchase_order(id INTEGER PRIMARY KEY, name TEXT NOT NULL, reference TEXT NOT NULL UNIQUE DEFAULT ('PO-' || lower(hex(randomblob(4)))), vendor_id INTEGER NOT NULL REFERENCES vendor(id), buyer_id INTEGER NOT NULL REFERENCES person(id), status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','part_received','received','canceled')), ordered_on DATE, expected_on DATE, shipping_location_id INTEGER NOT NULL REFERENCES location(id));
      CREATE TABLE order_line(id INTEGER PRIMARY KEY, name TEXT NOT NULL, order_id INTEGER NOT NULL REFERENCES purchase_order(id), request_item_id INTEGER NOT NULL UNIQUE REFERENCES request_item(id), quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity>0), unit_price REAL NOT NULL CHECK(unit_price>=0), received_quantity INTEGER NOT NULL DEFAULT 0 CHECK(received_quantity>=0 AND received_quantity<=quantity));
      CREATE TABLE fulfillment_task(id INTEGER PRIMARY KEY, name TEXT NOT NULL, request_item_id INTEGER NOT NULL REFERENCES request_item(id), team_id INTEGER NOT NULL REFERENCES support_team(id), assignee_id INTEGER REFERENCES person(id), status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','done')), due_on DATE, instructions TEXT);
      CREATE TABLE knowledge_article(id INTEGER PRIMARY KEY, name TEXT NOT NULL, service_id INTEGER NOT NULL REFERENCES service(id), author_id INTEGER NOT NULL REFERENCES person(id), status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','retired')), summary TEXT NOT NULL, body TEXT NOT NULL, reviewed_on DATE);
    `);
    // Only seed-owned identifiers enter this helper; all data values are bound.
    const insert = (table, rows) => {
      for (const row of rows) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(
          ...Object.values(row),
        );
      }
    };
    const many = (count, fn) => Array.from({ length: count }, (_, i) => ({ id: i + 1, ...fn(i) }));
    const people = [
      'Maya Chen',
      'Theo Laurent',
      'Ari Patel',
      'Sam Rivera',
      'Noor Ali',
      'Jordan Ellis',
      'Lena Ortiz',
      'Alex Kim',
      'Priya Shah',
      'Owen Brooks',
      'Imani Reed',
      'Robin Park',
    ];
    insert('location', [
      { id: 1, name: 'New York HQ', city: 'New York', timezone: 'America/New_York' },
      { id: 2, name: 'London office', city: 'London', timezone: 'Europe/London' },
      { id: 3, name: 'Singapore hub', city: 'Singapore', timezone: 'Asia/Singapore' },
    ]);
    insert(
      'department',
      many(4, (i) => ({ name: ['Technology', 'Customer Operations', 'Finance', 'People'][i], cost_center: `CC-${100 + i}` })),
    );
    insert(
      'person',
      many(12, (i) => ({
        name: people[i],
        email: `person${i + 1}@atlas.example`,
        department_id: (i % 4) + 1,
        location_id: (i % 3) + 1,
        role: i < 4 ? 'Service owner' : i < 8 ? 'Support engineer' : 'Business partner',
      })),
    );
    insert(
      'support_team',
      many(4, (i) => ({
        name: ['Service Desk', 'Cloud Operations', 'Workplace Technology', 'Business Systems'][i],
        lead_id: i + 1,
        coverage: i === 1 ? '24x7' : 'Weekdays 08:00-18:00 local',
      })),
    );
    insert(
      'team_member',
      many(12, (i) => ({ name: people[i], team_id: (i % 4) + 1, person_id: i + 1 })),
    );
    insert(
      'vendor',
      many(3, (i) => ({
        name: ['Northstar Computing', 'Meridian Networks', 'Clearpath Software'][i],
        contact_email: `support${i + 1}@vendor.example`,
        support_tier: i === 1 ? '24x7 enterprise' : 'Business hours',
      })),
    );
    insert(
      'sla_policy',
      many(4, (i) => ({
        name: ['P1 critical', 'P2 high', 'P3 normal', 'P4 low'][i],
        priority: ['critical', 'high', 'normal', 'low'][i],
        response_minutes: [15, 60, 240, 480][i],
        resolution_minutes: [240, 480, 1440, 4320][i],
        calendar: i === 0 ? '24x7' : 'Business hours',
      })),
    );
    const services = [
      'Identity and access',
      'Employee workplace',
      'Corporate network',
      'Customer portal',
      'Finance platform',
      'Collaboration',
    ];
    insert(
      'service',
      many(6, (i) => ({
        name: services[i],
        description: `${services[i]} service and its operational dependencies.`,
        owner_id: (i % 4) + 1,
        team_id: (i % 4) + 1,
        criticality: i % 2 ? 'high' : 'critical',
        status: i === 0 ? 'degraded' : 'operational',
        vendor_id: (i % 3) + 1,
      })),
    );
    insert(
      'asset',
      many(48, (i) => ({
        name: `${services[i % 6]} ${['node', 'endpoint', 'gateway', 'application'][i % 4]} ${Math.floor(i / 6) + 1}`,
        asset_tag: `AT-${1000 + i}`,
        kind: ['server', 'laptop', 'network', 'application'][i % 4],
        service_id: (i % 6) + 1,
        location_id: (i % 3) + 1,
        assigned_to: (i % 12) + 1,
        vendor_id: (i % 3) + 1,
        status: i % 11 === 0 ? 'maintenance' : 'in_service',
        purchased_on: '2025-06-15',
      })),
    );
    insert(
      'asset_relation',
      many(24, (i) => ({ name: 'Service dependency', asset_id: i + 1, depends_on: i + 25, kind: 'depends_on' })),
    );
    insert(
      'problem',
      many(6, (i) => ({
        name: `${services[i]} recurring interruptions`,
        service_id: i + 1,
        owner_id: (i % 4) + 1,
        status: i % 2 ? 'known_error' : 'investigating',
        root_cause: i % 2 ? 'Connection pool saturation during the morning peak.' : null,
        workaround: 'Reduce concurrent sessions and monitor queue latency.',
      })),
    );
    const symptoms = [
      'Sign-in requests timing out',
      'Managed device enrollment stalled',
      'Office connectivity intermittent',
      'Customer sessions failing',
      'Invoice export unavailable',
      'Meeting audio dropping',
    ];
    insert(
      'incident',
      many(84, (i) => ({
        name: `${symptoms[i % 6]}${i < 6 ? '' : ` - case ${i + 1}`}`,
        reference: `INC-${String(1001 + i)}`,
        description: `Reported by ${people[i % 12]}. ${symptoms[i % 6]} during normal business operations. Confirm impact with the caller before resolving.`,
        status: ['triage', 'in_progress', 'pending', 'new', 'resolved', 'closed'][i % 6],
        priority: ['critical', 'high', 'normal', 'low'][i % 4],
        caller_id: (i % 12) + 1,
        service_id: (i % 6) + 1,
        asset_id: (i % 48) + 1,
        team_id: ((i % 6) % 4) + 1,
        assignee_id: ((i % 6) % 4) + 5,
        problem_id: i % 3 === 0 ? (i % 6) + 1 : null,
        sla_id: (i % 4) + 1,
        opened_at: `2026-09-0${1 + (i % 5)} 08:30:00`,
        due_at: `2026-09-0${2 + (i % 5)} 12:30:00`,
        resolution: i % 6 >= 4 ? 'Service restored and confirmed with the caller.' : null,
      })),
    );
    insert(
      'incident_note',
      many(168, (i) => ({
        name: i % 2 ? 'Investigation update' : 'Caller impact recorded',
        body:
          i % 2
            ? 'Reviewed service health and dependency logs. Continue monitoring the affected component.'
            : 'Caller confirmed the affected workflow and an available workaround.',
        incident_id: Math.floor(i / 2) + 1,
        author_id: (Math.floor(i / 2) % 4) + 5,
        created_at: `2026-09-0${2 + (Math.floor(i / 2) % 5)} ${i % 2 ? '11' : '09'}:00:00`,
      })),
    );
    insert(
      'change_request',
      many(30, (i) => ({
        name: `${services[i % 6]} - ${['certificate rotation', 'client upgrade', 'gateway patch', 'capacity increase', 'connection tuning'][i % 5]}`,
        reference: `CHG-${2001 + i}`,
        service_id: (i % 6) + 1,
        owner_id: (i % 4) + 1,
        team_id: ((i % 6) % 4) + 1,
        kind: i % 9 === 0 ? 'emergency' : 'normal',
        risk: ['high', 'medium', 'low'][i % 3],
        status: ['assess', 'authorize', 'scheduled', 'implement', 'review', 'closed'][i % 6],
        starts_at: `2026-09-${String(8 + (i % 20)).padStart(2, '0')} 22:00:00`,
        ends_at: `2026-09-${String(8 + (i % 20)).padStart(2, '0')} 23:30:00`,
        reason: 'Reduce recurring service interruptions and remove unsupported configuration.',
        implementation_plan: 'Capture the baseline. Apply the change to one node. Validate health before continuing.',
        rollback_plan: 'Restore the previous configuration and verify the baseline checks.',
        validation_plan: 'Confirm successful sign-in, error rate and latency with the service owner.',
        problem_id: (i % 6) + 1,
      })),
    );
    insert(
      'change_task',
      many(90, (i) => ({
        name: ['Capture baseline', 'Implement approved plan', 'Validate service health'][i % 3],
        change_id: Math.floor(i / 3) + 1,
        owner_id: (i % 4) + 5,
        status: i % 3 === 0 ? 'done' : 'open',
        due_at: '2026-09-20 22:00:00',
        instructions: 'Record results in the change work notes. Escalate unexpected impact to the change owner.',
      })),
    );
    insert(
      'change_approval',
      many(60, (i) => ({
        name: i % 2 ? 'Service owner review' : 'Technical risk review',
        change_id: Math.floor(i / 2) + 1,
        reviewer_id: (i % 4) + 1,
        decision: Math.floor(i / 2) % 6 >= 2 ? 'approved' : 'pending',
        rationale: Math.floor(i / 2) % 6 >= 2 ? 'Implementation and rollback plans reviewed.' : null,
      })),
    );
    insert(
      'change_note',
      many(30, (i) => ({
        name: 'Change scope recorded',
        body: 'Affected service, maintenance window and rollback ownership are recorded for review.',
        change_id: i + 1,
        author_id: (i % 4) + 1,
        created_at: '2026-09-05 10:00:00',
      })),
    );
    insert(
      'catalog_category',
      many(4, (i) => ({
        name: ['Hardware', 'Access', 'Software', 'Workplace'][i],
        description: [
          'Managed equipment and accessories',
          'Business application permissions',
          'Licensed tools and subscriptions',
          'Employee setup and support',
        ][i],
      })),
    );
    const catalog = [
      'Engineering laptop',
      'Secure remote access',
      'Design software license',
      'New starter setup',
      'External display',
      'Finance application access',
      'Development environment',
      'Desk relocation',
      'Replacement headset',
      'Privileged access review',
      'Analytics workspace',
      'Meeting room setup',
    ];
    insert(
      'catalog_item',
      many(12, (i) => ({
        name: catalog[i],
        category_id: (i % 4) + 1,
        service_id: (i % 6) + 1,
        description: `${catalog[i]} with standard configuration, service desk support and documented handover.`,
        price: [1850, 0, 480, 250, 420, 0, 95, 150, 120, 0, 300, 600][i],
        fulfillment_days: [5, 1, 2, 5][i % 4],
        approval_required: i % 3 ? 1 : 0,
        active: 1,
      })),
    );
    insert(
      'service_request',
      many(24, (i) => ({
        name: `${catalog[i % 12]} for ${people[i % 12]}`,
        reference: `REQ-${3001 + i}`,
        requested_for: (i % 12) + 1,
        department_id: (i % 4) + 1,
        status: ['submitted', 'awaiting_approval', 'approved', 'fulfilling', 'completed', 'canceled'][i % 6],
        justification: 'Required for assigned project work. Charge to the requesting department.',
        opened_at: '2026-09-03 09:00:00',
        needed_on: '2026-09-18',
      })),
    );
    insert(
      'request_item',
      many(48, (i) => ({
        name: catalog[i % 12],
        request_id: Math.floor(i / 2) + 1,
        catalog_item_id: (i % 12) + 1,
        quantity: 1,
        status: Math.floor(i / 2) % 6 === 4 ? 'delivered' : Math.floor(i / 2) % 6 === 5 ? 'canceled' : 'requested',
        specifications: 'Standard configuration. Confirm delivery location with the requester.',
      })),
    );
    insert(
      'request_approval',
      many(24, (i) => ({
        name: 'Department budget review',
        request_id: i + 1,
        reviewer_id: (i % 4) + 1,
        decision: i % 6 >= 2 && i % 6 < 5 ? 'approved' : i % 6 === 5 ? 'rejected' : 'pending',
        rationale: null,
      })),
    );
    // Orders exist only for approved, fulfilling or completed requests.
    const purchasable = Array.from({ length: 48 }, (_, i) => i + 1).filter((id) => [2, 3, 4].includes(Math.floor((id - 1) / 2) % 6));
    insert(
      'purchase_order',
      many(12, (i) => ({
        name: `Equipment and access batch ${i + 1}`,
        reference: `PO-${4001 + i}`,
        vendor_id: (i % 3) + 1,
        buyer_id: 11,
        status: ['issued', 'part_received', 'received'][i % 3],
        ordered_on: '2026-09-04',
        expected_on: '2026-09-15',
        shipping_location_id: (i % 3) + 1,
      })),
    );
    insert(
      'order_line',
      purchasable.map((id, i) => ({
        id: i + 1,
        name: catalog[(id - 1) % 12],
        order_id: Math.floor(i / 2) + 1,
        request_item_id: id,
        quantity: 1,
        unit_price: [1850, 0, 480, 250, 420, 0, 95, 150, 120, 0, 300, 600][(id - 1) % 12],
        received_quantity: Math.floor(i / 2) % 3 === 2 || (Math.floor(i / 2) % 3 === 1 && i % 2 === 0) ? 1 : 0,
      })),
    );
    for (const row of db.prepare('SELECT request_item_id, received_quantity FROM order_line').all())
      db.prepare('UPDATE request_item SET status=? WHERE id=?').run(row.received_quantity ? 'delivered' : 'ordered', row.request_item_id);
    insert(
      'fulfillment_task',
      purchasable.map((id, i) => ({
        id: i + 1,
        name: `Prepare ${catalog[(id - 1) % 12]}`,
        request_item_id: id,
        team_id: ((id - 1) % 4) + 1,
        assignee_id: ((id - 1) % 4) + 5,
        status: Math.floor(i / 2) % 3 === 2 ? 'done' : 'open',
        due_on: '2026-09-18',
        instructions: 'Verify receipt, configure the item and confirm handover with the requester.',
      })),
    );
    insert(
      'knowledge_article',
      many(12, (i) => ({
        name: `${services[i % 6]} - ${i < 6 ? 'triage checklist' : 'recovery procedure'}`,
        service_id: (i % 6) + 1,
        author_id: (i % 4) + 1,
        status: 'published',
        summary: 'Known symptoms, safe diagnostics and escalation ownership.',
        body: 'Confirm impact and record the incident reference. Check service status and recent changes. Use the documented workaround; escalate when baseline health cannot be restored.',
        reviewed_on: '2026-09-01',
      })),
    );
    // Index every child reference used by record sections and relationship navigation.
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all())
        db.exec(`CREATE INDEX "idx_${name}_${fk.from}" ON "${name}"("${fk.from}")`);
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error('Seed contains invalid relationships.');
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'service-desk', url: file, writable: true }] }, null, 2)}\n`, {
    flag: 'wx',
  });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(seed(process.argv[2] ?? '.demo/service-desk.db'));
