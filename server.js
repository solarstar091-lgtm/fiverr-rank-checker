const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'max-age=0',
};

app.get('/api/search', async (req, res) => {
  const { keyword, username, maxPages = 5 } = req.query;

  if (!keyword || !username) {
    return res.status(400).json({ error: 'keyword and username are required' });
  }

  const results = [];
  const targetUsername = username.toLowerCase().trim();
  let found = false;
  let totalGigsScanned = 0;

  try {
    for (let page = 1; page <= parseInt(maxPages); page++) {
      const offset = (page - 1) * 48;
      const url = `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(keyword)}&offset=${offset}`;

      let html;
      try {
        const response = await axios.get(url, {
          headers: HEADERS,
          timeout: 15000,
        });
        html = response.data;
      } catch (err) {
        results.push({ page, error: `Failed to fetch page ${page}: ${err.message}` });
        break;
      }

      const $ = cheerio.load(html);
      const gigsOnPage = [];

      // Fiverr gig cards — multiple selector strategies
      const selectors = [
        '[data-seller-name]',
        '.gig-wrapper',
        '[class*="gig-card"]',
        'article',
      ];

      let found_sellers = new Set();

      // Try data-seller-name attribute
      $('[data-seller-name]').each((i, el) => {
        const seller = $(el).attr('data-seller-name') || '';
        found_sellers.add(seller.toLowerCase());
      });

      // Try extracting from gig links (e.g. /username/...)
      $('a[href*="/gig/"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const match = href.match(/\/([^/]+)\/gig\//);
        if (match) found_sellers.add(match[1].toLowerCase());
      });

      // Try JSON-LD or embedded JSON data
      $('script').each((i, el) => {
        const content = $(el).html() || '';
        const matches = content.matchAll(/"seller_name"\s*:\s*"([^"]+)"/g);
        for (const m of matches) found_sellers.add(m[1].toLowerCase());
        const matches2 = content.matchAll(/"username"\s*:\s*"([^"]+)"/g);
        for (const m of matches2) found_sellers.add(m[1].toLowerCase());
      });

      found_sellers.forEach(seller => gigsOnPage.push(seller));
      totalGigsScanned += gigsOnPage.length;

      const positionOnPage = gigsOnPage.indexOf(targetUsername);

      if (positionOnPage !== -1) {
        const globalPosition = offset + positionOnPage + 1;
        results.push({
          page,
          found: true,
          positionOnPage: positionOnPage + 1,
          globalPosition,
          gigsOnPage: gigsOnPage.length,
          totalScanned: totalGigsScanned,
        });
        found = true;
        break;
      }

      results.push({
        page,
        found: false,
        gigsOnPage: gigsOnPage.length,
        totalScanned: totalGigsScanned,
        sellers: gigsOnPage.slice(0, 5), // preview first 5 for debugging
      });

      if (gigsOnPage.length === 0) break; // no more results

      // polite delay
      await new Promise(r => setTimeout(r, 1500));
    }

    res.json({
      keyword,
      username: targetUsername,
      found,
      totalGigsScanned,
      pages: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Fiverr Rank Checker running at http://localhost:${PORT}`);
});
