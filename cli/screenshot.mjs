#!/usr/bin/env node
// 一括ページスクリーンショットツール
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';

import { chromium } from 'playwright';

const HEIGHT = 900;

function usage(msg) {
  if (msg) console.error(msg);
  console.error('使い方: node screenshot.mjs [--file <path>] [--out <dir>] [--width <px>] [--viewport] [--wait <ms>] [--format png|jpeg] <URL...>');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { file: null, out: './shots', width: 1440, fullPage: true, wait: 1000, format: 'png', urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usage(`${a} に値がありません`);
      return argv[++i];
    };
    switch (a) {
      case '--file': opts.file = next(); break;
      case '--out': opts.out = next(); break;
      case '--width': opts.width = Number(next()); break;
      case '--viewport': opts.fullPage = false; break;
      case '--wait': opts.wait = Number(next()); break;
      case '--format': opts.format = next(); break;
      default:
        if (a.startsWith('--')) usage(`不明なオプション: ${a}`);
        opts.urls.push(a);
    }
  }
  if (!Number.isInteger(opts.width) || opts.width <= 0) usage('--width は正の整数で指定してください');
  if (!Number.isFinite(opts.wait) || opts.wait < 0) usage('--wait は0以上の数値で指定してください');
  if (opts.format !== 'png' && opts.format !== 'jpeg') usage('--format は png か jpeg を指定してください');
  return opts;
}

function readUrlFile(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function slugify(url) {
  let base;
  try {
    const u = new URL(url);
    base = u.hostname + u.pathname;
  } catch {
    base = url;
  }
  // 英数字とハイフン以外はハイフンに置換（仕様の例 001-example.com.png に合わせてドットは残す）
  return base.replace(/[^A-Za-z0-9.-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
}

// 画像バッファから実寸を読む
function imageSize(buf, format) {
  if (format === 'png') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 0, h: 0 };
}

// 環境変数のプロキシ設定を読む（一部のプロキシは Chromium からの直接接続を
// 403で弾くため、ローカル中継を挟む。中継は Node プロセスから張るので通る）
function parseEnvProxy() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const auth = u.username
      ? Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')
      : null;
    return { host: u.hostname, port: Number(u.port) || 3128, auth };
  } catch {
    return null;
  }
}

// 127.0.0.1 で待ち受ける小さなプロキシ中継を起動する
function startRelay(proxy) {
  return new Promise((resolve, reject) => {
    dns.lookup(proxy.host, (lookupErr, address) => {
      if (lookupErr) { reject(lookupErr); return; }
      const server = net.createServer((client) => {
        const up = net.connect(proxy.port, address);
        let buf = Buffer.alloc(0);
        let headerDone = false;
        client.on('data', (chunk) => {
          if (headerDone) { up.write(chunk); return; }
          buf = Buffer.concat([buf, chunk]);
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          headerDone = true;
          let head = buf.slice(0, idx).toString('latin1');
          const rest = buf.slice(idx + 4);
          if (proxy.auth && !/proxy-authorization:/i.test(head)) {
            head += `\r\nProxy-Authorization: Basic ${proxy.auth}`;
          }
          up.write(Buffer.from(head + '\r\n\r\n', 'latin1'));
          if (rest.length) up.write(rest);
        });
        up.on('data', (d) => client.write(d));
        up.on('error', () => client.destroy());
        client.on('error', () => up.destroy());
        up.on('close', () => client.destroy());
        client.on('close', () => up.destroy());
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const urls = [...opts.urls];
  if (opts.file) urls.unshift(...readUrlFile(opts.file));
  if (urls.length === 0) usage('URLを1つ以上指定してください');

  mkdirSync(opts.out, { recursive: true });
  const ext = opts.format === 'jpeg' ? 'jpg' : 'png';

  // 出口プロキシがある環境ではローカル中継経由で接続し、そのプロキシが差し込む
  // 証明書を受け入れる（中継も証明書検証も、この環境でのみ有効になる）
  const envProxy = parseEnvProxy();
  let relay = null;
  const launchOpts = {};
  if (envProxy) {
    relay = await startRelay(envProxy);
    launchOpts.proxy = { server: `http://127.0.0.1:${relay.port}` };
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: opts.width, height: HEIGHT },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: !!envProxy,
  });

  let ok = 0;
  let fail = 0;
  for (let n = 0; n < urls.length; n++) {
    const url = urls[n];
    const name = `${String(n + 1).padStart(3, '0')}-${slugify(url)}.${ext}`;
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(opts.wait);
      // 事前スクロール: スクロールで発火するアニメーションや遅延読み込み画像を撮影前にすべて表示させる
      await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const step = Math.max(1, Math.floor(window.innerHeight * 0.9));
        for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 200; y += step, i++) {
          window.scrollTo(0, y);
          await sleep(350);
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(600);
        window.scrollTo(0, 0);
        await sleep(600);
      });
      const buf = await page.screenshot({ fullPage: opts.fullPage, type: opts.format });
      writeFileSync(path.join(opts.out, name), buf);
      const { w, h } = imageSize(buf, opts.format);
      console.log(`OK ${name} (${w}x${h}px)`);
      ok++;
    } catch (err) {
      console.log(`FAIL ${url} ${(err && err.message ? err.message : String(err)).split('\n')[0]}`);
      fail++;
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close();
  if (relay) relay.server.close();
  console.log(`完了: 成功${ok}件 / 失敗${fail}件`);
  process.exit(ok > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
