// ページ全体スクリーンショット — タイルを1枚の PNG に合成する

const MAX_CANVAS_H = 16384;

async function loadImage(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function stitch({ tiles, positions, pageW, pageH, dpr }) {
  const images = await Promise.all(tiles.map(loadImage));

  let W = Math.round(pageW * dpr);
  let H = Math.round(pageH * dpr);
  let scale = 1;
  if (H > MAX_CANVAS_H) {
    scale = MAX_CANVAS_H / H;
    W = Math.round(pageW * dpr * scale);
    H = MAX_CANVAS_H;
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  images.forEach((img, i) => {
    // 幅はキャンバス幅に合わせ、高さはタイル実画像の縦横比を保つ
    const h = img.height * (W / img.width);
    ctx.drawImage(img, 0, positions[i] * dpr * scale, W, h);
    img.close();
  });

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG の生成に失敗しました"))), "image/png")
  );
  return URL.createObjectURL(blob);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "stitch") return;
  stitch(msg)
    .then((blobUrl) => sendResponse({ blobUrl }))
    .catch((e) => sendResponse({ error: e && e.message ? e.message : String(e) }));
  return true;
});
