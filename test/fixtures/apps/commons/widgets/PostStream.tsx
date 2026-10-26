/**
 * A thread's posts as a forum reads them: oldest first, each whole — who
 * wrote it (portrait, name, handle, team), when and whether it was edited,
 * its words in their paragraphs, its photos inline — and under it the
 * reactions it has had and what a reader can do next.
 *
 * It only draws. The posts are the list's own rows (threadPosts in
 * views.ts), paged by the platform; the reactions, photos and portraits of
 * this page's posts are three more reads through the reader's grants. Every
 * change is a posting command through the platform's own pipeline: a
 * reaction chip runs reactToPost with its kind (choosing one given takes it
 * back), Reply and Edit open the command's own form, Report opens the public
 * report form over the page. A signed-out visitor reads it all and is
 * offered only Report; the viewer's own reactions are the ones pressed.
 *
 * A signed-in account that has not joined is granted the posting commands
 * (a role says what an account may do), but each handler refuses it until
 * there is a member row to act as — a precondition only this App knows, so
 * the page cannot learn it from the platform before a click. The stream
 * says it instead: the counts to read, "Join to react" and "Join to reply",
 * each opening the Join form over the post, which comes back live once the
 * member row exists.
 */
import {
  Button,
  Empty,
  useCommand,
  useFile,
  useFormat,
  useNavigate,
  useRows,
  useSectionSize,
  useViewer,
  type ListProps,
} from '@mistriwork/mistri/ui';
import type { Rows } from '../mistri-schema.d.ts';
import type { threadPosts } from '../views.ts';
import './PostStream.css';

type Props = ListProps<typeof threadPosts, Rows>;
type Post = Props['rows'][number];

/** The reactions a post may have, in the order the bar says them: the command's own choices. */
const KINDS = [
  { value: 'like', label: 'Like' },
  { value: 'thanks', label: 'Thanks' },
  { value: 'helpful', label: 'Helpful' },
  { value: 'laugh', label: 'Made me laugh' },
] as const;

/** A post's words as its author broke them: a blank line is a new paragraph, a single break stays a break. */
function Paragraphs({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    <div className="c-post-stream-body">
      {paragraphs.map((paragraph, i) => (
        <p key={i}>{paragraph.split('\n').flatMap((line, j) => (j ? [<br key={`b${j}`} />, line] : [line]))}</p>
      ))}
    </div>
  );
}

/** "in (1, 2, 3)" over the page's ids: one question for every post on it. */
const within = (column: string, ids: readonly unknown[]) => `${column} in (${ids.map((id) => String(id)).join(', ')})`;

