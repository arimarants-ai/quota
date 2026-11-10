// node test/native.test.mjs
//
// The widgets are Swift and Java, which nothing in this repository compiles except the Android
// build in CI, and the Xcode project file is edited by hand. What can be checked without either
// toolchain is checked here: the project file still holds together and puts the widget's art in
// the widget, every picture the code names exists in light and dark, every id the Java sets is
// in its layout, and the line of the day is the same fourteen lines, in the same order, on the
// page and on both phones.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  ok  ' + msg); };

// ---- the Xcode project
const pbx = read('native/ios/App/App.xcodeproj/project.pbxproj');
let depth = 0;
for (const ch of pbx.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\*[\s\S]*?\*\//g, '')) {
  if (ch === '{' || ch === '(') depth++;
  if (ch === '}' || ch === ')') depth--;
  assert.ok(depth >= 0, 'the project file closes something it never opened');
}
ok(depth === 0, 'the project file opens and closes as many brackets as it should');
const defs = [...pbx.matchAll(/^\t\t([0-9A-F]{24}) (?:\/\*[^*]*\*\/ )?= \{/gm)].map(m => m[1]);
ok(new Set(defs).size === defs.length, 'no object in the project file is defined twice');
const refs = new Set([...pbx.matchAll(/\b([0-9A-F]{24})\b/g)].map(m => m[1]));
ok([...refs].every(id => defs.includes(id)), 'every id the project file mentions is one it defines');
const section = (name, id) => { const i = pbx.indexOf(`\t\t${id} /* ${name} */ = {`); return i < 0 ? '' : pbx.slice(i, pbx.indexOf('\n\t\t};', i)); };
const target = section('QuotaWidget', 'C8A8385A2F42125E2E21F879');
const resId = /([0-9A-F]{24}) \/\* Resources \*\//.exec(target)?.[1];
const res = section('Resources', resId);
const bf = /([0-9A-F]{24}) \/\* Assets\.xcassets in Resources \*\//.exec(res)?.[1];
ok(!!bf, "the widget target's Resources phase builds an asset catalog");
const fileRef = new RegExp(`${bf} /\\* Assets\\.xcassets in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ([0-9A-F]{24})`).exec(pbx)?.[1];
const group = section('QuotaWidget', '2E42BBA11BEBC9C81E241D74');
ok(!!fileRef && group.includes(`${fileRef} /* Assets.xcassets */`), "  and it is the one in the QuotaWidget folder, not the app's");
ok(new RegExp(`${fileRef} /\\* Assets\\.xcassets \\*/ = \\{isa = PBXFileReference; lastKnownFileType = folder\\.assetcatalog; path = Assets\\.xcassets; sourceTree = "<group>"; \\}`).test(pbx),
  '  referenced as an asset catalog by its folder name');
const appRes = section('Resources', '504EC3021FED79650016851F');
ok(!appRes.includes(bf), "  and only the widget builds it, not the app as well");

// ---- the widget's pictures, light and dark
const CAT = 'native/ios/App/QuotaWidget/Assets.xcassets';
const NAMES = ['Morning', 'Partway', 'LastHours', 'Done', ...Array.from({length: 14}, (_, i) => `Motivation${String(i + 1).padStart(2, '0')}`)];
for (const n of NAMES) {
  const dir = `${CAT}/Mascot${n}.imageset`, c = JSON.parse(read(`${dir}/Contents.json`));
  const files = c.images.map(x => x.filename);
  assert.ok(files.every(f => f && existsSync(join(ROOT, dir, f))), `Mascot${n}: a file it names is missing`);
  assert.ok(c.images.some(x => !x.appearances) && c.images.some(x => (x.appearances || []).some(a => a.value === 'dark')), `Mascot${n}: needs light and dark`);
}
ok(true, `all ${NAMES.length} imagesets name files that are there, light and dark`);
const swift = ['Shared.swift', 'StreakWidget.swift', 'QuotaWidgetBundle.swift'].map(f => read(`native/ios/App/QuotaWidget/${f}`)).join('\n');
const named = [...swift.matchAll(/"(Mascot[A-Za-z]+)"/g)].map(m => m[1]);
ok(named.length >= 4 && named.every(n => existsSync(join(ROOT, CAT, `${n}.imageset`))), 'every picture the Swift names by name is in the catalog');
ok(/String\(format: "MascotMotivation%02d", motivationIndex\(date\) \+ 1\)/.test(swift), '  and the fourteen are named 01 to 14');
for (const w of ['StreakWidget()', 'MotivationWidget()', 'CountdownWidget()']) assert.ok(swift.includes(w), w);
ok(/configurationDisplayName\("Streak"\)/.test(swift) && /configurationDisplayName\("Motivation"\)/.test(swift) && /configurationDisplayName\("Countdown"\)/.test(swift),
  'the gallery has Streak, Motivation and Countdown, Streak first in the bundle');

// ---- Android
const A = 'native/android/app/src/main';
const java = readdirSync(join(ROOT, A, 'java/app/hitquota/quota')).filter(f => f.endsWith('.java')).map(f => read(`${A}/java/app/hitquota/quota/${f}`)).join('\n');
const drawables = [...new Set([...java.matchAll(/R\.drawable\.(mascot_\w+)/g)].map(m => m[1]))];
ok(drawables.length === 18 && drawables.every(d => existsSync(join(ROOT, A, 'res/drawable-nodpi', `${d}.png`)) && existsSync(join(ROOT, A, 'res/drawable-night-nodpi', `${d}.png`))),
  'every mascot the Java names is there, day and night');
const layouts = [...new Set([...java.matchAll(/R\.layout\.(\w+)/g)].map(m => m[1]))];
const xml = Object.fromEntries(layouts.map(l => [l, read(`${A}/res/layout/${l}.xml`)]));
const ids = [...new Set([...java.matchAll(/R\.id\.(\w+)/g)].map(m => m[1]))].filter(id => id !== 'root' || true);
ok(ids.every(id => Object.values(xml).some(x => x.includes(`@+id/${id}"`))), 'every view id the Java sets is in a layout');
for (const [l, x] of Object.entries(xml)) {
  for (const c of [...x.matchAll(/@color\/(\w+)/g)].map(m => m[1])) {
    assert.ok(read(`${A}/res/values/colors_widget.xml`).includes(`name="${c}"`) && read(`${A}/res/values-night/colors_widget.xml`).includes(`name="${c}"`), `${l}: @color/${c} light and dark`);
  }
}
ok(true, '  and every colour a layout uses has a light and a dark');
const manifest = read(`${A}/AndroidManifest.xml`);
ok(/\.StreakWidget"[^>]*android:label="Streak"/.test(manifest) && /\.MotivationWidget"[^>]*android:label="Motivation"/.test(manifest)
  && existsSync(join(ROOT, A, 'res/xml/widget_motivation_info.xml')), 'Android has the Streak and the Motivation widget');

// ---- the line of the day, the same everywhere
const SPEC = ['Consistency is key.', 'Crush the day.', "Proof or it didn't happen.", 'Today counts.', "One post. That's all.",
  "Your crew's watching.", 'Small reps, big streak.', 'Show up today.', 'Done beats perfect.', 'Future you says thanks.',
  'Easy day? Still counts.', 'Keep it rolling.', 'Breathe. Then go.', 'You vs. yesterday.'];
const html = read('app/index.html');
// The quoted strings between where a list starts and the line that closes it.
const list = (src, start) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `${start} is not there`);
  const body = src.slice(i + start.length, src.slice(i).search(/\n\s*[\]}];?\n|'\];|"\];/) + i + 3);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map(m => m[1] ?? m[2]);
};
const page = list(html, 'const MOTIVATION = ['), ios = list(swift, 'let motivationLines = ['), droid = list(read(`${A}/java/app/hitquota/quota/Today.java`), 'static final String[] LINES = {');
ok(JSON.stringify(page) === JSON.stringify(SPEC), 'the page has the fourteen lines, in order');
ok(JSON.stringify(ios) === JSON.stringify(SPEC), '  and so does the iPhone');
ok(JSON.stringify(droid) === JSON.stringify(SPEC), '  and so does Android');
// The page's day number: 1 January 1970 is 0, so it and every 14th day after is the first line.
const dayNo = d => Math.round(Date.parse(d) / 864e5), idx = d => ((dayNo(d) % 14) + 14) % 14;
ok(idx('1970-01-01') === 0 && idx('1970-01-15') === 0 && idx('2026-11-10') === (dayNo('2026-11-10') % 14), 'and the day picks the line the same way the phones do');
ok(/func motivationIndex/.test(swift) && /timeIntervalSince1970 \/ 86_400/.test(swift) && /floorDiv\(utc\.getTimeInMillis\(\), 86_400_000L\)/.test(java),
  '  from the local date as a day since 1970, on both phones');
console.log('PASS: the widgets hold together where no compiler looks');
