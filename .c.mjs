import { chromium } from 'playwright';
const b = await chromium.launch(); const tag = process.argv[2];
for (const [w,h] of [[1280,800],[390,844]]) { const pg = await b.newPage({viewport:{width:w,height:h}}); await pg.goto('http://localhost:8765/'); await pg.waitForTimeout(600); await pg.screenshot({path:'/tmp/claude-0/-home-user-quota/552fef1b-b362-5101-ab03-5bc3be4978e3/scratchpad/hero-'+tag+'-'+w+'.png'}); await pg.close(); }
await b.close();
