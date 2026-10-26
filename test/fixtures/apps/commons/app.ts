import { defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { moderation } from './features/moderation.ts';
import { posting } from './features/posting.ts';
import { navigation } from './navigation.ts';
import { boardPage } from './pages/board.ts';
import { memberPage } from './pages/member.ts';
import { postPage } from './pages/post.ts';
import { reportPage } from './pages/report.ts';
import { threadPage } from './pages/thread.ts';
import { resources } from './resources.ts';
import { commons } from './theme.ts';
import { views } from './views.ts';

/* Commons: a makers' forum anyone may read and members write in, kept by
   volunteer moderators. The App's identity, its one source, what each
   resource is at most, who reads what signed in and signed out, where each
   visitor starts, the menu and the look. authority.lock beside this file
   records every grant, and mistri check fails the moment that changes. */
export default defineApp({
  id: 'commons',
  name: 'Commons',
  sources: { forum: { connection: 'commons' } },
  resources,
  features: [posting, moderation],
  auth: {
    providers: ['email'],
    signUp: 'open',
    defaultRole: 'member',
    /* A member is the row carrying the email their account joined with, so
       `me` is a member ("My threads") and a notice finds the member it is for.
       No page or list shows the column, and signed out it is not read at all
       (public.fields below). */
    me: { from: 'member', column: 'email' },
    /* Anyone may make an account, so the role a new account gets is the
       smallest one: a member reads the forum and changes it only through
       the posting commands, each of which checks the member is acting on
       what is theirs. Moderators and admins are granted by an admin. */
    roles: {
      /* A member reads other members as the forum shows them, never the
         email one joined with: `me` and a notice still find a member by i
         on the server, and the posting commands read the row whole. */
      member: {
        label: 'Member',
        read: [
          'board',
          'member',
          'member_avatar',
          'thread',
          'post',
          'post_image',
          'post_revision',
          'reaction',
          'tag',
          'thread_tag',
          'site_image',
        ],
        write: false,
        fields: {
          member: {
            read: [
              'id',
              'handle',
              'display_name',
              'account_id',
              'team',
              'standing',
              'location',
              'bio',
              'website',
              'reputation',
              'joined_on',
              'version',
            ],
          },
        },
      },
      // Moderators read everything, reports and removals included, and tag threads; every other change is a command.
      moderator: { label: 'Moderator', read: true, write: ['thread_tag'] },
      // An admin also arranges the boards and keeps the tags.
      admin: { label: 'Admin', read: true, write: ['thread_tag', 'board', 'tag'] },
    },
    /* Signed out, a visitor reads the forum as it is shown: boards, threads,
       posts and their earlier versions, photos, reactions, tags and the
       members' public profile — never a report, a removal, a warning or
       anyone's sign-in id. Reporting a post is the one thing a visitor
       writes, through the public report form. */
    public: {
      read: [
        'board',
        'member',
        'member_avatar',
        'thread',
        'post',
        'post_image',
        'post_revision',
        'reaction',
        'tag',
        'thread_tag',
        'site_image',
      ],
      fields: {
        member: {
          read: ['id', 'handle', 'display_name', 'team', 'standing', 'location', 'bio', 'website', 'reputation', 'joined_on', 'version'],
        },
      },
    },
  },
  views,
  pages: { thread: threadPage, post: postPage, member: memberPage, board: boardPage, report: reportPage },
  // Signed out, the front page; a moderator starts on the forum's health; everyone else on what is new.
  home: [{ view: 'welcome', signedOut: true }, { view: 'health', roles: ['moderator', 'admin'] }, { view: 'latest' }],
  nav: navigation,
  ui: {
    logo: 'wrench',
    /* A printed page of its own (theme.ts): warm paper, a serif over the
       headlines, one red for what is current. */
    customThemes: [commons],
    theme: { preset: 'commons' },
    /* No global search in the bar: every list has its own, and on a phone the
       bar keeps the forum's name whole beside the menu. */
    shell: { placement: 'top', width: 'wide', headerWidth: 'content', search: false },
    footer: {
      text: 'A demonstration community. The members, the threads and the photos are made up.',
      links: [
        { label: 'Community guidelines', href: 'https://example.invalid/commons/guidelines' },
        { label: 'Contact the moderators', href: 'mailto:moderators@example.invalid' },
      ],
    },
    locale: 'en-US',
    timezone: 'America/New_York',
    export: false,
  },
} satisfies App);
