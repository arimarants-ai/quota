// Talking to Cloudflare R2 through its S3 API. aws4fetch rather than the AWS SDK: it is a
// few kilobytes of SigV4 and nothing else, which is all a signed URL needs.
//
// Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET as function
// secrets. Nothing here ever prints them.
import { AwsClient } from 'npm:aws4fetch@1.0.20';

const r2env = (k: string) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined) ?? '';

let client: AwsClient | null = null;
const r2 = () => client ??= new AwsClient({
  accessKeyId: r2env('R2_ACCESS_KEY_ID'), secretAccessKey: r2env('R2_SECRET_ACCESS_KEY'),
  service: 's3', region: 'auto',
});
// Path-style, so every object is under /<bucket>/ on one host — which is also what lets
// the app's service worker know an R2 file by its path whatever the signature on it.
export const objectUrl = (key: string) =>
  `https://${r2env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${r2env('R2_BUCKET')}/${key.split('/').map(encodeURIComponent).join('/')}`;

const stamp = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

// A URL that does one thing to one object until it runs out. Every header given here is
// signed, so whoever uses the URL has to send exactly these values.
export async function presign(method: 'GET' | 'PUT', key: string, seconds: number,
  headers: Record<string, string> = {}, signedAt?: Date): Promise<string> {
  const url = `${objectUrl(key)}?X-Amz-Expires=${seconds}`;
  const signed = await r2().sign(url, {
    method, headers,
    aws: { signQuery: true, allHeaders: true, ...(signedAt ? { datetime: stamp(signedAt) } : {}) },
  });
  return signed.url;
}

// Deleting something already gone is a success in S3, which is what a retry wants.
export async function removeObject(key: string): Promise<boolean> {
  const res = await r2().fetch(objectUrl(key), { method: 'DELETE' });
  await res.body?.cancel();
  return res.ok || res.status === 404;
}
