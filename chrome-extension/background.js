// ページ全体スクリーンショット — service worker

const MENU_ID = "capture-full-page";
const CAPTURE_INTERVAL_MS = 550; // captureVisibleTab の上限 (2回/秒) を守る
const running = new Set(); // 実行中の tabId

async function setBadge(tabId, text, color) {
  try {
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch (_) {
    // タブが閉じられた場合など
  }
}

function clearBadgeLater(tabId, ms = 3000) {
  setTimeout(() => setBadge(tabId, ""), ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pad(n) {
  return String(n).padStart(2, "0");
}

function makeFilename(url) {
  let host = "page";
  try {
    host = new URL(url).hostname.replace(/[^A-Za-z0-9.-]/g, "") || "page";
  } catch (_) {}
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${host}-${stamp}.png`;
}

// ---- ページ内で実行する関数 ----

function preparePage() {
  if (!document.getElementById("pss-style")) {
    const style = document.createElement("style");
    style.id = "pss-style";
    style.textContent = "::-webkit-scrollbar{display:none!important}";
    (document.head || document.documentElement).appendChild(style);
  }
  const de = document.documentElement;
  const body = document.body;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  return {
    viewportW,
    viewportH,
    // 縦方向だけスクロールして撮るため、幅はビューポート幅に合わせる
    pageW: viewportW,
    pageH: Math.max(de.scrollHeight, body ? body.scrollHeight : 0, viewportH),
    dpr: window.devicePixelRatio || 1,
    origX: window.scrollX,
    origY: window.scrollY,
  };
}

function scrollToY(y) {
  window.scrollTo({ left: 0, top: y, behavior: "instant" });
  // 描画が反映されるまで2フレーム待つ
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
  );
}

function restorePage(x, y) {
  window.scrollTo({ left: x, top: y, behavior: "instant" });
  const style = document.getElementById("pss-style");
  if (style) style.remove();
}

// ---- offscreen ----

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "撮影した画像を1枚に合成するため",
  });
}

// ---- 本体 ----

async function capture(tab) {
  if (!tab || tab.id == null) return;
  const tabId = tab.id;
  if (running.has(tabId)) return;
  running.add(tabId);

  const target = { tabId };
  let info = null;

  try {
    try {
      const [res] = await chrome.scripting.executeScript({ target, func: preparePage });
      info = res.result;
    } catch (e) {
      // chrome:// など scripting 不可のページ
      await setBadge(tabId, "!", "#d93025");
      clearBadgeLater(tabId);
      return;
    }

    const { viewportH, pageW, pageH, dpr } = info;
    const step = viewportH;
    const count = Math.max(1, Math.ceil(pageH / step));
    const tiles = [];
    const positions = [];
    let lastCapture = 0;

    for (let i = 0; i < count; i++) {
      await setBadge(tabId, `${i + 1}/${count}`, "#1a73e8");
      const y = Math.max(0, Math.min(i * step, pageH - viewportH));
      await chrome.scripting.executeScript({ target, func: scrollToY, args: [y] });

      const wait = CAPTURE_INTERVAL_MS - (Date.now() - lastCapture);
      if (wait > 0) await sleep(wait);
      lastCapture = Date.now();

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      tiles.push(dataUrl);
      positions.push(y);
    }

    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      type: "stitch",
      tiles,
      positions,
      pageW,
      pageH,
      viewportH,
      dpr,
    });
    if (!res || res.error || !res.blobUrl) {
      throw new Error((res && res.error) || "画像の合成に失敗しました");
    }

    await chrome.downloads.download({ url: res.blobUrl, filename: makeFilename(tab.url) });

    await setBadge(tabId, "✓", "#188038");
    clearBadgeLater(tabId);
  } catch (e) {
    console.error(e);
    await setBadge(tabId, "!", "#d93025");
    clearBadgeLater(tabId);
  } finally {
    if (info) {
      try {
        await chrome.scripting.executeScript({
          target,
          func: restorePage,
          args: [info.origX, info.origY],
        });
      } catch (_) {}
    }
    running.delete(tabId);
  }
}

// ---- 起動経路 ----

chrome.action.onClicked.addListener((tab) => capture(tab));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-full-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) capture(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "ページ全体を画像で保存",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) capture(tab);
});
