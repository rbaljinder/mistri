/**
 * Who is in Commons and what they talk about: the boards, the members, the
 * tags, and every thread with its replies, written out by hand so the forum
 * reads like one. seed.mjs gives them dates, reactions, reports and photos.
 *
 * A thread is `[board, author, title, opening, replies, extra]`: the author
 * and each reply's author are member handles, a reply is `[handle, body]`,
 * and `extra` says what else the thread is — its tags, its photos, whether
 * it is pinned or locked, how long ago it started (in days) and how many
 * readers it drew (which sets how many reactions its posts get).
 */

export const BOARDS = [
  {
    name: 'Announcements',
    slug: 'announcements',
    status: 'read_only',
    description: 'News from the moderators: meetups, rule changes and site updates. Only the team starts threads here.',
  },
  {
    name: 'Show & Tell',
    slug: 'show-and-tell',
    status: 'open',
    description: 'Finished something? Show us the photos, the build notes and what you would do differently next time.',
  },
  {
    name: 'Help Desk',
    slug: 'help-desk',
    status: 'open',
    description: 'Stuck on a build? Say what you tried, what you expected and what happened instead.',
  },
  {
    name: 'Electronics',
    slug: 'electronics',
    status: 'open',
    description: 'Microcontrollers, sensors, power supplies, soldering and the occasional puff of magic smoke.',
  },
  {
    name: 'Keyboards',
    slug: 'keyboards',
    status: 'open',
    description: 'Switches, keycaps, plates, firmware and the long search for the right sound.',
  },
  {
    name: '3D Printing',
    slug: '3d-printing',
    status: 'open',
    description: 'Printers, slicers, filaments, and the prints that went sideways on the way to the good one.',
  },
  {
    name: 'Woodshop',
    slug: 'woodshop',
    status: 'open',
    description: 'Joinery, finishing, sharpening and hand-tool technique, from first cut to last coat.',
  },
  {
    name: 'Synths & Audio',
    slug: 'synths-audio',
    status: 'open',
    description: 'Eurorack modules, pedals, DIY kits and anything else that makes a noise on purpose.',
  },
  {
    name: 'The Lounge',
    slug: 'lounge',
    status: 'open',
    description: 'Off topic: workshop tours, tools you love, podcasts, and whatever else is on your mind.',
  },
];

/* `team` is how the forum labels someone, not what they may do: authority is
   the signed-in account's role. Seeded members have no account. */
export const MEMBERS = [
  [
    'rosa',
    'Rosa Delgado',
    'admin',
    'Tucson, AZ',
    'Runs the Commons servers and the monthly build night. Mostly electronics, some woodworking when the soldering fumes get to be too much.',
    'https://example.invalid/rosa',
  ],
  [
    'dmitri',
    'Dmitri Volkov',
    'moderator',
    'Pittsburgh, PA',
    'Keyboard nerd and QMK contributor. Moderates Keyboards and Help Desk. Ask me about stabilizers.',
    null,
  ],
  [
    'june',
    'June Okafor',
    'moderator',
    'Columbus, OH',
    'Industrial designer by day, 3D printing at night. I moderate the printing board and keep the wiki tidy.',
    null,
  ],
  [
    'walt',
    'Walt Hendricks',
    'moderator',
    'Asheville, NC',
    'Retired shop teacher. Hand tools, hide glue and patience. Woodshop moderator.',
    null,
  ],
  ['priya', 'Priya Raman', 'member', 'San Jose, CA', 'Firmware engineer building a home weather station one sensor at a time.', null],
  [
    'marcus',
    'Marcus Bell',
    'member',
    'Atlanta, GA',
    'Modular synth addict. Currently at 104HP and telling my partner that is the last case.',
    null,
  ],
  [
    'elena',
    'Elena Sokolova',
    'member',
    'Minneapolis, MN',
    'Woodworker, mostly small boxes and cutting boards. Learning to sharpen properly.',
    null,
  ],
  ['tom', 'Tom Nguyen', 'member', 'Houston, TX', 'Second-year EE student. Breadboards everywhere.', null],
  [
    'kate',
    'Kate Brennan',
    'member',
    'Portland, OR',
    'I design and sell keycap sets in small runs. Opinions on legends are welcome.',
    'https://example.invalid/kate',
  ],
  ['sam', 'Sam Whitaker', 'member', 'Denver, CO', 'Voron 2.4 owner, which means I spend more time tuning than printing.', null],
  ['aisha', 'Aisha Karim', 'member', 'Chicago, IL', 'Teaching myself electronics with an Arduino kit and a lot of questions.', null],
  ['ben', 'Ben Takahashi', 'member', 'Seattle, WA', 'Guitar pedals, amplifiers and anything with a tube in it.', null],
  ['lucy', 'Lucy Park', 'member', 'Boston, MA', 'Hobbyist machinist and mechanical keyboard collector.', null],
  ['hector', 'Hector Ruiz', 'member', 'San Antonio, TX', 'Furniture maker. My shop is a one-car garage and a lot of wall hooks.', null],
  ['nora', 'Nora Lindqvist', 'member', 'Madison, WI', 'Knit, solder, print. Sometimes all three in one project.', null],
  ['caleb', 'Caleb Foster', 'member', 'Nashville, TN', 'Studio engineer, building my own DI boxes and patch bays.', null],
  ['mei', 'Mei Chen', 'member', 'Irvine, CA', 'Product designer learning CAD for 3D printing enclosures.', null],
  ['owen', 'Owen Gallagher', 'member', 'Providence, RI', 'Split keyboards and ergonomic setups, after two years of wrist trouble.', null],
  ['fatima', 'Fatima Haddad', 'member', 'Dearborn, MI', 'Maker-space volunteer. I run the Tuesday soldering class.', null],
  ['jake', 'Jake Morrison', 'member', 'Boise, ID', 'Woodturner. Bowls, pens and way too many shavings.', null],
  ['ines', 'Inés Ortega', 'member', 'Albuquerque, NM', 'LoRa sensors for my garden, and a solar setup to run them.', null],
  ['greg', 'Greg Palmer', 'member', 'Kansas City, MO', 'Resin and FDM printing, mostly tabletop terrain.', null],
  ['hana', 'Hana Yoshida', 'member', 'Honolulu, HI', 'Synth DIY: currently building a West Coast complex oscillator.', null],
  ['luis', 'Luis Moreno', 'member', 'Phoenix, AZ', 'CNC router and laser cutter owner, happy to cut parts for anyone nearby.', null],
  ['abby', 'Abby Sinclair', 'member', 'Burlington, VT', 'Beginner woodworker, first workbench in progress.', null],
  ['raj', 'Raj Patel', 'member', 'Edison, NJ', 'Embedded Rust, RP2040 and ESP32.', null],
  ['molly', 'Molly Kerr', 'member', 'Louisville, KY', 'Keyboard switch lubing service, and I have opinions about spring weights.', null],
  ['diego', 'Diego Alvarez', 'member', 'Miami, FL', 'Just got my first printer. Everything is stringy.', null],
  ['tessa', 'Tessa Grant', 'member', 'Richmond, VA', 'Luthier in training. Guitars, ukuleles and one very sad banjo.', null],
  ['victor', 'Victor Osei', 'member', 'Baltimore, MD', 'Retro computing: recapping old machines and building RAM expansions.', null],
  [
    'cora',
    'Cora Whitfield',
    'member',
    'Salt Lake City, UT',
    'Electronics tutor. Patient with beginners, impatient with cold solder joints.',
    null,
  ],
  ['felix', 'Felix Brandt', 'member', 'Milwaukee, WI', 'Pedal builder, amp tinkerer, occasional woodworker.', null],
  ['yara', 'Yara Nasser', 'member', 'Austin, TX', 'Wearables and e-textiles. LEDs sewn into everything.', null],
  ['quinn', 'Quinn Adler', 'member', 'Brooklyn, NY', 'I like fixing things other people throw away.', null],
  ['deals', 'Best Deals Today', 'member', null, null, null],
  ['theo', 'Theo Marsh', 'member', 'Sacramento, CA', 'Joined to learn. Currently building a macro pad.', null],
];

