# Commons

A moderated forum for makers, App ID `commons`: the community sample. Anyone
may read it without signing in — nine boards, forty-odd threads over eight
months, photos of finished projects and the members who made them. Anyone
may make an account, join with a handle, start threads, reply, react, and
edit their own posts and profile. Volunteer moderators keep it: a queue of
what readers reported, a list of posts held for review, removal with the
words kept for the moderators alone, warnings, pinning, locking and moving
threads, and a health dashboard.

Thirty-six made-up members in US cities, written in the en-US locale. Every
picture — the members' portraits, the project photos, the front page's
workbench — is drawn by the seed itself. The look is its own, a printed page
written with `defineTheme` in [theme.ts](theme.ts): warm paper, a serif over
the headlines and one red for what is current. A forum is read more than it
is operated, and a printed page is the look that reads like reading.

## Start

Use Node 24 or newer and install repository dependencies with `npm install`.
From the repository root, seed a disposable copy outside the watched App.
The seed runs under `--import tsx` because it provisions the command journal,
the record history and the notification store the App needs, with the last
week's threads and replies in the history (`history.mjs`) for the dashboard's
activity feed. It refuses an existing database or config. The PostgreSQL copy
provisions the history empty.

```sh
commons_demo=$(mktemp -d "${TMPDIR:-/tmp}/tablewalk-commons.XXXXXX")
node --import tsx test/fixtures/databases/commons/seed.mjs "$commons_demo/commons.db"
npx tsx packages/mistri/src/server/index.ts check --app test/fixtures/apps/commons --config "$commons_demo/commons.db.json"
```

Dates are counted back from today; `COMMONS_TODAY=2026-09-04` pins the day.
Then the private settings, which belong to neither the App source nor
committed configuration, and the server:

```sh
export XDG_CONFIG_HOME="$commons_demo/auth"
export BETTER_AUTH_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
export MISTRI_AUTH_ADMIN_EMAIL=admin@example.invalid
export MISTRI_AUTH_ADMIN_PASSWORD='choose-a-long-private-password'
npx tsx packages/mistri/src/server/index.ts --config "$commons_demo/commons.db.json" --app test/fixtures/apps/commons --port 4731
```

Open <http://127.0.0.1:4731/> signed out: that is the forum as a
visitor reads it. **Join or sign in** (top right) to make an account, then
confirm its address: the seeded config's mail service is `log:`, so the
confirmation link is printed in the server's output rather than mailed.
Sign-up is open to anyone, so the forum knows a member as *you* (`me`, the
notifications) only once the address is proven. Then choose **Post › Join**
to pick a handle. Sign in as the bootstrapped administrator to moderate.
Choose another port if 4731 is taken. In production the `mail` connection
names a real relay (`smtps://…`): see
[Email](../../../../site/src/content/docs/docs/email.md).

### On PostgreSQL

The same forum, the same day, into an empty database with real types (dates,
timestamps, booleans, `bytea` photos), with the journal and history
provisioned there:

```sh
node --import tsx test/fixtures/databases/commons/seed-postgres.mjs postgres://localhost/commons_demo "$commons_demo/pg.json"
npx tsx packages/mistri/src/server/index.ts --config "$commons_demo/pg.json" --app test/fixtures/apps/commons
```

## Reading order

