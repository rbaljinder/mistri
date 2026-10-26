/**
 * The post stream, drawn as its stories draw it: oldest first with who wrote
 * each post, its paragraphs and photos; the reaction chips counted, the
 * reader's own pressed, a chip running reactToPost with its kind; Edit only
 * on the reader's own post; Report the public form; an account that has
 * not joined offered the counts and a way to join; and a signed-out visitor
 * offered counts to read and Report alone.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { renderExample } from '@mistriwork/mistri/ui/testing';
import stream, { Member, MemberPhone, Newcomer, NewcomerPhone, Visitor } from './PostStream.examples.tsx';

test('draws each post whole, oldest first, with who wrote it, when, and its photos', async () => {
  const view = renderExample(stream, Member);
  const posts = await view
    .findAllByRole('listitem', {}, { timeout: 2000 })
    .then((items) => items.filter((item) => item.classList.contains('c-post-stream-post')));
  expect(posts.map((post) => within(post).getByText(/^@/).textContent)).toEqual(['@priya', '@ines', '@priya']);
  expect(within(posts[0]).getByText(/edited/)).toBeInTheDocument();
  expect(within(posts[0]).getByText(/started the thread/)).toBeInTheDocument();
  expect(posts[0].querySelectorAll('.c-post-stream-body p')).toHaveLength(2);
  expect(within(posts[0]).getByRole('img', { name: 'Revision two of the board' })).toBeInTheDocument();
  expect(within(posts[1]).getByText('Moderator')).toBeInTheDocument();
});

test("the reader's own reactions are pressed, and a chip runs reactToPost with its kind", async () => {
  const view = renderExample(stream, Member);
  const first = within((await view.findAllByRole('group', { name: "Reactions to Priya Raman's post" }, { timeout: 2000 }))[0]);
  await first.findByRole('button', { name: /^Like/ });
  expect(first.getByRole('button', { name: /^Like/ })).toHaveAttribute('aria-pressed', 'true');
  expect(first.getByRole('button', { name: /^Like/ })).toHaveTextContent('Like2');
  expect(first.getByRole('button', { name: /^Thanks/ })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(first.getByRole('button', { name: /^Thanks/ }));
  expect(view.commands).toEqual([{ command: 'reactToPost', mode: 'run', key: { id: 1 }, input: { kind: 'thanks' } }]);
});

test('a member does not react to her own post, and edits only her own', async () => {
  const view = renderExample(stream, Member);
  const own = await view.findByRole('group', { name: "Reactions to Inés Ortega's post" }, { timeout: 2000 });
  expect(within(own).queryAllByRole('button')).toHaveLength(0);
  const edit = await view.findAllByRole('button', { name: 'Edit your post' });
  expect(edit).toHaveLength(1);
  fireEvent.click(edit[0]);
  expect(view.commands.at(-1)).toEqual({ command: 'editPost', mode: 'open', key: { id: 2 } });
  fireEvent.click(view.getAllByRole('button', { name: /^Reply to / })[0]);
  expect(view.commands.at(-1)).toEqual({ command: 'replyToThread', mode: 'open', key: { id: 42 } });
  fireEvent.click(view.getAllByRole('button', { name: /^Report / })[2]);
  expect(view.navigations).toEqual([{ kind: 'form', view: 'report-post', prefill: { post: '3' } }]);
});

test('signed in and not joined: the counts to read, and Join to react and Join to reply, each opening the Join form', async () => {
  const view = renderExample(stream, Newcomer);
  const first = within((await view.findAllByRole('group', { name: "Reactions to Priya Raman's post" }, { timeout: 2000 }))[0]);
  const joinToReact = await first.findByRole('button', { name: "Join to react to Priya Raman's post" });
  expect(joinToReact).toHaveTextContent('Join to react');
  // No chip is pressable: each count is read, never run.
  expect(first.queryByRole('button', { name: /^Like/ })).toBeNull();
  expect(first.getByText('Like').closest('.c-post-stream-chip')).toHaveTextContent('Like2');
  expect(view.queryByRole('button', { name: /^Reply to / })).toBeNull();
  expect(view.queryByRole('button', { name: 'Edit your post' })).toBeNull();
  const joinToReply = view.getAllByRole('button', { name: /^Join to reply to / });
  expect(joinToReply).toHaveLength(3);
  expect(joinToReply[0]).toHaveTextContent('Join to reply');
  fireEvent.click(joinToReact);
  fireEvent.click(joinToReply[1]);
  expect(view.navigations).toEqual([
    { kind: 'form', view: 'join', prefill: {} },
    { kind: 'form', view: 'join', prefill: {} },
  ]);
  // Nothing was run that a handler would refuse.
  expect(view.commands).toEqual([]);
  expect(view.getAllByRole('button', { name: /^Report / })).toHaveLength(3);
});

test("the newcomer on a phone: the join is a thumb's reach, the same one way on", async () => {
  const view = renderExample(stream, NewcomerPhone);
  await view.findAllByRole('button', { name: /^Join to react to / }, { timeout: 2000 });
  expect(view.container.querySelector('.c-post-stream')).toHaveAttribute('data-compact', 'true');
  expect(view.queryAllByRole('button', { name: /^(Like|Thanks|Helpful|Made me laugh)/ })).toHaveLength(0);
});

test('a member is never offered to join', async () => {
  const view = renderExample(stream, Member);
  await view.findAllByRole('button', { name: /^Reply to / }, { timeout: 2000 });
  expect(view.queryByRole('button', { name: /^Join to / })).toBeNull();
});

test('signed out: counts to read, Report the one thing to do', async () => {
  const view = renderExample(stream, Visitor);
  await view.findAllByText(/^@priya$/);
  await view.findAllByText('Like');
  expect(view.queryByRole('button', { name: /^Like/ })).toBeNull();
  expect(view.queryByRole('button', { name: /^Reply to / })).toBeNull();
  expect(view.queryByRole('button', { name: 'Edit your post' })).toBeNull();
  expect(view.getAllByRole('button', { name: /^Report / })).toHaveLength(3);
  expect(view.getAllByText('Like')[0].closest('.c-post-stream-chip')).toHaveTextContent('Like2');
  // A signed-out visitor is offered no join: they have no account to join with.
  expect(view.queryByRole('button', { name: /^Join to / })).toBeNull();
});

test('on a phone the stream says it is compact', async () => {
  const view = renderExample(stream, MemberPhone);
  await view.findAllByText(/^@priya$/);
  expect(view.container.querySelector('.c-post-stream')).toHaveAttribute('data-compact', 'true');
});
