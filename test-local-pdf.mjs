/**
 * Local PDF generation test — run with: node test-local-pdf.mjs
 * Tests that frame images, gradient backgrounds, and the hairline fix all work.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const candidatePublicDirs = [
  path.resolve(__dirname, "../client/public"),
  path.resolve(__dirname, "../client/dist/client"),
  path.resolve(__dirname, "../client/dist"),
];

const framesDir = path.resolve(__dirname, "../client/public/frames");
const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith(".webp"));
const testFrame = frameFiles[0];
console.log("Using test frame:", testFrame);

const htmlContent = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><base href="http://localhost:4321/"><style>*,::before,::after{box-sizing:border-box;}html,body{margin:0;padding:0;width:210mm;height:297mm;background:white;-webkit-print-color-adjust:exact;print-color-adjust:exact;}@page{size:210mm 297mm;margin:0;}.__bppage-container__{width:210mm;height:297mm;position:relative;overflow:hidden;background:transparent;page-break-after:always;break-after:page;}.__bppage-bg__{position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;}.__bppage-scale__{width:595px;height:842px;position:absolute;top:0;left:0;transform:scale(1.33445);transform-origin:top left;z-index:1;}.__bppage-scale__>div{width:595px;height:842px;position:relative;}.absolute{position:absolute;}.inset-0{top:0;right:0;bottom:0;left:0;}</style></head><body><div class="__bppage-container__"><div class="__bppage-bg__" style="background:linear-gradient(to bottom,#ff7e5f,#feb47b);"></div><div class="__bppage-scale__"><div style="width:595px;height:842px;position:relative;background:linear-gradient(to bottom,#ff7e5f,#feb47b);"><div class="absolute inset-0" style="background-image:url('/frames/${testFrame}');background-size:100% 100%;background-repeat:no-repeat;z-index:1;"></div><div style="position:absolute;top:80px;left:0;right:0;text-align:center;z-index:20;"><h1 style="color:white;font-family:sans-serif;font-size:32px;margin:0;">Test Biodata</h1><p style="color:rgba(255,255,255,0.9);font-family:sans-serif;font-size:16px;">Gradient + Frame Image Test</p></div></div></div></div></body></html>`;

console.log("\n=== Testing local PDF generation ===\n");

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run","--no-zygote","--disable-web-security"],
});
console.log("Browser launched!");

const context = await browser.createBrowserContext();
const page = await context.newPage();

await page.setRequestInterception(true);
const requestLog = [];
page.on("request", (req) => {
  const urlStr = req.url();
  if (urlStr.startsWith("data:") || urlStr.startsWith("blob:") || urlStr === "about:blank") return req.continue().catch(() => {});
  if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) return req.abort("blockedbyclient").catch(() => {});
  try {
    const parsedUrl = new URL(urlStr);
    if (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1") {
      const pathname = decodeURIComponent(parsedUrl.pathname);
      for (const dir of candidatePublicDirs) {
        const localPath = path.join(dir, pathname);
        if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
          const ext = path.extname(localPath).toLowerCase();
          const mimeMap = {".webp":"image/webp",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml"};
          requestLog.push("Served: " + pathname + " (" + (fs.statSync(localPath).size/1024).toFixed(1) + "KB)");
          return req.respond({ status:200, contentType:mimeMap[ext]||"application/octet-stream", headers:{"Access-Control-Allow-Origin":"*"}, body:fs.readFileSync(localPath) }).catch(() => {});
        }
      }
      requestLog.push("Not found on disk: " + pathname);
    }
    req.continue().catch(() => {});
  } catch { req.continue().catch(() => {}); }
});

await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
await page.setContent(htmlContent, { waitUntil: ["load","domcontentloaded"] });
await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => setTimeout(r, 500)); });
await page.evaluate(() => {
  const containers = document.querySelectorAll(".__bppage-container__");
  containers.forEach((container) => {
    const bgLayer = container.querySelector(".__bppage-bg__");
    if (bgLayer) {
      const bg = bgLayer.style.background;
      if (bg) {
        document.documentElement.style.setProperty("background", bg, "important");
        document.body.style.setProperty("background", bg, "important");
        container.style.setProperty("background", bg, "important");
      }
    }
  });
});
await new Promise(r => setTimeout(r, 150));

const pdfBuffer = await page.pdf({ format:"A4", printBackground:true, margin:{top:0,right:0,bottom:0,left:0}, preferCSSPageSize:true, displayHeaderFooter:false });

console.log("Requests:", requestLog.join(", "));
const outPath = path.resolve(__dirname, "test-output.pdf");
fs.writeFileSync(outPath, pdfBuffer);
console.log("PDF size:", pdfBuffer.length, "bytes");
console.log("Saved to:", outPath);
console.log("\n=== SUCCESS ===\n");

await browser.close();
