import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1200 });
  await page.goto('http://localhost:4321/', { waitUntil: 'networkidle2', timeout: 30000 });
  
  await page.evaluate(() => {
    window.scrollTo(0, 1100);
  });
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: 'd:/AstroAppBiodata/builder_view.png' });
  console.log('Builder view saved!');
  await browser.close();
})();