1. [app.ts](app.ts): identity, the one source, what the public reads
   (`auth.public`, with the members' sign-in id left out), the three roles,
   where each visitor starts (the front page, the health dashboard, Latest),
   the menu and the look.
2. [theme.ts](theme.ts): the printed page, a theme that extends no built-in
   look.
3. [resources.ts](resources.ts): each table's captions, tones and rollups —
   replies and last activity per thread, reactions and open reports per post,
   threads per board and its replies (a rollup of each thread's rollup),
   posts and warnings per member, read on the cards and the moderators' queues
   too — and `audit.redact` on
   the words a removal takes away.
4. [views.ts](views.ts): Latest, Show & Tell's project cards with photos, the
   boards, the members as portrait cards, and an admin's board settings and
   tags, edited in place (`editable`, `order`, `quickAdd`).
5. [landing.ts](landing.ts): the front page — the workbench photo, the newest
   projects, the busiest threads and the boards, read through the public grant.
6. [features/posting.ts](features/posting.ts): the member verbs, named, and
   the signed-in Join and Start a thread forms, and the anonymous public
   Report form. [member-commands.ts](member-commands.ts) is each command whole —
   its input and what it does, checking the verified account against the
   stored row.
7. [features/moderation.ts](features/moderation.ts): the moderators' verbs,
   most of them bulk (`targets: 'many'`), the queue, reports, held posts,
   removals and warnings. [moderator-commands.ts](moderator-commands.ts) holds
   the commands; [commands.ts](commands.ts), beside the manifest, registers
   them by the names the App uses (typed in `mistri-commands.d.ts`).
8. [dashboard.ts](dashboard.ts): Community health, with a `firstRun()` for an
   empty forum, a chart with its own period (`windows`) and **Latest in the
   forum**, an `activity()` of threads started and replies posted. Members are
   drawn with their photos wherever they are named (`avatar: { from:
   'member_avatar', whose: 'member_id' }`, initials where there is none), and a
   thread's status wears its mark (`icons`).
9. [pages/](pages/): a thread (photos, the conversation, each post, its
   standing and `history()`), a post (its words, photos, reactions, earlier
   versions, and Report), a member's profile, a board, a report.
10. [components.ts](components.ts) and [widgets/](widgets/): Commons' own
   [custom components](../../../../site/src/content/docs/docs/custom-components.md).
   The **post stream** draws a thread's posts (`customList()` on the
   `thread-posts` view): oldest first, each with its author, date and "edited",
   its paragraphs and photos, a reaction bar whose chips run `reactToPost`
   through `useCommand` (the reader's own pressed), and Reply, Edit (their
   own) and Report. An account that has signed in and not joined is granted
   the commands but has no member row for a handler to act as, which only
   Commons knows: the stream reads the reader's member row and offers the
   counts with **Join to react** and **Join to reply**, each opening the Join
   form over the post. It is drawn for signed-out visitors too, reading only
   what `auth.public` opens, with no command to run. It has its examples
   (`*.examples.tsx`, stories in Storybook) and its tests. A member's page is
   headed by the built-in record header (`header()`): the portrait, the
   standing beside the name, the team and town under it.
11. [forum.ts](forum.ts) types the source for the handlers;
   [mistri-schema.d.ts](mistri-schema.d.ts) is generated;
   [authority.lock](authority.lock) records every grant. The seed and its
   picture renderer are in [test/fixtures/databases/commons](../../databases/commons/).

## Who may do what

- **Signed out**, a visitor reads boards, threads, published posts and their
  earlier versions, photos, reactions, tags and the members' public profiles —
  never a report, a removal, a warning or anyone's sign-in id. The one thing a
  visitor writes is a report, through the public form a post's page opens
  already naming the post. It runs as the form's public principal even for a
  signed-in reader, so reports are anonymous, and it answers the same sentence
  whatever post number it was given.
- **A member** (the role every new account gets) reads the same, sign-in
  ids included (a thread finds the reader's own member row by one), but never
  a member's email (a field rule on
  `member`; `me` and a notice still find a member by it on the server), and
  writes only through commands: Join, Start a thread, Reply, React (choosing one
  again takes it back, and the author's reputation follows), Edit post and Edit
  profile. The handlers take the account from the verified session and refuse
  a post or profile that is not the member's own: the Edit post button is on
  every post, and the server says "Only the member who wrote a post can edit
  it." A warned member's posts are held for review.
- **A moderator** reads everything and tags threads (the chips on a thread's
  page are ordinary link rows). Every other decision is a command: Approve,
  Hide and Restore a post; Pin, Unpin, Lock, Unlock and Move a thread; Remove
  post and Dismiss report from the queue; Warn member. Hiding moves the words
  to `removal`, which only moderators read, and leaves "This post was removed
  by the moderators." in its place, so the public grant — which reads a post
  whole — cannot read what was removed.
- **An admin** is a moderator who also arranges the boards (drag to reorder,
  rename, close to members' threads) and keeps the tags. The bootstrapped
  administrator has this role, and grants moderator (or admin) to an account
  under **Manage accounts** in the account menu, where a member who breaks
  the rules can also be deactivated.

The connection is writable because the commands write through it; the grants
keep every other write off.

## What a forum still needs

Gaps Commons hit, reported rather than worked around:

- **A role-only room.** A list's visibility follows the grants on its table,
  so a moderator's list over posts would be drawn for every visitor, who reads
  posts. Held posts, every post and member standing are reached from the
  health dashboard, not the menu; they show a visitor nothing the public grant
  does not already read.
- **A public row filter.** `auth.public` reads a resource whole, so a held
  post is readable by its address. Removal moves the words out for that reason.
- **Signed-in forms under a row policy.** They are refused, so Commons runs
  `rows: 'all'`; with a policy, a member's reports could have been theirs alone.
- **A conversation read in order.** A timeline reads newest first, and a
  related list cuts a post to one line; a thread shows both, as tabs.
- **Uploads from a command.** A reply cannot attach a photo: file resources
  take uploads through a related list, and a command takes no file.
- **Search engines and email**: neither is built in. A reply notifies the
  thread's author (`notify` on `post`), and an `@handle` in a post the forum
  shows notifies that member, once (`mentions` on the same rules).

## Where it stops

The data is synthetic. A reply to your thread is in your inbox (the bell,
and `/notifications`), and **Latest › My threads** is yours; nothing
is sent by email, a reported member is told nothing, and there is no digest. Each seed draws its pictures again,
deterministically.
