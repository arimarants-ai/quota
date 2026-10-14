// What migrate.mjs and verify.mjs share: the settings, Supabase as the service role, R2,
// and ffmpeg. Nothing in here prints a key, a token or a signed URL.
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { AwsClient } from 'aws4fetch';

// Run from GitHub, where this repository's logs are public, nobody's user id goes in what
// is printed. The log files on disk keep them; they never leave the machine.
if (process.env.R2_QUIET) {
  const hide = a => typeof a === 'string' ? a.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '…') : a;
  for (const k of ['log', 'error']) { const say = console[k].bind(console); console[k] = (...a) => say(...a.map(hide)); }
}

export const HERE = dirname(fileURLToPath(import.meta.url));
// Where the logs, the scratch files and state.json go: here, unless the test says otherwise.
const DATA = process.env.R2_MIGRATE_DIR || HERE;
export const LOGS = join(DATA, 'logs');
export const WORK = join(DATA, 'work');
export const STATE = join(DATA, 'state.json');
export const CACHE_CONTROL = 'private, max-age=31536000, immutable';
export const VIDEO = /\.(mov|mp4|m4v|webm)$/i;
export const IMAGE = /\.(jpe?g|png|gif|webp|heic|heif|avif)$/i;
export const STORY_PREFIX = 'stories/';
// What the app sends, so a copied clip and a new one look the same.
export const ENCODE = { shortSide: 720, videoKbps: 1800, maxKbps: 2000, audioKbps: 96, fps: 30, poster: 720 };

// .env beside this file, then the environment. Only names are ever reported.
export function config() {
  const file = join(HERE, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const need = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = need.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing in scripts/r2/.env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
    process.exit(2);
  }
  return Object.fromEntries(need.map(k => [k, process.env[k]]));
}

export const enc = key => key.split('/').map(encodeURIComponent).join('/');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
// Three tries for anything over the network, because a run over a few hundred files will
// meet a dropped connection somewhere, and starting again is what --resume is for, not this.
export async function retry(fn, what) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 3) throw new Error(`${what}: ${e.message}`);
      await sleep(1000 * i * i);
    }
  }
}

export function supabase(cfg) {
  const H = { apikey: cfg.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${cfg.SUPABASE_SERVICE_ROLE_KEY}` };
  const base = cfg.SUPABASE_URL.replace(/\/$/, '');
  const ok = async (res, what) => { if (!res.ok) throw new Error(`${what} -> ${res.status} ${(await res.text()).slice(0, 200)}`); return res; };
  return {
    // Every row of a table, a thousand at a time.
    async rows(table, select) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const res = await ok(await fetch(`${base}/rest/v1/${table}?select=${select}&order=id.asc`, { headers: { ...H, Range: `${from}-${from + 999}` } }), table);
        const page = await res.json();
        out.push(...page);
        if (page.length < 1000) return out;
      }
    },
    // Moving a row to its copy. Only if it still points where it did, so a row that changed
    // under the run is left alone rather than overwritten.
    async repoint(table, id, set, was) {
      const col = table === 'posts' ? 'video_path' : 'media_path';
      const res = await ok(await fetch(`${base}/rest/v1/${table}?id=eq.${id}&${col}=eq.${encodeURIComponent(was)}`, {
        method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(set),
      }), `update ${table} ${id}`);
      const back = await res.json();
      if (back.length !== 1 || back[0][col] !== set[col]) throw new Error(`update ${table} ${id} did not take (row changed, or v50 not run)`);
    },
    // Every object in a bucket, folders walked.
    async list(bucket, prefix = '') {
      const out = [];
      for (let offset = 0; ; offset += 1000) {
        const res = await ok(await fetch(`${base}/storage/v1/object/list/${bucket}`, {
          method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
        }), `list ${bucket}/${prefix}`);
        const page = await res.json();
        for (const it of page) {
          const path = prefix ? `${prefix}/${it.name}` : it.name;
          if (it.id === null) out.push(...await this.list(bucket, path));
          else out.push({ path, size: +(it.metadata?.size ?? 0), type: it.metadata?.mimetype || '' });
        }
        if (page.length < 1000) return out;
      }
    },
    async download(bucket, path) {
      const res = await ok(await fetch(`${base}/storage/v1/object/${bucket}/${enc(path)}`, { headers: H }), `download ${bucket}/${path}`);
      return Buffer.from(await res.arrayBuffer());
    },
    // A short-lived URL ffprobe can read the index through, for the dry run's estimate.
    async signed(bucket, path) {
      const res = await ok(await fetch(`${base}/storage/v1/object/sign/${bucket}/${enc(path)}`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }),
      }), `sign ${bucket}/${path}`);
      return `${base}/storage/v1${(await res.json()).signedURL}`;
    },
  };
}

// R2_ENDPOINT is only for the test, which points both scripts at a stand-in.
export const r2Endpoint = cfg => (process.env.R2_ENDPOINT || `https://${cfg.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/$/, '');
export function r2(cfg) {
  const aws = new AwsClient({ accessKeyId: cfg.R2_ACCESS_KEY_ID, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
  const root = `${r2Endpoint(cfg)}/${cfg.R2_BUCKET}`;
  return {
    async put(key, body, type) {
      const res = await aws.fetch(`${root}/${enc(key)}`, { method: 'PUT', body,
        headers: { 'Content-Type': type, 'Cache-Control': CACHE_CONTROL, 'Content-Length': String(body.length) } });
      if (!res.ok) throw new Error(`put ${key} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
    async head(key) {
      const res = await aws.fetch(`${root}/${enc(key)}`, { method: 'HEAD' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`head ${key} -> ${res.status}`);
      return { size: +res.headers.get('content-length'), type: res.headers.get('content-type'), cache: res.headers.get('cache-control') };
    },
    async list() {
      const out = [];
      let token = '';
      for (;;) {
        const res = await aws.fetch(`${root}?list-type=2&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`);
        if (!res.ok) throw new Error(`list -> ${res.status}`);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([^<]*)<\/Key>/.exec(m[1])[1].replace(/&amp;/g, '&');
          out.push({ key, size: +/<Size>(\d+)<\/Size>/.exec(m[1])[1] });
        }
        const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) return out;
        token = next[1];
      }
    },
  };
}

// ---- ffmpeg
export function haveFfmpeg() {
  const v = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' });
  const p = spawnSync('ffprobe', ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (v.status !== 0 || p.status !== 0) return null;
  const help = spawnSync('ffmpeg', ['-hide_banner', '-h', 'full'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
  const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', maxBuffer: 16 << 20 }).stdout || '';
  return { version: v.stdout.split('\n')[0], fpsmax: help.includes('-fpsmax'), tonemap: /\bzscale\b/.test(filters) && /\btonemap\b/.test(filters) };
}
export function run(cmd, args, timeoutMs = 10 * 60e3) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
export async function probe(src) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src], 120e3);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out);
    const v = (j.streams || []).find(s => s.codec_type === 'video');
    const a = (j.streams || []).find(s => s.codec_type === 'audio');
    return { duration: +(j.format?.duration || v?.duration || 0), video: v || null, audio: a || null };
  } catch { return null; }
}

// Logged as JSON lines, one per thing done, so a run can be read back or grepped.
export function logger(name) {
  mkdirSync(LOGS, { recursive: true });
  const file = join(LOGS, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const log = (event, data = {}) => appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n');
  return { file, log };
}
export const mb = n => n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
