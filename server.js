const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractSellers(html) {
  const sellers = new Set();

  // gig URL pattern /username/gig/
  for (const m of html.matchAll(/href="\/([a-z0-9_-]+)\/gig\//gi)) {
    sellers.add(m[1].toLowerCase());
  }

  // seller_name in JSON
  for (const m of html.matchAll(/"seller_name"\s*:\s*"([^"]+)"/g)) {
    sellers.add(m[1].toLowerCase());
  }

  // data-seller-name
  for (const m of html.matchAll(/data-seller-name="([^"]+)"/gi)) {
    sellers.add(m[1].toLowerCase());
  }

  return [...sellers];
}

let browserInstance = null;

async function getBrowser() {
  try {
    if (browserInstance) {
      const pages = await browserInstance.pages();
      if (pages) return browserInstance;
    }
  } catch (_) {
    browserInstance = null;
  }

  const token = process.env.BROWSERLESS_TOKEN || '2UloEggXDyEmOWB8b641d147cefa24c3df0cda73ee87dabfe';

  browserInstance = await puppeteer.connect({
    browserWSEndpoint: `wss://chrome.browserless.io?token=${token}`,
  });

  return browserInstance;
}

app.get('/api/debug', async (req, res) => {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://www.fiverr.com/search/gigs?query=logo+design', { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);
    const html = await page.content();
    await page.close();
    res.send(`<pre>${html.slice(0, 5000).replace(/</g,'&lt;')}</pre>`);
  } catch (err) {
    if (page) await page.close().catch(() => {});
    res.send('Error: ' + err.message);
  }
});

app.get('/api/search', async (req, res) => {
  const { keyword, username, maxPages = 5 } = req.query;

  if (!keyword || !username) {
    return res.status(400).json({ error: 'keyword and username are required' });
  }

  const targetUsername = username.toLowerCase().trim();
  const results = [];
  let found = false;
  let totalGigsScanned = 0;
  let page;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    await page.setViewport({ width: 1280, height: 800 });

    // Warm up with homepage
    await page.goto('https://www.fiverr.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(2000);

    for (let pg = 1; pg <= parseInt(maxPages); pg++) {
      const offset = (pg - 1) * 48;
      const url = `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(keyword)}&offset=${offset}&source=top-bar&search_in=everywhere`;

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        // Wait for gig cards to render
        await page.waitForSelector('[class*="gig-card"], .gig-wrapper, [data-seller-name], article', { timeout: 15000 }).catch(() => {});
        await delay(2000);

        const html = await page.content();
        const sellers = extractSellers(html);
        totalGigsScanned += sellers.length;

        const pos = sellers.indexOf(targetUsername);

        if (pos !== -1) {
          results.push({
            page: pg,
            found: true,
            positionOnPage: pos + 1,
            globalPosition: offset + pos + 1,
            gigsOnPage: sellers.length,
            totalScanned: totalGigsScanned,
          });
          found = true;
          break;
        }

        results.push({ page: pg, found: false, gigsOnPage: sellers.length, totalScanned: totalGigsScanned });

        if (sellers.length === 0) break;

        await delay(1500);
      } catch (err) {
        results.push({ page: pg, error: err.message });
        break;
      }
    }

    await page.close();
    res.json({ keyword, username: targetUsername, found, totalGigsScanned, pages: results });
  } catch (err) {
    if (page) await page.close().catch(() => {});
    // Reset browser on crash
    browserInstance = null;
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Fiverr Rank Checker running at http://localhost:${PORT}`);
});
