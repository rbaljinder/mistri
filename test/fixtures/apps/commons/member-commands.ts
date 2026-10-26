// What a member's verbs do. Server-only, registered through commands.ts and
// never imported from the App graph. Each handler learns who is acting from
// the verified account (`actor`), finds the member that account joined as,
// and checks what the member may do against the stored rows, inside the
// command's one transaction.
import { randomUUID } from 'node:crypto';
import { defineCommand, field, literal, refuse, shape, text } from '@mistriwork/mistri/commands';
import { forum, memberOf, REPORT_REASONS, stamp } from './forum.ts';

/** A warned member's posts wait for a moderator; everyone else's are up at once. */
const reviewed = (standing: string) => (standing === 'warned' ? 'held' : 'published');

export const joinCommunity = defineCommand({
  source: forum,
  target: 'member',
  targets: 'none',
  input: {
    handle: field.text({
      min: 3,
      max: 24,
      case: 'lower',
      pattern: /[a-z0-9_]+/,
      message: 'Three to twenty-four letters, digits or underscores.',
      help: 'How the forum names you in a reply: letters, digits and underscores.',
    }),
    display_name: field.text({ label: 'Your name', max: 60 }),
    location: field.text({ label: 'Where you are', max: 60, optional: true, help: 'A city is plenty.' }),
    bio: field.textarea({ label: 'About you', max: 400, optional: true, help: 'What you make, or want to learn to.' }),
  },
  output: shape({ message: text({ max: 200 }) }),
  async handle({ db, actor, now }, input) {
    if (await db.member.find({ account_id: actor.id })) refuse('This account has already joined Commons.');
    if (await db.member.find({ handle: input.handle })) refuse(`The handle ${input.handle} is taken. Choose another.`);
    // The account's email, from its verified session: what `me` matches a member by (auth.me) and a notice is sent to.
    await db.member.insert({
      handle: input.handle,
      display_name: input.display_name,
      account_id: actor.id,
      email: actor.email ?? null,
      team: 'member',
      standing: 'active',
      location: input.location ?? null,
      bio: input.bio ?? null,
      website: null,
      reputation: 0,
      joined_on: stamp(now()).slice(0, 10),
    });
    return { message: `Welcome, @${input.handle}.` };
  },
});

export const startThread = defineCommand({
  source: forum,
  target: 'thread',
  targets: 'none',
  read: ['board', 'member'],
  write: ['post'],
  input: {
    board: field.reference('board', { by: 'id', labelColumn: 'name', query: 'status = open' }),
    title: field.text({ min: 8, max: 120, help: 'Say what the thread is about: “PETG strings at 240 °C”, not “Help!”.' }),
    body: field.textarea({ label: 'Post', min: 20, max: 8000 }),
  },
  output: shape({ message: text({ max: 200 }) }),
  async handle({ db, actor, now }, input) {
    const member = await memberOf(db, actor);
    const board = (await db.board.find({ id: Number(input.board) })) ?? refuse('invalid_input', 'board');
    if (board.status !== 'open' && member.team === 'member') refuse(`${board.name} is for the moderators’ news. Choose another board.`);
    const status = reviewed(member.standing);
    const at = stamp(now());
    const thread = await db.thread.insert({
      board_id: board.id,
      author_id: member.id,
      title: input.title,
      status: status === 'held' ? 'held' : 'open',
      pinned: false,
      created_at: at,
    });
    await db.post.insert({
      thread_id: thread.id,
      author_id: member.id,
      body: input.body,
      status,
      opening: true,
      created_at: at,
      edited_at: null,
    });
    return { message: status === 'held' ? 'Posted. A moderator will read it before it appears.' : `Posted in ${board.name}.` };
  },
});

export const replyToThread = defineCommand({
  source: forum,
  target: 'thread',
  when: 'status = open',
  read: ['member'],
  write: ['post'],
  input: { body: field.textarea({ label: 'Your reply', min: 2, max: 8000 }) },
  output: shape({ message: text({ max: 200 }) }),
  async handle({ db, record, actor, now }, input) {
    const member = await memberOf(db, actor);
    if (record.status !== 'open') refuse('This thread is locked, so it takes no more replies.');
    const status = reviewed(member.standing);
    await db.post.insert({
      thread_id: record.id,
      author_id: member.id,
      body: input.body,
      status,
      opening: false,
      created_at: stamp(now()),
      edited_at: null,
    });
    return { message: status === 'held' ? 'Posted. A moderator will read it before it appears.' : 'Reply posted.' };
  },
});