export default function PostStream({ rows }: Props) {
  const { compact } = useSectionSize();
  const format = useFormat();
  const viewer = useViewer();
  const { openForm } = useNavigate();
  const react = useCommand('reactToPost');
  const edit = useCommand('editPost');
  const reply = useCommand('replyToThread');
  const portrait = useFile('member_avatar');
  const photo = useFile('post_image');
  const ids = rows.map((post) => post.id);
  const authors = [...new Set(rows.map((post) => post.author_id))];
  const any = ids.length > 0;
  const reactions = useRows('reaction', {
    query: any ? within('post_id', ids) : undefined,
    show: ['post_id', 'kind', 'member_id'],
    limit: 500,
    enabled: any,
  });
  const photos = useRows('post_image', {
    query: any ? within('post_id', ids) : undefined,
    show: ['id', 'post_id', 'caption'],
    sort: 'post_id, position',
    limit: 200,
    enabled: any,
  });
  const portraits = useRows('member_avatar', {
    query: authors.length ? within('member_id', authors) : undefined,
    show: ['id', 'member_id'],
    limit: 100,
    enabled: authors.length > 0,
  });
  /* Which member the signed-in reader joined as: whose reactions are theirs, and which posts. */
  const me = useRows('member', {
    query: `account_id = ${JSON.stringify(viewer.account ?? '')}`,
    show: ['id'],
    limit: 1,
    enabled: viewer.signedIn && Boolean(viewer.account),
  });
  const mine = me.data?.[0]?.id;
  /* Signed in and granted the posting commands, and no member row: every handler would say "Join Commons first". */
  const newcomer = viewer.signedIn && react.granted && me.isSuccess && mine === undefined;
  const join = () => openForm('join');
  if (!rows.length) return <Empty title="No posts in this thread yet." />;

  const portraitOf = new Map((portraits.data ?? []).map((row) => [row.member_id, row.id]));
  const photosOf = (post: Post) => (photos.data ?? []).filter((row) => row.post_id === post.id);
  const tally = (post: Post) => {
    const given = (reactions.data ?? []).filter((row) => row.post_id === post.id);
    return KINDS.map((kind) => ({
      ...kind,
      count: given.filter((row) => row.kind === kind.value).length,
      pressed: mine !== undefined && given.some((row) => row.kind === kind.value && row.member_id === mine),
    }));
  };

  return (
    <ol className="c-post-stream" data-compact={compact ? 'true' : undefined} aria-label="Posts">
      {rows.map((post) => {
        const name = String(post['author_id.display_name'] ?? 'A member');
        const own = mine !== undefined && post.author_id === mine;
        const avatar = portraitOf.get(post.author_id);
        const reactable = react.granted && mine !== undefined && !own && react.available({ id: post.id }) === true;
        const replyable = reply.granted && reply.available({ id: post.thread_id }) === true;
        const busy = react.pending({ id: post.id });
        const team = String(post['author_id.team'] ?? '');
        return (
          <li key={String(post.id)} className="c-post-stream-post">
            <header className="c-post-stream-head">
              {avatar !== undefined ? (
                <img className="c-post-stream-avatar" src={portrait({ id: avatar }, { thumbnail: true })} alt="" width={40} height={40} />
              ) : (
                <span className="c-post-stream-avatar c-post-stream-initials" aria-hidden="true">
                  {name
                    .split(/\s+/)
                    .map((word) => word[0])
                    .slice(0, 2)
                    .join('')}
                </span>
              )}
              <div className="c-post-stream-who">
                <span className="c-post-stream-name">{name}</span>
                <span className="c-post-stream-handle">@{String(post['author_id.handle'] ?? '')}</span>
                {team && team !== 'member' ? <span className="c-post-stream-team">{team === 'admin' ? 'Admin' : 'Moderator'}</span> : null}
              </div>
              <p className="c-post-stream-when">
                <time dateTime={String(post.created_at)} title={format.dateTime(String(post.created_at))}>
                  {format.date(String(post.created_at))}
                </time>
                {post.edited_at ? (
                  <span className="c-post-stream-edited" title={`Edited ${format.dateTime(String(post.edited_at))}`}>
                    {' '}
                    · edited
                  </span>
                ) : null}
                {post.opening ? <span className="c-post-stream-opening"> · started the thread</span> : null}
              </p>
            </header>
            <Paragraphs text={String(post.body ?? '')} />
            {photosOf(post).length > 0 && (
              <ul className="c-post-stream-photos" aria-label={`Photos in ${name}'s post`}>
                {photosOf(post).map((row) => (
                  <li key={String(row.id)}>
                    <a href={photo({ id: row.id })} target="_blank" rel="noreferrer" className="c-post-stream-photo">
                      <img src={photo({ id: row.id }, { thumbnail: true })} alt={String(row.caption ?? 'A photo')} loading="lazy" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <footer className="c-post-stream-foot">
              <div className="c-post-stream-reactions" role="group" aria-label={`Reactions to ${name}'s post`}>
                {tally(post).map((kind) =>
                  reactable ? (
                    <button
                      key={kind.value}
                      type="button"
                      className="c-post-stream-chip"
                      aria-pressed={kind.pressed}
                      disabled={busy}
                      title={kind.pressed ? `Take back your ${kind.label.toLowerCase()}` : kind.label}
                      onClick={() => {
                        void react.run({ id: post.id }, { kind: kind.value });
                      }}
                    >
                      {kind.label}
                      {kind.count ? <span className="c-post-stream-count">{kind.count}</span> : null}
                    </button>
                  ) : kind.count ? (
                    <span key={kind.value} className="c-post-stream-chip" data-pressed={kind.pressed ? 'true' : undefined}>
                      {kind.label}
                      <span className="c-post-stream-count">{kind.count}</span>
                    </span>
                  ) : null,
                )}
                {newcomer && react.available({ id: post.id }) === true && (
                  <Button
                    intent="secondary"
                    size="compact"
                    className="c-post-stream-join"
                    aria-label={`Join to react to ${name}'s post`}
                    onClick={join}
                  >
                    Join to react
                  </Button>
                )}
              </div>
              <div className="c-post-stream-actions">
                {replyable && mine !== undefined && (
                  <Button
                    intent="quiet"
                    size="compact"
                    aria-label={`Reply to ${name}`}
                    onClick={() => {
                      void reply.open({ id: post.thread_id }, undefined, { label: `Replying to ${name}` });
                    }}
                  >
                    Reply
                  </Button>
                )}
                {replyable && newcomer && (
                  <Button intent="quiet" size="compact" aria-label={`Join to reply to ${name}`} onClick={join}>
                    Join to reply
                  </Button>
                )}
                {own && edit.granted && edit.available({ id: post.id }) === true && (
                  <Button
                    intent="quiet"
                    size="compact"
                    aria-label="Edit your post"
                    onClick={() => {
                      void edit.open({ id: post.id }, undefined, { label: 'Your post' });
                    }}
                  >
                    Edit
                  </Button>
                )}
                <Button
                  intent="quiet"
                  size="compact"
                  aria-label={`Report ${name}'s post`}
                  onClick={() => openForm('report-post', { post: String(post.id) })}
                >
                  Report
                </Button>
              </div>
            </footer>
          </li>
        );
      })}
    </ol>
  );
}
