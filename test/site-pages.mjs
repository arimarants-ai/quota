// node test/site-pages.mjs            check every generated file in site/ is current
// node test/site-pages.mjs --write    write them
//
// The website used to be one page that switched sections on a #/hash, so to a search engine
// or an answer engine it was one address with one title, and everything past the home page
// was invisible. Now each section is its own page at its own address, with its own title,
// description and structured data, and the guides are pages of their own too.
//
// The words live in site-src/: site.html is the whole site as one file (styles, nav, every
// page, footer, scripts) and guides/*.mjs are the guides. This cuts site.html into pages,
// builds the guides around the same nav and footer, and writes the files that tell crawlers
// what is here: sitemap.xml, robots.txt, llms.txt and llms-full.txt. Edit site-src, then run
// it with --write. CI runs it without, so a page edited by hand, or a source edited without
// regenerating, fails.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://hitquota.app', APP = 'https://app.hitquota.app';
// Shown on the guides and in the sitemap. Move it when the guides change in substance.
const UPDATED = '2026-10-06';
const UPDATED_LONG = '6 October 2026';

const src = readFileSync(join(ROOT, 'site-src', 'site.html'), 'utf8');
const GROUPS = [
  {file: 'accountability', title: 'Accountability', lead: 'Keeping a goal with other people: partners, groups, and why proof beats a promise.'},
  {file: 'habits', title: 'Habits and challenges', lead: 'Choosing a daily goal, keeping a streak alive, and challenges and forfeits for friend groups.'},
  {file: 'quota', title: 'Using Quota', lead: 'Setting up a group, how streaks, wheels and flags work, and installing the app.'},
];
for (const g of GROUPS) g.guides = (await import(join(ROOT, 'site-src', 'guides', `${g.file}.mjs`))).default;
const GUIDES = GROUPS.flatMap(g => g.guides);
const bySlug = Object.fromEntries(GUIDES.map(g => [g.slug, g]));

// ---- cutting site.html into its parts
const cut = (from, to) => {
  const a = src.indexOf(from), b = to ? src.indexOf(to, a) : src.length;
  if (a < 0 || b < 0) throw new Error(`site-pages: could not find ${from} in site-src/site.html`);
  return src.slice(a, b);
};
const HEAD = cut('<!doctype html>', '<body>');
const NAV = cut('<nav>', '<!--');
const TAIL = cut('<section class="dlband"');
const SECTIONS = {};
for (const m of src.matchAll(/<div class="page(?: on)?" id="p-(\w+)">/g)) {
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/\n<!-- [A-Z ]+ -->|\n<section class="dlband"/);
  // The page's own closing </div> is the last thing before the next marker.
  SECTIONS[m[1]] = rest.slice(0, end).trim().replace(/<\/div>$/, '').trim();
}
if (!HEAD.includes('<!--meta-->')) throw new Error('site-pages: site-src/site.html has lost its <!--meta--> marker');

// ---- small helpers
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const ld = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const url = path => SITE + path;

const ORG = {'@type': 'Organization', '@id': `${SITE}/#org`, name: 'Quota', url: `${SITE}/`, logo: `${SITE}/icon-192.png`,
  email: 'hello@hitquota.app', founder: [{'@type': 'Person', name: 'Ari Marants'}, {'@type': 'Person', name: 'Justin Smith'}]};
const APPLD = {'@type': 'SoftwareApplication', '@id': `${SITE}/#app`, name: 'Quota', url: APP,
  description: 'A free accountability app for small groups of friends. Each group sets a daily goal, everyone posts a photo or a clip of up to ten seconds as proof before midnight, and the group keeps a streak together.',
  applicationCategory: 'HealthApplication', applicationSubCategory: 'Habit tracking and accountability',
  operatingSystem: 'iOS, Android, Web', image: `${SITE}/og.png`, publisher: {'@id': `${SITE}/#org`},
  offers: {'@type': 'Offer', price: '0', priceCurrency: 'USD'},
  featureList: ['Small private groups', 'One daily goal per group', 'Photo or 10-second video proof taken in the app that day',
    'Personal and group streaks', 'One pass a month for a missed day', 'Optional forfeits', 'Challenge wheels', 'Group votes on flagged proof',
    'Group chat and stories', 'No ads, no trackers, no cookies']};