/* Who has a drawn picture rather than their initials. */
export const WITH_AVATAR = new Set([
  'rosa',
  'dmitri',
  'june',
  'walt',
  'priya',
  'marcus',
  'elena',
  'kate',
  'sam',
  'aisha',
  'ben',
  'lucy',
  'hector',
  'nora',
  'mei',
  'owen',
  'fatima',
  'jake',
  'ines',
  'hana',
  'luis',
  'raj',
  'molly',
  'tessa',
  'cora',
  'yara',
]);

export const TAGS = [
  ['solved', 'good'],
  ['beginner', 'info'],
  ['build log', 'neutral'],
  ['guide', 'info'],
  ['safety', 'warn'],
  ['firmware', 'neutral'],
  ['question', 'neutral'],
  ['meetup', 'info'],
  ['giveaway', 'neutral'],
];

export const THREADS = [
  [
    'announcements',
    'rosa',
    'Welcome to Commons: start here',
    `Commons is a forum for people who make things: circuits, keyboards, prints, furniture, instruments and everything in between.

A few things that keep this place useful:

Post in the board that fits. If you are not sure, the Lounge is fine and a moderator will move it.
In the Help Desk, say what you tried, what you expected and what happened. Photos help more than you think.
Show your work in Show & Tell, including the parts that went wrong.
Be generous with beginners. Everyone here started with a cold solder joint.

If you see something that does not belong, use Report on the post rather than replying to it. A moderator will look at every report.`,
    [
      [
        'dmitri',
        'Glad to have everyone here. If a thread of yours ended up somewhere unexpected, that was probably me moving it. No hard feelings.',
      ],
      ['aisha', 'Thanks for putting this together. First forum I have joined in years where the rules fit on one screen.'],
      ['walt', 'Welcome all. Woodshop is quieter than the keyboard board, but we are friendly.'],
    ],
    { tags: ['guide'], pinned: true, locked: true, days: 240, readers: 40 },
  ],

  [
    'announcements',
    'rosa',
    'September build night: Thursday the 18th, 7 pm Eastern',
    `Our monthly build night is back. Bring whatever you are working on, get on the call, and work on it in company.

This month's theme is repairs: bring something broken and we will try to fix it together. Quinn has promised a box of dead headphones.

The link goes out in this thread an hour before we start.`,
    [
      ['quinn', 'The headphones are real. Four pairs, all with the same broken hinge. I have a theory about a printed replacement part.'],
      ['june', 'I can model the hinge if someone sends me calipers measurements beforehand.'],
      ['fatima', 'I will bring the soldering class kids from the maker space if that is all right. They love a repair.'],
      ['rosa', 'Of course. The more the better.'],
    ],
    { tags: ['meetup'], pinned: true, days: 9, readers: 22 },
  ],

  [
    'announcements',
    'june',
    'Reports now go straight to the moderation queue',
    `Quick note about how reporting works now. When you report a post, it lands in a queue that all four of us see, with the reason you chose. We aim to look at every report within a day.

You will not get a notification when we act on it, but you will see the post change if we hide it. Please do not reply to spam, just report it: replies bump it to the top of the board.`,
    [
      ['theo', 'Good to know. I replied to one of those deal posts last week, sorry.'],
      ['june', 'No harm done. It was gone within the hour.'],
    ],
    { tags: ['guide'], days: 38, readers: 18 },
  ],

  [
    'show-and-tell',
    'kate',
    'Finished my first keycap set: Harbor',
    `Two years of sketches, three rounds of samples, and it is finally real. Harbor is a cream and slate set with copper accents on Enter and Escape. The legends are a rounded grotesque I drew myself, because nothing I tried had the right weight at small sizes.

The big lesson: sample the colors on the actual plastic. What looked like slate on screen came back as a sort of sad lavender on the first run.

Photos are on my board with a 65% case. Happy to answer questions about working with a manufacturer.`,
    [
      ['lucy', 'That copper Enter is beautiful. How thick are the caps?'],
      ['kate', '1.5 mm walls, PBT, dye-sublimated legends. The copper is doubleshot on the accent keys only.'],
      ['molly', 'The legend weight is perfect. So many sets go too thin and disappear under backlight.'],
      ['owen', 'Any chance of split-friendly kits? I would buy one immediately.'],
      ['kate', 'Owen, yes. There is a small ergo kit with extra 1.25u and 1.5u mods in the next run.'],
      ['dmitri', 'Congratulations. This is a great write-up on the manufacturing side, pinning it to my bookmarks.'],
    ],
    {
      tags: ['build log'],
      photos: [
        ['keyboard', 'Harbor on a 65% case'],
        ['keyboard', 'The accent keys up close'],
      ],
      days: 21,
      readers: 36,
    },
  ],

  [
    'show-and-tell',
    'sam',
    'Voron 2.4 after 300 hours: what I would change',
    `My Voron has been running for about 300 print hours now, so here is an honest report.

What is great: the quality at speed is unreal, and the enclosure keeps ABS happy. What I would change: I would buy the better linear rails from the start, and I would not have skimped on the bed heater wiring. The first harness I made chafed through in month two.

Print on the plate is a set of vases for my sister's shop. Spiral mode, 0.3 mm layers, about 40 minutes each.`,
    [
      ['greg', 'Those vases are great. What filament?'],
      ['sam', 'A silk PLA for the orange one, PETG for the teal. The silk hides layer lines like nothing else.'],
      ['diego', 'Reading this makes me feel better about my stringy first prints.'],
      ['june', 'The bit about wiring strain relief should be in every build guide. Thank you for saying it.'],
    ],
    {
      tags: ['build log'],
      photos: [
        ['print', 'Spiral vases fresh off the plate'],
        ['print', 'Two more in PETG'],
      ],
      days: 33,
      readers: 30,
    },
  ],

  [
    'show-and-tell',
    'elena',
    'Walnut box with hand-cut dovetails',
    `This is the first box where the dovetails did not need a single shim. I cut them tails-first with a 1:7 ratio, pared to the line, and the fit is snug enough that the box holds together dry.

Finish is three coats of shellac and a paste wax. The lid has a small finger pull I carved with a gouge.

Thanks to Walt for the sharpening advice last spring. It made the difference.`,
    [
      ['walt', 'That is clean work. You can see from the baselines you have your chisel technique sorted. Well done.'],
      ['hector', 'Beautiful grain. Where do you get your walnut?'],
      ['elena', 'A local sawmill that sells offcuts by the pound. Great for small boxes.'],
      ['abby', 'This is exactly what I am working toward. Did you practice on pine first?'],
      ['elena', 'Lots of pine. Maybe twenty practice joints before I cut into anything nice.'],
    ],
    {
      tags: ['build log'],
      photos: [
        ['woodwork', 'The finished box'],
        ['woodwork', 'Dovetails at the corner'],
      ],
      days: 12,
      readers: 28,
    },
  ],

  [
    'show-and-tell',
    'marcus',
    'My first DIY eurorack module works',
    `It is a simple two-channel VCA from a kit, but I built it and it works and nothing caught fire.

The front panel is my own design, cut from aluminum by Luis. The patch cable is holding the whole thing together emotionally.`,
    [
      ['hana', 'Welcome to the rabbit hole. The next one will be a filter, I guarantee it.'],
      ['luis', 'Glad the panel fit. The jacks line up better than my first attempt did.'],
      ['caleb', 'Clean build. Did you calibrate the offset trimmer?'],
      ['marcus', 'I did not know there was an offset trimmer. Going to go look at that now.'],
    ],
    { photos: [['synth', 'The VCA in the case']], days: 47, readers: 20 },
  ],

  [
    'show-and-tell',
    'priya',
    'Weather station, version three',
    `Version three of the weather station runs off a single 18650 and a small solar panel, and has survived two months on the roof.

It reports temperature, humidity, pressure and wind speed every five minutes over LoRa to a gateway in the garage. The trick to the battery life was letting the microcontroller sleep between readings and powering the sensors from a GPIO pin so they are fully off.

The board is my own design, second revision. First revision had the USB port on backwards.`,
    [
      ['ines', 'This is almost exactly what I want for the garden. Which LoRa module?'],
      ['priya', 'An SX1262 on a breakout. I can share the schematic.'],
      ['raj', 'Powering sensors from a GPIO is such a good trick. What is the sleep current?'],
      ['priya', 'About 22 microamps measured. The regulator is most of it.'],
      ['cora', 'The backwards USB port is a rite of passage.'],
    ],
    {
      tags: ['build log'],
      photos: [
        ['pcb', 'Revision two of the board'],
        ['breadboard', 'The prototype on a breadboard'],
      ],
      days: 4,
      readers: 32,
    },
  ],

  [
    'show-and-tell',
    'nora',
    'Light-up scarf for the winter market',
    `Knitted a scarf with forty addressable LEDs sewn along the edge, driven by a tiny board and a battery pack in a pocket at one end. It runs a slow snowfall pattern.

The conductive thread was a mistake. Use thin silicone wire.`,
    [
      ['yara', 'Conductive thread has betrayed us all. The scarf is lovely.'],
      ['fatima', 'The kids at the maker space would love this. Could I borrow the idea for a class?'],
      ['nora', 'Please do. I will post the pattern.'],
    ],
    { days: 71, readers: 16 },
  ],

  [
    'show-and-tell',
    'hector',
    'Shaker side table in cherry',
    `Finished this side table for my daughter's apartment. Tapered legs, mortise and tenon throughout, a single drawer with half-blind dovetails.

Cherry darkens beautifully, so in a year this will look completely different. That is half the fun.`,
    [
      ['walt', 'Proportions are spot on. Shaker style is hard to get right because there is nothing to hide behind.'],
      ['jake', 'Love the tapers. Did you use a jig on the table saw?'],
      ['hector', 'A tapering jig on the jointer, actually. Faster and safer for me.'],
    ],
    { photos: [['woodwork', 'The finished table']], days: 58, readers: 19 },
  ],

  [
    'show-and-tell',
    'luis',
    'Laser-cut enclosure for a stereo amplifier',
    `Designed a finger-jointed enclosure in 3 mm birch for a class-D amplifier board. Slots for the heatsink, a front panel with engraved labels, feet from cork.

Files are open if anyone wants them.`,
    [
      ['ben', 'The engraved labels are crisp. What power setting?'],
      ['luis', 'About 20% at full speed, two passes.'],
      ['felix', 'That is going on my list. My amp has been living in a shoebox.'],
    ],
    {
      photos: [
        ['woodwork', 'Finger-jointed birch enclosure'],
        ['pcb', 'The amplifier board inside'],
      ],
      days: 96,
      readers: 14,
    },
  ],

  [
    'show-and-tell',
    'owen',
    'Split keyboard with a trackball in the thumb cluster',
    `After a year on a split, I added a 34 mm trackball to the right thumb cluster. The case is printed in two parts and the trackball sensor is a PMW3360 on a small board I designed.

My wrists have never been happier. My coworkers think I am building a cockpit.`,
    [
      ['lucy', 'This is the endgame. How is the scroll?'],
      ['owen', 'Hold a layer key and the ball scrolls. It took a week to stop reaching for the mouse.'],
      ['dmitri', 'Nice work on the firmware side. Did you upstream the sensor driver changes?'],
      ['owen', 'Pull request is open. Reviews welcome.'],
    ],
    {
      tags: ['firmware'],
      photos: [
        ['keyboard', 'Left half'],
        ['print', 'Printed thumb-cluster shell'],
      ],
      days: 16,
      readers: 27,
    },
  ],

  [
    'help-desk',
    'aisha',
    'LED blinks once, then nothing: Arduino Uno',
    `Beginner question. I wired an LED with a 220 ohm resistor to pin 13 and uploaded the Blink sketch. The LED blinks once when I plug in the board and then stays off.

The onboard LED blinks normally. I have checked the LED is the right way round (long leg to the pin). What am I missing?`,
    [
      ['cora', 'If the onboard LED blinks but yours does not, the sketch is fine. Where is the other end of your resistor going?'],
      ['aisha', 'To the GND row on the breadboard.'],
      [
        'tom',
        'Many breadboards split the power rails in the middle. If your ground wire is on one half and your resistor on the other, nothing connects.',
      ],
      ['aisha', 'That was it. The rail has a gap in the middle. I would never have guessed. Thank you both!'],
      ['cora', 'Everyone gets bitten by that once. Marking this solved.'],
    ],
    { tags: ['beginner', 'solved'], days: 6, readers: 24 },
  ],

  [
    'help-desk',
    'diego',
    'Stringing everywhere on PETG',
    `New Ender printer, PETG, and every print looks like a spider web. Retraction is 5 mm at 40 mm/s, nozzle at 240. I dried the filament overnight.

What else should I try?`,
    [
      ['sam', 'Drop the nozzle to 230 and print a temperature tower. PETG strings more when it is hot.'],
      ['greg', 'Also check travel speed. Faster travel moves give it less time to ooze.'],
      ['june', 'And turn on combing or "avoid crossing perimeters" in your slicer. It keeps travel moves inside the part.'],
      ['diego', 'Temperature tower says 228 is the sweet spot. Much better already.'],
      ['diego', 'Update: combing plus 228 and it is almost perfect. Thanks all.'],
    ],
    { tags: ['beginner', 'solved'], days: 19, readers: 21 },
  ],

  [
    'help-desk',
    'abby',
    'Plane chatters on end grain',
    `I am trying to square up the end of a board with a block plane and it chatters and tears the far edge. Blade is freshly sharpened. What am I doing wrong?`,
    [
      [
        'walt',
        'Two things: a low-angle block plane works much better on end grain, and clamp a sacrificial piece at the far edge so the fibers have something to lean on.',
      ],
      ['elena', 'Also take very thin shavings. If you are getting chips instead of shavings, back the blade off.'],
      ['abby', 'Thin shavings and a sacrificial block fixed it. Walt, you were right about the low angle too.'],
    ],
    { tags: ['beginner', 'solved'], days: 27, readers: 12 },
  ],

  [
    'help-desk',
    'theo',
    'Macro pad keys register twice',
    `My 3x3 macro pad (RP2040, QMK) sometimes sends a key twice when I press it once. It is worse on two of the keys. Switches are new.`,
    [
      ['dmitri', 'That is chatter. Try raising the debounce time in your config to 10 ms and see if it goes away.'],
      ['molly', 'If it is only two keys, reseat those switches too. A bent pin can make intermittent contact.'],
      ['theo', 'One switch had a bent pin, and debounce at 10 fixed the other. Thank you!'],
    ],
    { tags: ['firmware', 'solved'], days: 3, readers: 15 },
  ],

  [
    'help-desk',
    'tom',
    'Bench power supply reads 0.3 V with nothing connected',
    `My cheap bench supply shows 0.3 V on the display with the output off and nothing connected. Is it safe to use?`,
    [
      ['cora', 'Some cheap supplies have a small offset on the display. Measure the output with a multimeter before worrying.'],
      ['tom', 'Multimeter says 0.00 V. So it is just the display.'],
      ['rosa', 'That is common. If the reading drifts under load, then it is worth a closer look.'],
    ],
    { tags: ['question', 'solved'], days: 44, readers: 10 },
  ],

  [
    'help-desk',
    'mei',
    'Enclosure lid will not snap closed',
    `I modeled a snap-fit lid for a sensor enclosure. It prints fine, but the clips either snap off or will not engage. PLA, 0.2 mm layers. Any rules of thumb?`,
    [
      ['june', 'Print the clips so the layers run along the length of the clip, not across it. Across, they break.'],
      ['luis', 'And give the clip a small undercut, around 0.5 mm. Too much and it will never engage.'],
      ['mei', 'Rotating the part fixed the breaking. Going to try the smaller undercut next.'],
    ],
    { tags: ['question'], days: 8, readers: 11 },
  ],

  [
    'help-desk',
    'quinn',
    'Headphone hinge: can a print survive this?',
    `Four pairs of headphones, same cracked hinge. Before I model a replacement: has anyone printed a load-bearing hinge that lasted?`,
    [
      ['june', 'PETG or nylon, printed flat, with a metal pin through the pivot. PLA will creep and crack.'],
      ['sam', 'I made hinges for a toolbox in PETG two years ago and they are still going.'],
      ['quinn', 'Great. Bringing measurements to build night.'],
    ],
    { tags: ['question'], days: 2, readers: 9 },
  ],

  [
    'electronics',
    'raj',
    'Embedded Rust on the RP2040: a year in',
    `I have been writing all my hobby firmware in Rust for a year now. Short version: the tooling is great, the compile times are not.

What won me over was the type system catching pin conflicts at compile time. If two peripherals try to use the same pin, it does not build.

Happy to help anyone getting started. The first week is the hardest.`,
    [
      ['priya', 'I tried and bounced off the async executors. Which one do you use?'],
      ['raj', 'Embassy for everything now. It made the async parts click for me.'],
      ['victor', 'Does it run on anything older? I have a pile of AVR boards.'],
      ['raj', 'AVR support exists but it is rough. I would stay with C there for now.'],
    ],
    { tags: ['firmware'], days: 64, readers: 22 },
  ],

  [
    'electronics',
    'ines',
    'Solar LoRa node: how big a panel?',
    `Planning a soil moisture node that wakes every 15 minutes, reads two sensors and sends a LoRa packet. What size panel and battery do I need for a cloudy week?`,
    [
      [
        'priya',
        'Mine uses a 1 W panel and a single 18650 and it has never run flat, but I am in California. For a cloudy week I would double the battery.',
      ],
      ['rosa', 'Work backwards from average current. If you sleep properly you will be under 50 microamps, and a small panel is plenty.'],
      ['ines', 'Measured: 38 microamps asleep. Going with the 1 W panel and two cells.'],
    ],
    { tags: ['question', 'solved'], days: 14, readers: 13 },
  ],

  [
    'electronics',
    'fatima',
    'Teaching soldering to twelve-year-olds: what worked',
    `We ran six Tuesday sessions at the maker space. Things that worked: temperature-controlled irons locked at 330 °C, lead-free solder, fume extractors at every station, and a kit with big through-hole parts.

Things that did not: kits with surface-mount parts, and any project that took more than one session to see working.

The best moment was a kid lighting up her own LED badge and immediately asking how to make it blink faster.`,
    [
      ['cora', 'Locking the iron temperature is such a good idea. Half my students crank it to maximum.'],
      ['nora', 'Would you share the kit list? Our library wants to start something similar.'],
      ['fatima', 'Nora, sent you a message with the list and the lesson plan.'],
      ['rosa', 'This is the kind of thread that makes this place worth running. Thank you.'],
    ],
    { tags: ['guide', 'safety'], days: 52, readers: 26 },
  ],

  [
    'electronics',
    'victor',
    'Recapping a 1987 home computer',
    `Recapped the power supply and the main board of an old home computer. Forty-one electrolytic capacitors, three of them visibly leaking. It boots again for the first time in a decade.

Tip for anyone doing this: photograph the board before you start and mark the polarity of every capacitor on the photo. The silkscreen lies.`,
    [
      ['quinn', 'The silkscreen lies. Truer words.'],
      ['tom', 'How do you desolder without lifting pads on a board that old?'],
      ['victor', 'Fresh leaded solder first to reflow the old joints, then a desoldering pump. Patience and low heat.'],
    ],
    { tags: ['guide'], days: 83, readers: 17 },
  ],

  [
    'electronics',
    'tom',
    'Why does my op-amp oscillate?',
    `I built a non-inverting amplifier with a gain of 10 and on the scope there is a 2 MHz oscillation riding on the output. The datasheet says it is unity-gain stable.`,
    [
      ['cora', 'Do you have decoupling capacitors right at the supply pins? That is the first suspect.'],
      ['ben', 'Also check for capacitance on the output. A long cable can make an op-amp unhappy.'],
      ['tom', 'No decoupling. Added 100 nF on each rail and the oscillation is gone. Thank you.'],
    ],
    { tags: ['solved'], days: 30, readers: 12 },
  ],

  [
    'keyboards',
    'molly',
    'Spring weights: a guide from someone who has lubed 20,000 switches',
    `I get asked about spring weights constantly, so here is everything I know.

Lighter springs (35 to 45 g) feel great for long typing sessions but give you more accidental presses. Heavier springs (62 g and up) are satisfying to bottom out but tire your hands. For most people, something in the 50s is the right place to start.

Two-stage springs change the feel more than the weight number suggests. Try one before you buy ninety.

And please, lube the springs separately from the stems. Bag-lubing springs with a few drops of oil stops the ping and takes a minute.`,
    [
      ['lucy', 'Bag-lubing is a game changer. I wish I had known it three builds ago.'],
      ['owen', 'Lighter springs helped my wrists more than anything else I tried.'],
      ['kate', 'Bookmarking this for every customer who asks me about switches.'],
      ['dmitri', 'Pinning this in my head as the canonical answer. Great write-up.'],
      ['theo', 'This is so helpful for my first build. I will try 55 g.'],
    ],
    { tags: ['guide'], days: 42, readers: 34 },
  ],

  [
    'keyboards',
    'lucy',
    'Machined aluminum case: my first try',
    `Machined my first keyboard case on a small benchtop mill. Six hours of machining, two broken end mills, one case that is almost exactly what I drew.

Next time: a better workholding plan. The last pass chattered because the part flexed.`,
    [
      ['luis', 'Beautiful. What stock did you start from?'],
      ['lucy', 'A 25 mm plate of 6061. Most of it ended up as chips on the floor.'],
      ['kate', 'The chamfer is gorgeous. Very jealous.'],
    ],
    { photos: [['keyboard', 'The case with a test plate']], days: 88, readers: 18 },
  ],

  [
    'keyboards',
    'dmitri',
    'Stabilizers rattle: the complete checklist',
    `The single most common complaint in this board is rattling stabilizers, so here is the checklist I go through.

Clip the feet on the stabilizer stems if they are not already clipped.
Lube the wire ends with a thick grease, not a thin oil.
Balance the wire: both ends should sit flat in the housings without pressure.
Band-aid mod under the stabilizer if it is PCB-mounted.

If it still rattles after all four, the housing is probably loose. Screw-in stabilizers fix that for good.`,
    [
      ['theo', 'The wire balancing step was my problem. It was bent just slightly.'],
      ['molly', 'Great list. I would add: holee mod on the spacebar if you want it silent.'],
      ['owen', 'Saving this.'],
    ],
    { tags: ['guide'], pinned: true, days: 120, readers: 38 },
  ],

  [
    'keyboards',
    'owen',
    'Best layout for a 36-key split?',
    `Moving from a 42-key split to 36 keys. How do you all lay out numbers and symbols without a number row?`,
    [
      ['dmitri', 'Numbers on a layer as a numpad under the right hand. Symbols on the left. It takes a week.'],
      ['lucy', 'Combos for the brackets saved me. Pressing two home-row keys together is faster than a layer.'],
      ['owen', 'Trying the numpad layer now. Slow but it makes sense.'],
    ],
    { tags: ['question'], days: 11, readers: 14 },
  ],

  [
    'keyboards',
    'theo',
    'Macro pad build log',
    `Started a 3x3 macro pad as my first build. Hand-wired to an RP2040 board, printed case, QMK.

Day 1: printed the case. Day 2: wired the matrix, only burned myself twice. Day 3: firmware. It works! Except for the double presses (see Help Desk).`,
    [
      ['molly', 'Hand-wiring as a first build is brave. It looks great.'],
      ['kate', 'What keycaps are those?'],
      ['theo', 'Leftovers from a blank set. I will get proper ones once I stop breaking things.'],
    ],
    { tags: ['build log', 'beginner'], photos: [['keyboard', 'Macro pad, first light']], days: 5, readers: 13 },
  ],

  [
    '3d-printing',
    'june',
    'Tolerances for press-fit parts: a cheat sheet',
    `After too many parts that either fell apart or would not go together, here is the cheat sheet I keep above my printer.

Sliding fit: 0.3 mm clearance per side.
Press fit: 0.1 mm clearance per side, and print the hole slightly undersized and ream it.
Snap fit: design the clip to flex no more than 2% of its length.

These are for a well-tuned printer with a 0.4 mm nozzle. Print a tolerance test before trusting any of them on your machine.`,
    [
      ['mei', 'This saved my enclosure project. Thank you.'],
      ['sam', 'Seconding the tolerance test. Every printer is different.'],
      ['greg', 'Printed the test, my printer runs 0.05 mm fat on holes. Adjusting.'],
    ],
    { tags: ['guide'], pinned: true, days: 101, readers: 33 },
  ],

  [
    '3d-printing',
    'greg',
    'Resin printing indoors: is my ventilation enough?',
    `I have a resin printer in a spare room with a window fan blowing out. Is that enough, or do I need an enclosure with a vent hose?`,
    [
      [
        'june',
        'A window fan in the same room is better than nothing, but an enclosure vented directly outside is much better. The fumes are not something to breathe every day.',
      ],
      ['sam', 'Also wear nitrile gloves every time, not just when it looks messy.'],
      ['greg', 'Ordered a tent with a vent fan. Thanks for the push.'],
    ],
    { tags: ['safety', 'question'], days: 25, readers: 16 },
  ],

  [
    '3d-printing',
    'diego',
    'First month with my first printer',
    `Summary of my first month: forty prints, eleven failures, one fire alarm (burnt toast, not the printer).

What helped most: leveling the bed with a piece of paper until it just drags, and drying filament.`,
    [
      ['sam', 'Eleven failures out of forty is a great start.'],
      ['june', 'Welcome! The paper-leveling trick is still what I use.'],
    ],
    { tags: ['beginner'], days: 34, readers: 11 },
  ],

  [
    '3d-printing',
    'sam',
    'Input shaping made my prints faster and better',
    `Ran the input shaping calibration with an accelerometer and doubled my print speed with less ringing than before.

If your firmware supports it and you have an accelerometer, do it tonight.`,
    [
      ['greg', 'Which accelerometer?'],
      ['sam', 'An ADXL345 on a cheap breakout, zip-tied to the toolhead.'],
      ['diego', 'Adding this to my list of things to learn.'],
    ],
    { days: 67, readers: 19 },
  ],

  [
    'woodshop',
    'walt',
    'Sharpening: the method I taught for thirty years',
    `People overcomplicate sharpening. Here is the whole thing.

Flatten the back of the chisel once, properly, on a coarse stone. You never have to do it again.
Hone a secondary bevel with a guide at 30 degrees, going through your stones.
Strop on leather with compound. Ten strokes.

That is it. When it gets dull, go back to the finest stone and the strop. Only regrind the primary bevel when the secondary gets wide.`,
    [
      ['elena', 'This is the method that fixed my dovetails. Thank you again, Walt.'],
      ['abby', 'Printed this out and taped it to my bench.'],
      ['jake', 'Same for turning tools, more or less, except I go straight to the grinder.'],
      ['hector', 'Thirty years of wisdom in six lines.'],
    ],
    { tags: ['guide'], pinned: true, days: 150, readers: 31 },
  ],

  [
    'woodshop',
    'abby',
    'My first workbench: progress',
    `Building a Roubo-style bench from construction lumber. The top is laminated from sixteen 2x6s. It is heavy and not flat yet.

Flattening a top this big by hand is humbling.`,
    [
      ['walt', 'Winding sticks and patience. Work diagonally across the grain first.'],
      ['hector', 'I flattened mine with a router sled. No shame in it.'],
      ['abby', 'Router sled built. Top is flat. I love it.'],
    ],
    { tags: ['build log', 'beginner'], photos: [['woodwork', 'Laminated top, before flattening']], days: 62, readers: 17 },
  ],

  [
    'woodshop',
    'jake',
    'Turning a walnut bowl from green wood',
    `Rough-turned a walnut bowl from a green log, left it thick, and bagged it with shavings to dry slowly for three months. Finished it last week and it did not crack.

The secret is even wall thickness on the rough turning.`,
    [
      ['elena', 'Gorgeous color. What finish?'],
      ['jake', 'Walnut oil, food safe, reapplied every few months.'],
    ],
    { days: 77, readers: 12 },
  ],

  [
    'woodshop',
    'hector',
    'Finish for a kitchen table that sees daily abuse?',
    `Kitchen table in white oak, family with small kids. What finish survives juice, crayons and forks?`,
    [
      ['walt', 'An oil-based polyurethane, three coats, sanded between. Not the prettiest, but it survives.'],
      ['elena', 'A hardwax oil is easier to repair if you would rather spot-fix than refinish.'],
      ['hector', 'Going with hardwax oil. Spot repair sounds right for this family.'],
    ],
    { tags: ['question', 'solved'], days: 18, readers: 14 },
  ],

  [
    'synths-audio',
    'hana',
    'Building a complex oscillator: part one',
    `Starting a build log for a West Coast style complex oscillator. Two oscillators, one modulating the other, and a wavefolder.

Part one: the exponential converter. Matched transistor pair, temperature compensated with a thermistor. Tracking over five octaves so far.`,
    [
      ['marcus', 'Following this closely. The wavefolder is what I want to learn next.'],
      ['caleb', 'Five octaves of tracking on a first build is excellent.'],
      ['hana', 'Part two, the wavefolder, coming once the parts arrive.'],
    ],
    {
      tags: ['build log'],
      photos: [
        ['synth', 'Panel test fit'],
        ['pcb', 'The oscillator core'],
      ],
      days: 22,
      readers: 18,
    },
  ],

  [
    'synths-audio',
    'ben',
    'Fuzz pedal from an old schematic, with a twist',
    `Built a two-transistor fuzz from a classic schematic, but swapped in silicon transistors and added a bias knob. It goes from warm overdrive to broken radio.

Enclosure is a stock aluminum box, drilled by hand, painted a very loud orange.`,
    [
      ['felix', 'The bias knob is the best mod for these. Sound clip?'],
      ['ben', 'Recording one this weekend.'],
      ['tessa', 'Very loud orange is the correct color for a fuzz.'],
    ],
    { days: 49, readers: 15 },
  ],

  [
    'synths-audio',
    'caleb',
    'Passive DI box: worth building?',
    `Considering building a passive DI box for the studio instead of buying another one. Is it worth it, given the transformer is most of the cost?`,
    [
      ['ben', 'Worth it for the learning. A good transformer is most of the cost either way.'],
      ['felix', 'I built two. They sound identical to the commercial ones I compared with.'],
      ['caleb', 'Ordered the transformers. Will report back.'],
    ],
    { tags: ['question'], days: 29, readers: 10 },
  ],

  [
    'synths-audio',
    'marcus',
    'Patch of the week: generative ambient',
    `Two slow random voltages into a quantizer, a long reverb and a delay with the feedback just under self-oscillation. It will play by itself for hours.`,
    [
      ['hana', 'Adding this to my Sunday rotation.'],
      ['caleb', 'The trick with the feedback is perfect.'],
    ],
    { days: 7, readers: 12 },
  ],

  [
    'lounge',
    'quinn',
    'What is the one tool you would save in a fire?',
    `Mine is a pair of flush cutters I have had for fifteen years. Still sharp. No idea how.`,
    [
      ['rosa', 'My temperature-controlled soldering station. It has been through three moves.'],
      ['walt', "A 3/4 inch chisel that was my father's."],
      ['lucy', 'Calipers. I measure everything.'],
      ['greg', 'My hot glue gun, and I will not apologize.'],
      ['elena', "My block plane. Walt's influence."],
      ['tessa', 'A set of files I inherited with the luthier bench.'],
    ],
    { days: 36, readers: 29 },
  ],

  [
    'lounge',
    'tessa',
    'Workshop tour: a luthier bench in a closet',
    `My shop is a converted closet: a bench, a wall of clamps and a very good lamp. You can build a guitar in less space than you think, as long as you do not need to step back to look at it.`,
    [
      ['hector', 'The clamp wall is inspiring. Is that a go-bar deck?'],
      ['tessa', 'It is. For gluing braces. The ceiling is the deck.'],
      ['abby', 'This makes me feel better about my garage.'],
    ],
    { days: 55, readers: 16 },
  ],

  [
    'lounge',
    'yara',
    'Podcasts for the workshop?',
    `Looking for things to listen to while I sew circuits. What do you all put on?`,
    [
      ['nora', 'Anything with long interviews. I like hearing people talk about their craft.'],
      ['marcus', 'Music, mostly my own patches, which is maybe a problem.'],
      ['quinn', 'Old radio dramas. Perfect for soldering.'],
    ],
    { days: 13, readers: 11 },
  ],

  [
    'help-desk',
    'victor',
    'Which flux for a 1980s board with leaded solder?',
    `Recapping another old machine and the original joints do not want to flow. Rosin flux pen, no-clean paste, or something else? I would rather not leave residue that eats the board in another thirty years.`,
    [],
    { tags: ['question'], days: 1, readers: 4 },
  ],

  [
    'electronics',
    'nora',
    'Can one USB power bank drive 300 LEDs?',
    `Planning a light-up quilt with about 300 addressable LEDs. At full white that is far more than a power bank gives, but I will run them at a quarter brightness in slow patterns. Is a 3 A bank enough if I cap the brightness in firmware, or am I fooling myself?`,
    [],
    { tags: ['question'], days: 0, readers: 3 },
  ],

  [
    'lounge',
    'deals',
    'HUGE DISCOUNT on soldering stations, today only!!!',
    `Best prices on soldering stations and more, only today, click the link in my profile for 80% off. Limited stock!!!`,
    [],
    { days: 1, readers: 1, spam: true },
  ],
];

/* Short replies that could land in any busy thread, for extra texture. */
export const CHATTER = [
  'Following along. This is great.',
  'Thanks for writing this up so clearly.',
  'Bookmarked.',
  'Same thing happened to me last year. Glad it is not just me.',
  'This is really helpful, thank you.',
  'Great result. How long did it take you, start to finish?',
  'Love seeing threads like this.',
  'Adding this to my list of weekend projects.',
];
