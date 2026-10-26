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
      CREATE TABLE member(id INTEGER PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE project(id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('planned','active','complete')), lead_id INTEGER REFERENCES member(id), target_on DATE, summary TEXT, health INTEGER CHECK(health BETWEEN 1 AND 5));
      CREATE TABLE cycle(id INTEGER PRIMARY KEY, name TEXT NOT NULL, starts_on DATE NOT NULL, ends_on DATE NOT NULL, goal TEXT);
      CREATE TABLE issue(id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog','ready','in_progress','in_review','done','canceled')), priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('urgent','high','normal','low')), assignee_id INTEGER REFERENCES member(id), project_id INTEGER REFERENCES project(id), cycle_id INTEGER REFERENCES cycle(id), cancel_note TEXT, rank REAL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE comment(id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, issue_id INTEGER NOT NULL REFERENCES issue(id), author_id INTEGER NOT NULL REFERENCES member(id), created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE attachment(id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issue(id), file_name TEXT NOT NULL, content_type TEXT, byte_size INTEGER, data BLOB NOT NULL, added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE label(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, tone TEXT NOT NULL DEFAULT 'neutral' CHECK(tone IN ('good','warn','bad','info','neutral')));
      CREATE TABLE issue_label(id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issue(id), label_id INTEGER NOT NULL REFERENCES label(id), UNIQUE(issue_id, label_id));
      -- The references a record's lists find their rows by (mistri check names each).
      CREATE INDEX issue_project ON issue(project_id);
      CREATE INDEX issue_cycle ON issue(cycle_id);
      CREATE INDEX attachment_issue ON attachment(issue_id);
      BEGIN;`);
    ['Maya Chen', 'Theo Laurent', 'Ari Patel', 'Sam Rivera', 'Noor Ali'].forEach((name, i) =>
      db
        .prepare('INSERT INTO member VALUES(?,?,?,?)')
        .run(i + 1, name, i % 2 ? 'Experience' : 'Platform', i === 4 ? 'Designer' : 'Engineer'),
    );
    const projects = [
      ['Workspace foundations', 'active', 1, '2026-09-25', 'Predictable navigation and ownership across every workspace.', 4],
      ['Search quality', 'active', 3, '2026-10-09', 'Find the right issue with useful ranking and precise filters.', 3],
      ['Accessible authoring', 'planned', 5, '2026-10-23', 'Keyboard-complete controls and readable interaction states.', 5],
    ];
    projects.forEach((project, i) => db.prepare('INSERT INTO project VALUES(?,?,?,?,?,?,?)').run(i + 1, ...project));
    [
      ['Cycle 18', '2026-08-31', '2026-09-11', 'Ship the workspace foundation'],
      ['Cycle 19', '2026-09-14', '2026-09-25', 'Search and navigation polish'],
      ['Cycle 20', '2026-09-28', '2026-10-09', 'Accessible authoring'],
    ].forEach((cycle, i) => db.prepare('INSERT INTO cycle VALUES(?,?,?,?,?)').run(i + 1, ...cycle));
    const titles = [
      'Preserve filters when opening an issue',
      'Repair keyboard focus after a dialog closes',
      'Index project descriptions',
      'Keep drafts when switching workspaces',
      'Add cycle summary to project details',
      'Improve empty search results',
      'Expose priority in compact issue lists',
      'Support long project names',
      'Audit contrast in dark mode',
      'Restore list position after navigation',
      'Make assignee search handle accents',
      'Clarify failed save recovery',
      'Group search results by project',
      'Keep status controls stable while saving',
      'Add accessible names to icon actions',
      'Refine issue creation defaults',
      'Persist density per workspace',
      'Remove duplicate notification events',
      'Announce background refresh failures',
      'Add deterministic sorting to queues',
      'Support unassigned issue filters',
      'Review date boundaries across time zones',
      'Document workspace permissions',
      'Test nested action keyboard access',
    ];
    const statuses = ['in_progress', 'ready', 'in_review', 'backlog', 'done', 'ready'];
    titles.forEach((title, i) =>
      db
        .prepare(
          'INSERT INTO issue(id,name,description,status,priority,assignee_id,project_id,cycle_id,rank,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          i + 1,
          title,
          `${title}.\n\nAcceptance: cover the normal path, an empty state, and recovery after a failed request. Keep the behavior consistent on desktop and mobile.`,
          statuses[i % 6],
          ['urgent', 'high', 'normal', 'normal', 'low'][i % 5],
          (i % 5) + 1,
          (i % 3) + 1,
          i < 15 ? 1 : i < 21 ? 2 : null,
          (i + 1) * 1024,
          '2026-09-01 09:00:00',
        ),
    );
    for (let i = 0; i < 24; i++) {
      db.prepare('INSERT INTO comment VALUES(?,?,?,?,?,?)').run(
        i + 1,
        i % 2 ? 'Implementation notes' : 'Scope agreed',
        i % 2
          ? 'The regression case is captured. Next step is verifying the narrow layout and keyboard path.'
          : 'Keep this change focused on the existing workflow. A separate issue will cover additional shortcuts.',
        Math.floor(i / 2) + 1,
        (i % 5) + 1,
        `2026-09-0${3 + (i % 4)} 10:30:00`,
      );
    }
    // Labels, and one or two on every issue: an issue's labels are link rows, one per label.
    [
      ['bug', 'bad'],
      ['design', 'info'],
      ['performance', 'warn'],
      ['accessibility', 'good'],
      ['docs', 'neutral'],
    ].forEach(([name, tone], i) => db.prepare('INSERT INTO label VALUES(?,?,?)').run(i + 1, name, tone));
    let link = 0;
    for (let issue = 1; issue <= titles.length; issue++) {
      for (const label of [(issue % 5) + 1, ...(issue % 3 === 0 ? [((issue + 2) % 5) + 1] : [])])
        db.prepare('INSERT INTO issue_label VALUES(?,?,?)').run(++link, issue, label);
    }
    // Files on the first issues: the bytes in a BLOB, with the name, type and size an upload records.
    [
      [
        1,
        'repro-steps.txt',
        'text/plain',
        '1. Open an issue on a narrow screen.\n2. Rotate to landscape.\n3. The header overlaps the title.\n',
      ],
      [1, 'error-log.txt', 'text/plain', 'GET /api/view/run 200 41ms\nPOST /api/update 409 12ms record_conflict\n'],
      [2, 'layout-notes.md', 'text/markdown', '# Layout notes\n\nKeep the side panel at 320px; stack it under 900px.\n'],
    ].forEach(([issue, name, type, text], i) => {
      const bytes = Buffer.from(text);
      db.prepare('INSERT INTO attachment VALUES(?,?,?,?,?,?,?)').run(
        i + 1,
        issue,
        name,
        type,
        bytes.byteLength,
        bytes,
        `2026-09-0${4 + i} 11:15:00`,
      );
    });
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'thread', url: file, writable: true }] }, null, 2)}\n`, {
    flag: 'wx',
  });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(seed(process.argv[2] ?? '.demo/thread.db'));
