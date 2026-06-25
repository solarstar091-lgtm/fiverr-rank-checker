const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '71ff3fd03f34fa1de776014e6a776368';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractSellers(html) {
  const $ = cheerio.load(html);
  const sellers = new Set();

  $('[data-seller-name]').each((_, el) => {
    const s = $(el).attr('data-seller-name');
    if (s) sellers.add(s.toLowerCase());
  });

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/([a-z0-9_-]+)\/gig\//i);
    if (m) sellers.add(m[1].toLowerCase());
  });

  $('script').each((_, el) => {
    const txt = $(el).html() || '';
    for (const m of txt.matchAll(/"seller_name"\s*:\s*"([^"]+)"/g)) sellers.add(m[1].toLowerCase());
    for (const m of txt.matchAll(/"username"\s*:\s*"([^"]+)"/g)) sellers.add(m[1].toLowerCase());
  });

  return [...sellers];
}

function scraperUrl(targetUrl) {
  return `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true`;
}

app.get('/api/search', async (req, res) => {
  const { keyword, username, maxPages = 5 } = req.query;

  if (!keyword || !username) {
    return res.status(400).json({ error: 'keyword and username are required' });
  }

  const targetUsername = username.toLowerCase().trim();
  const results = [];
  let found = false;
  let totalGigsScanned = 0;

  try {
    for (let page = 1; page <= parseInt(maxPages); page++) {
      const offset = (page - 1) * 48;
      const fiverrUrl = `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(keyword)}&offset=${offset}&source=top-bar&search_in=everywhere`;

      let html;
      try {
        const response = await axios.get(scraperUrl(fiverrUrl), { timeout: 60000 });
        html = response.data;
      } catch (err) {
        const status = err.response?.status;
        results.push({ page, error: `Failed to fetch page ${page}: ${status ? `HTTP ${status}` : err.message}` });
        if (status === 403 || status === 429) break;
        continue;
      }

      const sellers = extractSellers(html);
      totalGigsScanned += sellers.length;

      const pos = sellers.indexOf(targetUsername);

      if (pos !== -1) {
        results.push({
          page,
          found: true,
          positionOnPage: pos + 1,
          globalPosition: offset + pos + 1,
          gigsOnPage: sellers.length,
          totalScanned: totalGigsScanned,
        });
        found = true;
        break;
      }

      results.push({
        page,
        found: false,
        gigsOnPage: sellers.length,
        totalScanned: totalGigsScanned,
      });

      if (sellers.length === 0) break;

      await delay(1000);
    }

    res.json({ keyword, username: targetUsername, found, totalGigsScanned, pages: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Fiverr Rank Checker running at http://localhost:${PORT}`);
});
