// Erzeugt PNG-Icons aus public/icons/icon.svg (einmalig ausführen, Ergebnis wird eingecheckt).
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "../public/icons/icon.svg"), "utf8");
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const [name, size, pad] of [["icon-192.png", 192, 0], ["icon-512.png", 512, 0], ["apple-touch-icon.png", 180, 0], ["icon-maskable-512.png", 512, 0.12]]) {
    await p.setViewportSize({ width: size, height: size });
    const inner = Math.round(size * (1 - 2 * pad));
    await p.setContent(`<body style="margin:0;background:#5DB574;display:grid;place-items:center;width:${size}px;height:${size}px">
      <div style="width:${inner}px;height:${inner}px">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div></body>`);
    await p.screenshot({ path: path.join(__dirname, "../public/icons", name), omitBackground: false });
  }
  await b.close();
})();