const crumbs = list => ({'@type': 'BreadcrumbList', itemListElement: list.map(([name, path], i) =>
  ({'@type': 'ListItem', position: i + 1, name, item: url(path)}))});
const faqLd = pairs => ({'@type': 'FAQPage', mainEntity: pairs.map(([q, a]) =>
  ({'@type': 'Question', name: text(q), acceptedAnswer: {'@type': 'Answer', text: text(a)}}))});
const graph = (...nodes) => ld({'@context': 'https://schema.org', '@graph': nodes});

// ---- one page around the shared head, nav and footer
function page({path, title, description, body, jsonld = '', band = true, extra = '', robots = ''}) {
  const meta = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    robots ? `<meta name="robots" content="${robots}">` : `<link rel="canonical" href="${url(path)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${url(path)}">`,
    `<meta property="og:image:alt" content="${esc(title)}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    jsonld, extra,
  ].filter(Boolean).join('\n');
  // The nav marks the page you are on, so it reads right without any script.
  const nav = NAV.replace(`<a href="${path}">`, `<a href="${path}" aria-current="page">`);
  const tail = band ? TAIL : TAIL.replace(/<section class="dlband"[\s\S]*?<\/section>\n/, '');
  return HEAD.replace('<!--meta-->', `<!-- GENERATED by test/site-pages.mjs from site-src/. Edit there, then run it with --write. -->\n${meta}`)
    + `<body>\n${nav}\n${body}\n\n${tail}`;
}

// A section of site.html as its own page. Its first heading becomes the page's h1.
function section(id, path, title, description, opts = {}) {
  let body = SECTIONS[id];
  if (!body) throw new Error(`site-pages: no page p-${id} in site-src/site.html`);
  if (id !== 'home') body = body.replace(/<h2>([\s\S]*?)<\/h2>/, '<h1 class="ph">$1</h1>');
  return page({path, title, description, body: `<main class="page on" id="p-${id}">\n${body}\n</main>`, ...opts});
}

// Old links were #/what and so on, on the home page. Send them to the page they meant.
const HASH = `<script>(function(){var h=location.hash;if(h.indexOf('#/')!==0)return;h=h.slice(2);var p={what:1,approach:1,about:1,get:1,faq:1,contact:1,guides:1};location.replace(h==='privacy'?'/privacy-summary':p[h]?'/'+h:'/')})()</script>`;

// ---- the FAQ, read out of its page so the structured data says exactly what the page says
const FAQ = [...SECTIONS.faq.matchAll(/<details><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map(m => [m[1], m[2]]);
if (FAQ.length < 10) throw new Error('site-pages: could not read the FAQ out of site-src/site.html');

// ---- guides
const card = g => `<a class="gcard" href="/guides/${g.slug}"><b>${esc(g.title)}</b><span>${esc(g.description)}</span></a>`;
function guide(g) {
  const path = `/guides/${g.slug}`;
  for (const r of g.related) if (!bySlug[r]) throw new Error(`site-pages: guide ${g.slug} relates to ${r}, which does not exist`);
  const body = `<main class="page on" id="p-guide">
<div class="wrap narrow guide">
<ol class="crumbs" aria-label="Breadcrumb"><li><a href="/">Home</a></li><li><a href="/guides">Guides</a></li><li aria-current="page">${esc(g.title)}</li></ol>
<h1 class="ph">${esc(g.title)}</h1>
<p class="gmeta">By the Quota team · Updated <time datetime="${UPDATED}">${UPDATED_LONG}</time></p>
<div class="answer"><b>Short answer:</b> ${g.answer}</div>
<div class="gbody">${g.body.trim()}</div>
<div class="gfaq"><h2>Questions</h2>
${g.faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('\n')}
</div>
<div class="gcta"><h2>Keep your goal with friends.</h2><p>Quota is a free app for a daily goal with your group: proof before midnight, and a streak you keep together.</p><a class="navcta big" href="/get">Get the app</a></div>
<div class="related"><h2>Related guides</h2><div class="gcards">${g.related.map(r => card(bySlug[r])).join('')}</div></div>
</div>
</main>`;
  const jsonld = graph(
    {'@type': 'Article', '@id': `${url(path)}#article`, headline: g.title, description: g.description, url: url(path),
      mainEntityOfPage: url(path), datePublished: UPDATED, dateModified: UPDATED, image: `${SITE}/og.png`, inLanguage: 'en',
      author: {'@id': `${SITE}/#org`}, publisher: {'@id': `${SITE}/#org`}, isPartOf: {'@id': `${SITE}/#website`}},
    crumbs([['Home', '/'], ['Guides', '/guides'], [g.title, path]]),
    faqLd(g.faq), ORG);
  return page({path, title: `${g.title} · Quota`, description: g.description, body, jsonld, band: false,
    extra: `<meta property="article:modified_time" content="${UPDATED}">`});
}

