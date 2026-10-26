import { action, commandForm, defineFeature } from '@mistriwork/mistri/app';
import type { Feature } from '../mistri-schema.d.ts';

/* What a member does: join, start a thread, reply, react, and edit their
   own words and profile. Each is a command, because each stamps who did i
   from the verified session — never from the form — and because a member may
   change only what is theirs, which the handler checks against the stored
   row (member-commands.ts). Anyone, signed in or not, may report a post. */

const everyone = ['joinCommunity', 'startThread', 'replyToThread', 'editPost', 'reactToPost', 'editProfile'] as const;

export const posting = defineFeature({
  id: 'posting',
  resources: {
    thread: { actions: { reply: action('Reply', { command: 'replyToThread' }) } },
    member: { actions: { editProfile: action('Edit profile', { command: 'editProfile' }) } },
    post: {
      actions: { react: action('React', { command: 'reactToPost' }), editPost: action('Edit post', { command: 'editPost' }) },
    },
  },
  auth: {
    roles: {
      member: { commands: everyone },
      moderator: { commands: everyone },
      admin: { commands: everyone },
    },
  },
  views: {
    'report-post': commandForm('Report a post', 'reportPost', {
      public: true,
      description: 'Tell the moderators what is wrong. Reports are anonymous: the post’s author never sees who sent one.',
      submitLabel: 'Send report',
      prefillable: ['post'],
      done: { title: 'Thanks for telling us', description: 'A volunteer moderator reads every report, usually within a day.' },
    }),
    join: commandForm('Join Commons', 'joinCommunity', {
      icon: 'user-circle',
      description: 'Choose how the forum names you. Once you have joined you can start threads, reply and react.',
      submitLabel: 'Join',
      done: { title: 'Welcome to Commons', description: 'Say hello in the Lounge, or start a thread in the board that fits.' },
    }),
    'start-thread': commandForm('Start a thread', 'startThread', {
      icon: 'note',
      description: 'Pick the board that fits. In the Help Desk, say what you tried, what you expected and what happened.',
      submitLabel: 'Post thread',
      done: {
        title: 'Your thread is up',
        description: 'Find it at the top of Latest. If you were warned recently, a moderator reads it first.',
      },
    }),
  },
} satisfies Feature);
