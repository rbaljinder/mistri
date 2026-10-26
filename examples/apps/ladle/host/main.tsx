/**
 * The cooking school's site: a React app of the school's own, with its own header, type and colors (site.css). It is
 * not a mistri App and imports nothing of mistri's but `@mistriwork/mistri/react`.
 *
 *   /         the public schedule, read from the host's own `/schedule.json` (schedule.ts)
 *   /staff/…  the staff desk: the Ladle App, embedded under the site's header through `<App>`
 *
 * The site has no router of its own: its links are ordinary page loads, and inside /staff the App moves the address
 * with `window.history`, which is the Provider's default navigator. A host with a router passes its adapter
 * (`@mistriwork/mistri/react/react-router`, `…/next`, `…/tanstack-router`).
 */
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, Provider } from '@mistriwork/mistri/react';

interface ScheduledClass {
  id: number;
  title: string;
  cuisine: string;
  chef: string;
  startsAt: string;
  price: number;
  seatsLeft: number;
}

const STAFF = '/staff';
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
/* The database keeps the school's wall clock without a zone; it is read as written, never moved to the visitor's. */
const when = (startsAt: string) => {
  const [day, time] = startsAt.split(' ');
  const date = new Date(`${day}T${time}Z`);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
};

function Header({ here }: { here: 'classes' | 'staff' }): ReactNode {
  return (
    <header className="site-header">
      <a className="site-brand" href="/">
        <span className="site-mark" aria-hidden="true">
          ◗
        </span>
        Ladle Cooking School
      </a>
      <nav aria-label="Site">
        <a href="/" aria-current={here === 'classes' ? 'page' : undefined}>
          Classes
        </a>
        <a href={STAFF} aria-current={here === 'staff' ? 'page' : undefined}>
          Staff desk
        </a>
      </nav>
    </header>
  );
}

function Schedule(): ReactNode {
  const [classes, setClasses] = useState<ScheduledClass[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch('/schedule.json')
      .then((reply) => (reply.ok ? reply.json() : Promise.reject(new Error(String(reply.status)))))
      .then((body: { classes: ScheduledClass[] }) => setClasses(body.classes))
      .catch(() => setFailed(true));
  }, []);
  if (failed) return <p className="site-quiet">The schedule could not be read. Call us at (312) 555-0142.</p>;
  if (!classes) return <p className="site-quiet">Reading the schedule…</p>;
  return (
    <ul className="site-classes" aria-label="Upcoming classes">
      {classes.map((lesson) => (
        <li key={lesson.id} className="site-class">
          <p className="site-class-when">{when(lesson.startsAt)}</p>
          <h3>{lesson.title}</h3>
          <p className="site-class-meta">
            {lesson.cuisine} · with {lesson.chef}
          </p>
          <p className="site-class-foot">
            <span className="site-price">{dollars.format(lesson.price)}</span>
            <span className={lesson.seatsLeft ? 'site-seats' : 'site-seats site-full'}>
              {lesson.seatsLeft ? `${lesson.seatsLeft} ${lesson.seatsLeft === 1 ? 'seat' : 'seats'} left` : 'Full'}
            </span>
          </p>
        </li>
      ))}
    </ul>
  );
}

function Home(): ReactNode {
  return (
    <main className="site-main">
      <section className="site-hero">
        <h1>Cook something new this week</h1>
        <p>Small evening and weekend classes in our West Loop kitchen. Aprons, knives and dinner included.</p>
      </section>
      <h2>Upcoming classes</h2>
      <Schedule />
    </main>
  );
}

/* Where the school's chrome ends and the App begins: the site's header and this strip are the school's; inside the
   frame is Ladle, drawn by mistri in its own look, styles scoped to its own elements. */
function Staff(): ReactNode {
  return (
    <main className="site-staff">
      <p className="site-staff-note">Staff only. Below this line is the Ladle App, embedded with @mistriwork/mistri/react.</p>
      <section className="site-embed" aria-label="Ladle staff App">
        <Provider endpoint="/api/tw" onTitle={(title) => (document.title = `${title} · Ladle Cooking School`)}>
          <App app="ladle" basePath={STAFF} fallback={<p className="site-quiet">Opening the staff desk…</p>} />
        </Provider>
      </section>
    </main>
  );
}

function Site(): ReactNode {
  const staff = location.pathname === STAFF || location.pathname.startsWith(`${STAFF}/`);
  return (
    <>
      <Header here={staff ? 'staff' : 'classes'} />
      {staff ? <Staff /> : <Home />}
      <footer className="site-footer">Ladle Cooking School · 1140 W Randolph St, Chicago, IL · (312) 555-0142</footer>
    </>
  );
}

createRoot(document.getElementById('site')!).render(
  <StrictMode>
    <Site />
  </StrictMode>,
);