const hub = page({
  path: '/guides',
  title: 'Guides: accountability, habits and daily challenges with friends · Quota',
  description: 'Practical guides to keeping a daily goal with friends: accountability partners and groups, streaks, habit science, challenge ideas, forfeits, and how Quota works.',
  body: `<main class="page on" id="p-guides">
<div class="wrap hub">
<div class="eyebrow">Guides</div>
<h1 class="ph">Keeping a daily goal with friends.</h1>
<p class="lead">Short, practical guides to accountability, habits and group challenges, from the people who make Quota. Each one starts with the answer.</p>
${GROUPS.map(gr => `<div class="hubgroup"><h2>${gr.title}</h2><p>${gr.lead}</p><div class="gcards">${gr.guides.map(card).join('')}</div></div>`).join('\n')}
</div>
</main>`,
  jsonld: graph(
    {'@type': 'CollectionPage', '@id': `${SITE}/guides#page`, name: 'Quota guides', url: `${SITE}/guides`, isPartOf: {'@id': `${SITE}/#website`},
      mainEntity: {'@type': 'ItemList', itemListElement: GUIDES.map((g, i) => ({'@type': 'ListItem', position: i + 1, url: url(`/guides/${g.slug}`), name: g.title}))}},
    crumbs([['Home', '/'], ['Guides', '/guides']])),
});

// ---- every page
const WEBSITE = {'@type': 'WebSite', '@id': `${SITE}/#website`, name: 'Quota', url: `${SITE}/`, publisher: {'@id': `${SITE}/#org`}};
const sub = (name, path, type = 'WebPage') => graph({'@type': type, name, url: url(path), isPartOf: {'@id': `${SITE}/#website`}},
  crumbs([['Home', '/'], [name, path]]));
const PAGES = [
  ['index.html', '/', section('home', '/', 'Quota: the daily accountability app for you and your friends',
    'Pick a daily goal with your friends. Everyone posts a photo or a short clip as proof before midnight, and you keep a streak together. Free, with no ads.',
    {jsonld: graph(WEBSITE, ORG, APPLD), extra: HASH})],
  ['what.html', '/what', section('what', '/what', 'How Quota works: groups, daily quotas, proof and streaks · Quota',
    'Quota in five parts: a private group, one daily goal, photo or video proof taken that day, personal and group streaks, and flags the group votes on.',
    {jsonld: sub('How Quota works', '/what')})],
  ['approach.html', '/approach', section('approach', '/approach', 'Our approach: why Quota is built around proof · Quota',
    'Why Quota asks for proof instead of a checkbox, why the streak belongs to the group, and everything we deliberately left out.',
    {jsonld: sub('Our approach', '/approach')})],
  ['about.html', '/about', section('about', '/about', 'About us: two childhood best friends and a daily quota · Quota',
    'Quota was made by Ari Marants and Justin Smith, two childhood best friends who wanted a real way to keep a daily quota together.',
    {jsonld: sub('About Quota', '/about', 'AboutPage')})],
  ['get.html', '/get', section('get', '/get', 'Get the app on iPhone, Android and the web · Quota',
    'Quota is free and runs as a web app: open app.hitquota.app and add it to your home screen. Steps for iPhone and Android. Store listings are coming.',
    {jsonld: sub('Get the app', '/get'), band: false})],
  ['faq.html', '/faq', section('faq', '/faq', 'FAQ: proof, streaks, forfeits, privacy and cost · Quota',
    'Answers about Quota: what counts as proof, what happens when you miss a day, forfeits, challenge wheels, groups, accounts, privacy and cost.',
    {jsonld: graph(faqLd(FAQ), crumbs([['Home', '/'], ['FAQ', '/faq']]))})],
  ['contact.html', '/contact', section('contact', '/contact', 'Contact us · Quota',
    'Questions, ideas, bug reports or data requests: email hello@hitquota.app and one of the two people who make Quota will answer.',
    {jsonld: sub('Contact Quota', '/contact', 'ContactPage')})],
  ['privacy-summary.html', '/privacy-summary', section('privacy', '/privacy-summary', 'Privacy, the short version · Quota',
    'No ads, no trackers, no cookies. Your proof is seen only by your group, stories fade after 24 hours, and you can ask for your data or its deletion any time.',
    {jsonld: sub('Privacy summary', '/privacy-summary')})],
  ['guides.html', '/guides', hub],
  ...GUIDES.map(g => [`guides/${g.slug}.html`, `/guides/${g.slug}`, guide(g)]),
  ['404.html', null, page({path: '/404', title: 'Page not found · Quota', description: 'That page does not exist.', robots: 'noindex',
    body: `<main class="page on" id="p-404"><section><div class="wrap center"><div class="eyebrow">404</div><h1 class="ph">That page isn't here.</h1>
<p class="lead">It may have moved when the site got real addresses. Try one of these.</p>
<div class="more"><a href="/">Home</a> · <a href="/guides">Guides</a> · <a href="/faq">FAQ</a> · <a href="/get">Get the app</a></div></div></section></main>`})],
];