export const editPost = defineCommand({
  source: forum,
  target: 'post',
  read: ['member', 'thread'],
  write: ['post_revision'],
  input: { body: field.textarea({ label: 'Post', min: 2, max: 8000, help: 'Moderators can read the version you are replacing.' }) },
  when: 'status in (published, held)',
  // The form opens on the words as they stand.
  initial: ({ record }) => ({ body: record.body }),
  output: shape({ message: literal('Post updated.') }),
  async handle({ db, record, actor, now }, input) {
    const member = await memberOf(db, actor);
    // Only the author edits a post: the stored author, not a field the form sent.
    if (record.author_id !== member.id) refuse('Only the member who wrote a post can edit it.');
    const thread = await db.thread.get({ id: record.thread_id });
    if (thread.status === 'locked') refuse('This thread is locked, so its posts are kept as they are.');
    if (input.body === record.body) return { message: 'Post updated.' as const };
    const at = stamp(now());
    // The words being replaced stay readable beside the post: an edit cannot quietly change a conversation.
    await db.post_revision.insert({ post_id: record.id, body: record.body, replaced_at: at });
    await db.post.update(record, { body: input.body, edited_at: at });
    return { message: 'Post updated.' as const };
  },
});

export const reactToPost = defineCommand({
  source: forum,
  target: 'post',
  read: ['member'],
  write: ['reaction', 'member'],
  input: {
    kind: field.choice(
      [
        { value: 'like', label: 'Like' },
        { value: 'thanks', label: 'Thanks' },
        { value: 'helpful', label: 'Helpful' },
        { value: 'laugh', label: 'Made me laugh' },
      ],
      { label: 'Reaction', help: 'Choosing one you have already given takes it back.' },
    ),
  },
  when: 'status = published',
  output: shape({ message: text({ max: 200 }) }),
  async handle({ db, record, actor, now }, input) {
    const member = await memberOf(db, actor);
    if (record.author_id === member.id) refuse('You cannot react to your own post.');
    const author = await db.member.get({ id: record.author_id });
    const given = await db.reaction.find({ post_id: record.id, member_id: member.id, kind: input.kind });
    // Choosing a reaction again takes it back; the author's reputation follows either way.
    if (given) {
      await db.reaction.remove(given);
      await db.member.update(author, { reputation: Math.max(0, author.reputation - 1) });
      return { message: 'Reaction taken back.' };
    }
    await db.reaction.insert({ post_id: record.id, member_id: member.id, kind: input.kind, created_at: stamp(now()) });
    await db.member.update(author, { reputation: author.reputation + 1 });
    return { message: 'Thanks for reacting.' };
  },
});

/* A report is a public form: it runs as the form's own public principal, even
   for a reader who is signed in, so it names nobody. It files the report and
   answers the same sentence whatever the post number named, so the form
   cannot be used to ask which posts exist. */
export const reportPost = defineCommand({
  source: forum,
  target: 'report',
  public: true,
  read: ['post'],
  input: {
    post: field.number({ label: 'Post number', integer: true, min: 1, help: 'From a post’s page this is filled in for you.' }),
    reason: field.choice(REPORT_REASONS, { help: 'What is wrong with the post.' }),
    details: field.textarea({ label: 'Anything the moderators should know', max: 1000, optional: true }),
  },
  // A public form answers with a reference the reader can quote; it names no row.
  output: shape({ reference: text({ pattern: /^R-[0-9A-F]{8}$/ }), message: literal('Thanks. A moderator will look at it.') }),
  async handle({ db, now }, input) {
    const post = await db.post.find({ id: input.post });
    if (post?.status === 'published') {
      await db.report.insert({
        post_id: post.id,
        reason: input.reason,
        details: input.details ?? null,
        status: 'open',
        created_at: stamp(now()),
        resolved_at: null,
        resolution: null,
      });
    }
    return { reference: `R-${randomUUID().slice(0, 8).toUpperCase()}`, message: 'Thanks. A moderator will look at it.' as const };
  },
});

export const editProfile = defineCommand({
  source: forum,
  target: 'member',
  input: {
    display_name: joinCommunity.input.display_name,
    location: joinCommunity.input.location,
    bio: joinCommunity.input.bio,
    website: field.url({ optional: true }),
  },
  output: shape({ message: literal('Profile saved.') }),
  async handle({ db, record, actor }, input) {
    // A profile is its own member's: the account that joined as it, and nobody else.
    if (record.account_id !== actor.id) refuse('Only the member a profile belongs to can edit it.');
    await db.member.update(record, {
      display_name: input.display_name,
      location: input.location ?? null,
      bio: input.bio ?? null,
      website: input.website ?? null,
    });
    return { message: 'Profile saved.' as const };
  },
});
