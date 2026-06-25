const express = require('express');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min, max) {
  return delay(Math.floor(Math.random() * (max - min) + min));
}

function extractSellers(html) {
  const $ = cheerio.load(html);
  const sellers = new Set();

  // data-seller-name attribute
  $('[data-seller-name]').each((_, el) => {
    const s = $(el).attr('data-seller-name');
    if (s) sellers.add(s.toLowerCase());
  });

  // gig URL pattern /username/gig/
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/([a-z0-9_-]+)\/gig\//i);
    if (m) sellers.add(m[1].toLowerCase());
  });

  // embedded JSON data
  $('script').each((_, el) => {
    const txt = $(el).html() || '';
    for (const m of txt.matchAll(/"seller_name"\s*:\s*"([^"]+)"/g)) sellers.add(m[1].toLowerCase());
    for (const m of txt.matchAll(/"username"\s*:\s*"([^"]+)"/g)) sellers.add(m[1].toLowerCase());
    for (const m of txt.matchAll(/"seller"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/g)) sellers.add(m[1].toLowerCase());
  });

  return [...sellers];
}

app.get('/api/search', async (req, res) => {
  const { keyword, username, maxPages = 5 } = req.query;

  if (!keyword || !username) {
    return res.status(400).json({ error: 'keyword and username are required' });
  }

  const targetUsername = username.toLowerCase().trim();
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));

  const baseHeaders = {
    'User-Agent': randomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
  };

  // Warm up session with a homepage visit
  try {
    await client.get('https://www.fiverr.com/', { headers: baseHeaders, timeout: 15000 });
    await randomDelay(1500, 3000);
  } catch (_) {}

  const results = [];
  let found = false;
  let totalGigsScanned = 0;

  try {
    for (let page = 1; page <= parseInt(maxPages); page++) {
      const offset = (page - 1) * 48;
      const url = `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(keyword)}&offset=${offset}&source=top-bar&search_in=everywhere&search-autocomplete-original-term=${encodeURIComponent(keyword)}`;

      let html;
      try {
        const response = await client.get(url, {
          headers: {
            ...baseHeaders,
            'Referer': page === 1 ? 'https://www.fiverr.com/' : `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(keyword)}&offset=${(page - 2) * 48}`,
            'Sec-Fetch-Site': page === 1 ? 'none' : 'same-origin',
            'User-Agent': randomUA(),
          },
          timeout: 20000,
        });
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

      await randomDelay(2000, 4000);
    }

    res.json({ keyword, username: targetUsername, found, totalGigsScanned, pages: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Fiverr Rank Checker running at http://localhost:${PORT}`);
});