// ---- crawler files
const LEGAL = [['/privacy', 'Privacy policy'], ['/terms', 'Terms of use'], ['/support', 'Support']];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...PAGES.filter(p => p[1]).map(p => p[1]), ...LEGAL.map(l => l[0])].map(p => `<url><loc>${url(p)}</loc><lastmod>${UPDATED}</lastmod></url>`).join('\n')}
</urlset>
`;
// Everyone is welcome, answer engines by name: being quoted by them is the point.
const BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot',
  'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'Bingbot', 'DuckAssistBot', 'meta-externalagent', 'CCBot'];
const robots = `# Quota: everything here is public and meant to be read, by people and by answer engines.
User-agent: *
Allow: /

${BOTS.map(b => `User-agent: ${b}\nAllow: /`).join('\n\n')}

Sitemap: ${SITE}/sitemap.xml
`;

const FACTS = `- Quota is a free accountability app for small groups of friends, made by Ari Marants and Justin Smith.
- Each group sets one daily goal (a "quota"), in its own words, on the days it chooses. Days outside them leave streaks alone.
- Everyone posts proof before midnight in their own time zone: a photo or a video clip of up to ten seconds, taken with Quota's in-app camera that day. Nothing old from the camera roll can be uploaded.
- Each person keeps a streak, and the group keeps a streak of days when everyone posted.
- Everyone gets one pass a calendar month: the first missed day is covered; a second miss that month resets the streak. The group streak has its own monthly pass.
- Groups can set an optional forfeit (a line of text like "buys the coffee"), owed for a missed day the pass didn't cover until marked paid. It is never money, and only the last 14 days are ever owed.
- Groups can add challenge wheels: on a schedule everyone spins to land on a challenge and a number of days. Whoever made the wheel decides whether an unfinished challenge breaks a streak; you can sit out one round.
- Anyone can flag a post that doesn't show the goal; the group votes, and the poster has no vote. Voting closes three hours before the poster's own midnight, so there is time to post again. An upheld flag means the day counts as if that post had not been made.
- Groups also have likes, comments, a group chat, one-to-one messages and 24-hour stories.
- Posts are visible to the group only. There is no public feed, no ads, no analytics, no trackers and no cookies. Data is never sold.
- Two people is enough for a group. You can be in several groups with a different quota in each.
- Sign-up needs an email and a password; a code confirms the email, then you choose a username. Emails are never shown to anyone.
- Price: the base version is free and always will be; a paid version with extra perks may come later.
- Platforms: a web app at ${APP} that installs to the home screen on iPhone (Safari: Share, Add to Home Screen) and Android (Chrome: menu, Install app). App Store and Google Play listings are coming. Reminders only work once installed.
- Contact: hello@hitquota.app. Account deletion: in the app, Settings → Delete account.`;

const llms = `# Quota

> Quota is a free accountability app for small groups of friends. Each group sets one daily goal, everyone posts a photo or a clip of up to ten seconds as proof before midnight, and the group keeps a streak together. Website: ${SITE}. App: ${APP}.

