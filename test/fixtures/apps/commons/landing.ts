import { callToAction, embed, faq, hero, landing, signIn, steps } from '@mistriwork/mistri/app';

// Commons' front page, signed out at /commons. The photo, the projects, the
// boards and the busy threads are read through the App's public grant;
// every other word is the author's.
export const commonsLanding = landing(
  hero(
    'Where makers show their work',
    'Commons is a forum for people who build things: circuits, keyboards, prints, furniture and instruments. Ask for help, share what you finished, and learn from what went wrong.',
    [{ label: 'Read the latest threads', to: 'latest' }, signIn('Join or sign in', 'secondary')],
    {
      image: {
        from: 'site_image',
        key: 1,
        alt: 'A workbench from above: a keyboard on a cutting mat, a circuit board, two printed vases, a wooden box and a breadboard.',
      },
      layout: 'split',
      highlights: ['Nine boards', 'Free to join', 'Moderated by volunteers'],
    },
  ),
  [
    embed('showcase', { title: 'Fresh from Show & Tell', limit: 6, sort: 'created_at desc' }),
    embed('active', { title: 'Recently active', limit: 6, sort: 'last_activity desc' }),
    embed('conversation', { title: 'Latest replies', limit: 3, sort: 'created_at desc' }),
    embed('shelves', { title: 'The boards', limit: 9, sort: 'position' }),
    steps('How Commons works', [
      { title: 'Read anything', description: 'Every board, thread and project is open to read, no account needed.' },
      { title: 'Join to post', description: 'Make an account, choose a handle, and you can start threads, reply and react.' },
      { title: 'Report, don’t argue', description: 'If something does not belong, report it. A volunteer moderator reads every report.' },
    ]),
    faq('Questions', [
      {
        question: 'Is Commons a real forum?',
        answer:
          'No. Commons is a demonstration in the tablewalk examples. The members, threads and photos are made up, and the photos are drawn by its seed script.',
      },
      {
        question: 'Can I post photos of my build?',
        answer:
          'Not yet from the browser. The photos on the projects here were added with the forum, and uploading your own is not part of this demonstration.',
      },
      {
        question: 'What happens when I report a post?',
        answer:
          'It goes to the moderation queue with the reason you chose. A moderator either removes it, with a note for the other moderators, or dismisses the report with a reason.',
      },
      {
        question: 'Can I edit what I wrote?',
        answer:
          'Yes, your own posts, as often as you like. The moderators can read the version you replaced, so an edit cannot quietly change a conversation.',
      },
    ]),
    callToAction('Made something lately?', 'Join Commons and show it in Show & Tell. Include what you would do differently.', [
      signIn('Join or sign in'),
    ]),
  ],
  { label: 'Commons — a forum for makers' },
);
