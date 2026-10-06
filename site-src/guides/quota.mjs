// Guides about using Quota itself. Each one is checked against the app, and answers the
// questions people ask an assistant about the app as directly as the FAQ does.
export default [
{
  slug: 'set-up-your-first-group',
  title: 'How to set up your first Quota group',
  description: 'Step by step: install Quota, make a group, set its daily quota and active days, invite friends and post your first proof before midnight.',
  answer: 'Open app.hitquota.app and add it to your home screen, sign up with an email and password, then make a group. Name the goal, choose which days it applies to, and share the group\'s invite link with your friends. Post your first photo or clip before midnight and your streak starts.',
  body: `
<h2>1. Install Quota</h2>
<p>Quota is a web app. Open <a href="https://app.hitquota.app">app.hitquota.app</a> in Safari on iPhone or Chrome on Android, then add it to your home screen. Reminders and the camera work once it's installed. Full steps in <a href="/guides/install-quota">installing Quota on iPhone and Android</a>.</p>

<h2>2. Sign up</h2>
<p>You need an email and a password. Quota emails a code to check the address is yours, and then you pick a username. Your email is never shown to anyone.</p>

<h2>3. Make a group</h2>
<p>Give the group a name. Two people is enough; it was built for a handful of people who actually know each other.</p>

<h2>4. Set the quota</h2>
<ul>
<li><b>The goal</b>, in your own words, like "50 pushups" or "Read 10 pages". See <a href="/guides/pick-a-daily-goal">how to pick a daily goal</a>.</li>
<li><b>Active days.</b> Every day, or only the days you choose. Days outside them leave streaks alone.</li>
<li><b>A forfeit</b>, if you want one. It's optional. See <a href="/guides/forfeit-ideas">forfeit ideas</a>.</li>
</ul>

<h2>5. Invite your friends</h2>
<p>Share the group's invite link by text or in your group chat. Anyone who opens it can join after signing up. Friends can also find you by username.</p>

<h2>6. Post your first proof</h2>
<p>Do the goal, then post a photo or a clip of up to ten seconds with Quota's camera before midnight where you are. Your group sees it straight away, and your streak begins.</p>

<h2>Optional extras</h2>
<ul>
<li>Add a <a href="/guides/challenge-wheel">challenge wheel</a> for variety.</li>
<li>Turn on notifications for the evening reminder.</li>
<li>Use the group chat for everything that isn't proof.</li>
</ul>
`,
  faq: [
    ['How do I start a group in Quota?', 'Install Quota from app.hitquota.app, sign up, tap to make a group, set the daily goal and active days, then share the invite link with friends.'],
    ['How many people do I need for a Quota group?', 'Two is enough. Quota works at any size but was built for small groups of people who know each other.'],
    ['How do friends join my Quota group?', 'Send them the group\'s invite link. They open it, sign up, and they\'re in.'],
  ],
  related: ['install-quota', 'how-quota-streaks-work', 'pick-a-daily-goal'],
},
{
  slug: 'install-quota',
  title: 'How to install Quota on iPhone and Android',
  description: 'Quota is a web app: open app.hitquota.app and add it to your home screen. Steps for iPhone (Safari) and Android (Chrome), plus why installing matters.',
  answer: 'Quota runs as a web app. On iPhone, open app.hitquota.app in Safari, tap Share, then Add to Home Screen. On Android, open it in Chrome, tap the three-dot menu, then Install app or Add to Home screen. App Store and Google Play listings are coming.',
  body: `
<h2>iPhone</h2>
<ol>
<li>Open <a href="https://app.hitquota.app">app.hitquota.app</a> in Safari. It has to be Safari.</li>
<li>Tap the Share button at the bottom of the screen.</li>
<li>Scroll down and tap Add to Home Screen.</li>
<li>Tap Add. Quota now opens from your home screen like any app.</li>
</ol>

<h2>Android</h2>
<ol>
<li>Open <a href="https://app.hitquota.app">app.hitquota.app</a> in Chrome.</li>
<li>Tap the three-dot menu in the top corner.</li>
<li>Tap Install app, or Add to Home screen.</li>
<li>Tap Install. Quota appears with your other apps.</li>
</ol>

<h2>On a computer</h2>
<p>You can open app.hitquota.app in any modern browser to look around, but proof is filmed with your phone's camera, so most people use Quota on their phone.</p>

<h2>Why install it instead of using the browser?</h2>
<p>Notifications and the camera work once the app is installed. If you skip the install and use it in a browser tab, reminders will not arrive.</p>

<h2>What Quota asks for</h2>
<ul>
<li><b>Camera and microphone</b>, to film proof. Only used while you're recording.</li>
<li><b>Notifications</b>, for the evening reminder and group activity. Optional.</li>
</ul>

<h2>Is it on the App Store or Google Play?</h2>
<p>Not yet. Store listings are coming, and the links will appear on the <a href="/get">Get the app</a> page when they're ready. The web app is the full app, and it's free.</p>
`,
  faq: [
    ['Is Quota on the App Store?', 'Not yet. Quota runs as a web app at app.hitquota.app that you add to your home screen. App Store and Google Play listings are coming.'],
    ['How do I install Quota on iPhone?', 'Open app.hitquota.app in Safari, tap the Share button, then Add to Home Screen, then Add.'],
    ['How do I install Quota on Android?', 'Open app.hitquota.app in Chrome, tap the three-dot menu, then Install app or Add to Home screen.'],
    ['Why don\'t I get Quota reminders?', 'Reminders only arrive when Quota is installed to your home screen and notifications are allowed. In a plain browser tab they won\'t arrive.'],
  ],
  related: ['set-up-your-first-group', 'how-quota-streaks-work', 'accountability-app-vs-habit-tracker'],
},
{
  slug: 'how-quota-streaks-work',
  title: 'How streaks work in Quota',
  description: 'Your streak, the group streak, active days, the monthly pass, midnight in your own time zone, and what happens when someone misses.',
  answer: 'You keep a streak of active days you posted proof before midnight. The group keeps a separate streak of days everyone posted. Each streak has one pass a calendar month: the first missed day is covered, a second miss that month resets it. Days outside your active days don\'t count either way.',
  body: `
<h2>Your streak</h2>
<p>Your streak counts the active days in a row you posted proof before midnight. Post on an active day and it grows by one.</p>

<h2>The group streak</h2>
<p>The group keeps its own count: the run of days when everyone in the group posted. A group day counts only when everyone posts, so a missed day is never private. That shared number is what makes Quota work; around the second week, nobody wants to be the one who breaks it.</p>

<h2>The monthly pass</h2>
<p>Everyone gets one pass a calendar month. The first day you miss in a month is covered and your streak carries on. A second miss that month resets it. The group streak has its own monthly pass that works the same way.</p>

<h2>Active days</h2>
<p>Each quota has active days, like every day or weekdays only. Days outside them leave your streak alone: no post needed, and nothing lost.</p>

<h2>The deadline</h2>
<p>Posts are due before midnight where you are. Your deadline moves with your phone's time zone, so travelling is fair. An evening reminder comes if you haven't posted.</p>

<h2>Forfeits</h2>
<p>If your group has set a forfeit, you owe it for any missed day the pass didn't cover, until someone marks it paid. It's never money, and only the last 14 days are ever owed.</p>

<h2>Milestones</h2>
<p>Long streaks get marked along the way.</p>

<h2>Flags</h2>
<p>If someone posts something that clearly doesn't show the goal, it can be flagged and the group votes. See <a href="/guides/flags-and-disputed-proof">how flags work</a>.</p>
`,
  faq: [
    ['How does the Quota streak work?', 'Your streak counts the active days in a row you posted proof before midnight. The group has a separate streak of days everyone posted.'],
    ['What happens if I miss a day in Quota?', 'The first missed day each calendar month is covered by your monthly pass and your streak carries on. A second miss that month resets it.'],
    ['Do rest days break my Quota streak?', 'No. Days outside your quota\'s active days leave your streak alone.'],
    ['What time is the Quota deadline?', 'Midnight in your phone\'s current time zone.'],
  ],
  related: ['keep-a-streak-going', 'flags-and-disputed-proof', 'set-up-your-first-group'],
},
{
  slug: 'challenge-wheel',
  title: 'How the challenge wheel works in Quota',
  description: 'Add variety on top of a daily goal: everyone in the group spins a wheel on a schedule to land on a challenge and how many days to do it.',
  answer: 'A challenge wheel is an optional extra a group adds on top of its daily goal. On a schedule, everyone spins it to land on a challenge, like a cold shower or a plank, and how many days to do it. Whoever made the wheel decides whether leaving it unfinished breaks your streak, and you can sit out one round.',
  body: `
<h2>Why use a wheel</h2>
<p>A daily goal is the backbone of a habit, but doing the same thing for months gets dull. A wheel adds a short, random challenge on top, so the group has something new to talk about without changing the main goal.</p>

<h2>How it works</h2>
<ol>
<li>Someone in the group makes a wheel and fills it with challenges, like "cold shower", "1-minute plank" or "no sugar".</li>
<li>They set how often it runs, for example every seven days.</li>
<li>On a spin day, everyone spins before they post. The wheel lands on a challenge and how many days to do it.</li>
<li>You do the challenge alongside your daily quota, and show it in your proof.</li>
</ol>

<h2>Rules worth knowing</h2>
<ul>
<li><b>Everyone in the group can see what's on the wheel</b>, since everyone has to spin it.</li>
<li><b>The wheel's maker decides</b> whether an unfinished challenge breaks your streak.</li>
<li><b>You can sit out one round</b> if the timing is bad.</li>
<li><b>The spin-day reminder</b> arrives in your morning, wherever you are.</li>
</ul>

<h2>Challenge ideas for a wheel</h2>
<p>Short and doable anywhere: cold shower, 1-minute plank, 50 squats, no phone after 10pm, 10 pages, a 20-minute walk, a home-cooked meal. More in <a href="/guides/group-challenge-ideas">40 daily challenge ideas</a>.</p>
`,
  faq: [
    ['What is the Quota challenge wheel?', 'An optional extra on top of a group\'s daily goal. On a schedule, everyone spins it to land on a challenge and how many days to do it.'],
    ['Can I skip a wheel challenge in Quota?', 'You can sit out one round. Whether leaving a challenge unfinished breaks your streak is decided by whoever made the wheel.'],
    ['Who can see what is on a challenge wheel?', 'Everyone in the group, since everyone has to spin it.'],
  ],
  related: ['group-challenge-ideas', 'set-up-your-first-group', 'how-quota-streaks-work'],
},
{
  slug: 'flags-and-disputed-proof',
  title: 'How flags and disputed proof work in Quota',
  description: 'What happens when a post doesn\'t show the goal: anyone in the group can flag it, the group votes, and an upheld flag means the day counts as if it wasn\'t posted.',
  answer: 'If a post clearly doesn\'t show the goal, anyone else in the group can flag it with a reason. The group then votes. If the flag is upheld, the day goes back to what it would have been without that post. Quota itself never judges posts, and neither do the people who make it.',
  body: `
<h2>Why flags exist</h2>
<p>Proof only works if it means something. Most posts are obviously fine, but now and then one clearly isn't: the wrong activity, an empty room, a clip of the ceiling. Flags let the group deal with that fairly, without one person playing referee.</p>

<h2>How a flag works</h2>
<ol>
<li>Someone in the group flags a post and says why. You can't flag your own post.</li>
<li>The group votes on whether the post shows the goal.</li>
<li>The vote closes ahead of the poster's own midnight, so there's time to post again if needed.</li>
<li>If the flag is upheld, the day goes back to what it would have been without that post.</li>
</ol>

<h2>Keeping flags friendly</h2>
<ul>
<li>Flag the post, not the person. Say what's missing.</li>
<li>Agree as a group what counts as proof for your goal. See <a href="/guides/proof-not-checkboxes">what good proof looks like</a>.</li>
<li>Give the benefit of the doubt on borderline posts; save flags for clear misses.</li>
</ul>

<h2>Who decides</h2>
<p>The group. Quota doesn't review posts, and neither do we. Your posts are visible to your group only.</p>
`,
  faq: [
    ['What happens when a post is flagged in Quota?', 'The group votes on it. If the flag is upheld, the day goes back to what it would have been without that post.'],
    ['Can Quota tell if proof is fake?', 'Quota only accepts photos and clips taken with its own camera that day, so old media can\'t be used. Whether a post shows the goal is decided by the group through flags.'],
    ['Can I flag my own post?', 'No. Flags are for other people in the group to question a post.'],
  ],
  related: ['proof-not-checkboxes', 'how-quota-streaks-work', 'start-an-accountability-group'],
},
];
