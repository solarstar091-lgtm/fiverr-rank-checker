const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '2UloEggXDyEmOWB8b641d147cefa24c3df0cda73ee87dabfe';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fiverr gig URL format: /username/gig-slug (no /gig/ segment)
const FIVERR_NAV = new Set(['categories','subcategories','pro','search','users','pages','support',
  'find-services','get-inspired','fiverr-pro','logo-maker','logo-design','hire','gig','cp',
  'seller','buyer','stories','blog','community','about','press','partnerships','privacy',
  'terms','help','contact','start_selling','new','popular','featured','business']);

function extractSellers(html) {
  const sellers = new Set();

  // Primary: gig URLs in the form /username/gig-slug
  for (const m of html.matchAll(/href="\/([a-z0-9][a-z0-9_]{2,})\/([\w-]{15,})(?:\?|")/gi)) {
    const username = m[1].toLowerCase();
    if (!FIVERR_NAV.has(username)) sellers.add(username);
  }

  // Secondary: explicit seller/username JSON fields
  for (const m of html.matchAll(/"seller_name"\s*:\s*"([^"]+)"/g))
    sellers.add(m[1].toLowerCase());
  for (const m of html.matchAll(/data-seller-name="([^"]+)"/gi))
    sellers.add(m[1].toLowerCase());

  return [...sellers];
}

async function withBrowser(fn) {
  // Fresh connection per request — avoids stale WebSocket issues
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`,
  });
  try {
    return await fn(browser);
  } finally {
    await browser.disconnect();
  }
}

app.get('/api/debug', async (req, res) => {
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto('https://www.fiverr.com/search/gigs?query=logo+design', { waitUntil: 'networkidle2', timeout: 60000 });
      await delay(3000);

      const info = await page.evaluate(() => {
        const title = document.title;
        const gigCards = document.querySelectorAll('[class*="gig-card"], .gig-wrapper, article').length;
        // All 2-segment hrefs (likely /username/gig-slug)
        const allLinks = [...new Set([...document.querySelectorAll('a[href]')]
          .map(a => a.getAttribute('href'))
          .filter(h => h && h.match(/^\/[a-z0-9_-]+\/[a-z0-9-]+$/i))
        )].slice(0, 20);
        // First article/card innerHTML for inspection
        const firstCard = document.querySelector('article, [class*="gig-card"]');
        const firstCardHtml = firstCard ? firstCard.innerHTML.slice(0, 600) : 'none';
        return { title, gigCards, allLinks, firstCardHtml };
      });

      await page.close();
      res.json(info);
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  const { keyword, username, maxPages = 5 } = req.query;

  if (!keyword || !username)
    return res.status(400).json({ error: 'keyword and username are required' });

  const targetUsername = username.toLowerCase().trim();
  const results = [];
  let found = false;
  let totalGigsScanned = 0;

  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

      // Warm up session
      await page.goto('https://www.fiverr.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(1500);

      for (let pg = 1; pg <= parseInt(maxPages); pg++) {
        const offset = (pg - 1) * 48;
        const url = `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(keyword)}&offset=${offset}&source=top-bar&search_in=everywhere`;

        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
          await delay(3000); // let React render gig cards

          const html = await page.content();
          const sellers = extractSellers(html);
          totalGigsScanned += sellers.length;

          const pos = sellers.indexOf(targetUsername);
          if (pos !== -1) {
            results.push({ page: pg, found: true, positionOnPage: pos + 1, globalPosition: offset + pos + 1, gigsOnPage: sellers.length, totalScanned: totalGigsScanned });
            found = true;
            break;
          }

          results.push({ page: pg, found: false, gigsOnPage: sellers.length, totalScanned: totalGigsScanned });
          if (sellers.length === 0) break;

          await delay(1000);
        } catch (err) {
          results.push({ page: pg, error: err.message });
          break;
        }
      }

      await page.close();
    });

    res.json({ keyword, username: targetUsername, found, totalGigsScanned, pages: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Fiverr Rank Checker running at http://localhost:${PORT}`);
});
