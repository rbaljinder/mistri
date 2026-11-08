/**
 * Commons' door for someone who has never been in: what the forum is, the threads busy right now and the ones with the
 * most to read, and every board with what belongs there. A bare page, so it draws its own bar, and with no sidebar
 * every way in is one of its own: the latest threads, a board, a thread, and Join or sign in.
 *
 * Public: a forum is read signed out (`auth.public` already grants every table it reads), and a signed-in member who
 * lands here is offered the boards instead of the sign-in. It reads only what the welcome page reads, and runs nothing.
 */
import type { ReactNode } from 'react';
import {
  Button,
  Cluster,
  definePage,
  Empty,
  Grid,
  Icon,
  List,
  Loaded,
  Panel,
  Row,
  useDeployment,
  useFile,
  useFormat,
  useNavigate,
  useViewer,
} from '@mistriwork/mistri/page';
import './start-here.css';

const page = definePage({
  label: 'Start here',
  description: 'What Commons is, what is busy, and where everything is.',
  icon: 'house',
  // In the top menu after Members, so a visitor finds it from anywhere; its own bar and buttons are the way back.
  nav: { position: 4 },
  public: true,
  layout: 'bare',
  reads: ['board', 'thread', 'member', 'site_image'],
  component: StartHere,
});
export default page;

function StartHere(): ReactNode {
  const { name } = useDeployment();
  const { signedIn } = useViewer();
  const nav = useNavigate();
  const photo = useFile('site_image')({ id: 1 });
  const boards = page.useRows('board', { show: ['id', 'name', 'description', 'threads', 'replies'], sort: 'position', limit: 12 });
  return (
    <div className="c-page-start-here">
      <header className="c-page-start-here-bar">
        <p className="c-page-start-here-name">
          <Icon name="wrench" /> {name}
        </p>
        {/* No public address for the sign-in: relative to this page, it is the App's own `sign-in`, at the root or under a prefix. */}
        {signedIn ? null : <a href="sign-in">Sign in</a>}
      </header>
      <section className="c-page-start-here-hero">
        <div className="c-page-start-here-intro">
          <h2>Welcome to {name}</h2>
          <p>
            A forum for people who build things: circuits, keyboards, prints, furniture and instruments. Read anything without an account;
            join to start threads, reply and react.
          </p>
          <Row gap="tight">
            <Button intent="primary" onClick={() => nav.openView('latest')}>
              Read the latest threads
            </Button>
            {signedIn ? (
              <Button intent="secondary" onClick={() => nav.openView('boards')}>
                Browse the boards
              </Button>
            ) : (
              <a className="c-page-start-here-join" href="sign-in">
                Join or sign in
              </a>
            )}
          </Row>
        </div>
        {photo && <img src={photo} alt="A workbench from above: a keyboard, a circuit board, two printed vases and a wooden box." />}
      </section>
      <Grid>
        <Panel title="Busy right now" width="half">
          <Threads sort="last_activity desc" label="Busy right now" />
        </Panel>
        <Panel title="Most to read" width="half">
          <Threads sort="replies desc, last_activity desc" label="Most to read" />
        </Panel>
        <Panel title="The boards" width="full">
          <Loaded query={boards} empty={<Empty title="No boards yet" />} height={240}>
            {(rows) => (
              <Cluster min="15rem">
                {rows.map((board) => (
                  <button
                    key={board.id}
                    type="button"
                    className="c-page-start-here-board"
                    onClick={() => nav.openRecord('board', { id: board.id })}
                  >
                    <strong>{board.name}</strong>
                    <span>{board.description}</span>
                    <small>
                      {count(board.threads, 'thread')} · {count(board.replies, 'reply', 'replies')}
                    </small>
                  </button>
                ))}
              </Cluster>
            )}
          </Loaded>
        </Panel>
      </Grid>
    </div>
  );
}

/** Five listed threads in one order, each a way into its thread: its board, who started it and when it last moved. */
function Threads({ sort, label }: { sort: string; label: string }): ReactNode {
  const nav = useNavigate();
  const format = useFormat();
  return (
    <List
      from="thread"
      query="listed"
      show={['id', 'title', 'board_id.name', 'author_id.display_name', 'replies', 'last_activity']}
      sort={sort}
      limit={5}
      label={label}
      empty={<Empty title="No threads yet" description="The first one starts the forum." />}
    >
      {(thread) => (
        <button type="button" className="c-page-start-here-thread" onClick={() => nav.openRecord('thread', { id: thread.id })}>
          <strong>{thread.title}</strong>
          <span>
            {[
              thread['board_id.name'],
              thread['author_id.display_name'],
              count(thread.replies, 'reply', 'replies'),
              thread.last_activity && format.relative(thread.last_activity),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </button>
      )}
    </List>
  );
}

const count = (n: unknown, one: string, many = `${one}s`) => `${Number(n ?? 0)} ${n === 1 ? one : many}`;