Key facts:

${FACTS}

## Pages

- [How Quota works](${SITE}/what): groups, quotas, proof, streaks, flags, and the rest of the app
- [Our approach](${SITE}/approach): why proof instead of a checkbox, and what was left out on purpose
- [About us](${SITE}/about): who makes Quota and why
- [Get the app](${SITE}/get): installing the web app on iPhone and Android
- [FAQ](${SITE}/faq): answers about proof, streaks, forfeits, wheels, accounts, privacy and cost
- [Privacy summary](${SITE}/privacy-summary): the short version of what Quota keeps and who sees it
- [Contact](${SITE}/contact): how to reach the people who make Quota

## Guides

${GROUPS.map(gr => gr.guides.map(g => `- [${g.title}](${url(`/guides/${g.slug}`)}): ${g.description}`).join('\n')).join('\n')}

## Optional

- [Full text of the FAQ and every guide](${SITE}/llms-full.txt)
- [Privacy policy](${SITE}/privacy)
- [Terms of use](${SITE}/terms)
- [Support](${SITE}/support)
`;

// Plain text out of a guide's HTML: headings become markdown headings, list items bullets,
// table rows pipes. Enough for a reader that wants the words without the page.
const md = html => html.trim()
  .replace(/<h2>([\s\S]*?)<\/h2>/g, (_, t) => `\n### ${text(t)}\n`)
  .replace(/<h3>([\s\S]*?)<\/h3>/g, (_, t) => `\n#### ${text(t)}\n`)
  .replace(/<li>([\s\S]*?)<\/li>/g, (_, t) => `- ${text(t)}\n`)
  .replace(/<tr>([\s\S]*?)<\/tr>/g, (_, t) => `| ${[...t.matchAll(/<t[hd]>([\s\S]*?)<\/t[hd]>/g)].map(c => text(c[1])).join(' | ')} |\n`)
  .replace(/<p>([\s\S]*?)<\/p>/g, (_, t) => `\n${text(t)}\n`)
  .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
const llmsFull = `# Quota: full text

> Quota is a free accountability app for small groups of friends. Each group sets one daily goal, everyone posts a photo or a clip of up to ten seconds as proof before midnight, and the group keeps a streak together. Website: ${SITE}. App: ${APP}.

## Key facts

${FACTS}

## FAQ

${FAQ.map(([q, a]) => `### ${text(q)}\n\n${text(a)}`).join('\n\n')}

## Guides
${GUIDES.map(g => `
## ${g.title}

Source: ${url(`/guides/${g.slug}`)}

**Short answer:** ${text(g.answer)}

${md(g.body)}

${g.faq.map(([q, a]) => `**${text(q)}** ${text(a)}`).join('\n\n')}
`).join('')}`;

const FILES = {
  ...Object.fromEntries(PAGES.map(([f, , html]) => [f, html])),
  'sitemap.xml': sitemap, 'robots.txt': robots, 'llms.txt': llms, 'llms-full.txt': llmsFull,
};

const write = process.argv.includes('--write');
const stale = [];
if (write) mkdirSync(join(ROOT, 'site', 'guides'), {recursive: true});
for (const [f, out] of Object.entries(FILES)) {
  const at = join(ROOT, 'site', f);
  if (write) { writeFileSync(at, out); continue; }
  let now = ''; try { now = readFileSync(at, 'utf8'); } catch {}
  if (now !== out) stale.push(f);
}
// A guide that was renamed or removed would otherwise linger at its old address.
let present = []; try { present = readdirSync(join(ROOT, 'site', 'guides')); } catch {}
const orphans = present.filter(f => !FILES[`guides/${f}`]).map(f => `guides/${f}`);
if (write) {
  console.log(`wrote ${Object.keys(FILES).length} files in site/`);
  if (orphans.length) console.log(`note: site/${orphans.join(', site/')} is no longer generated; delete it`);
} else if (stale.length || orphans.length) {
  if (stale.length) console.log(`FAIL: site/${stale.join(', site/')} out of date with site-src/. Run: node test/site-pages.mjs --write`);
  if (orphans.length) console.log(`FAIL: site/${orphans.join(', site/')} is not generated by anything. Delete it.`);
  process.exit(1);
} else console.log(`PASS: ${Object.keys(FILES).length} site files match site-src/`);
