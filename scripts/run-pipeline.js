#!/usr/bin/env node
/**
 * Standalone runner that mirrors the n8n Research & Content Workflow.
 * Uses GEMINI_API_KEY from environment or .env (never logged).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const SAMPLE_DIR = path.join(ROOT, 'sample-output');

// Load .env without printing values
(function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
})();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 8);

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is required. Copy .env.example to .env and set your key.');
  process.exit(1);
}

const SOURCES = [
  {
    id: 'hn',
    name: 'Hacker News (Front Page)',
    url: 'https://hnrss.org/frontpage',
    type: 'rss',
  },
  {
    id: 'techcrunch',
    name: 'TechCrunch',
    url: 'https://techcrunch.com/feed/',
    type: 'rss',
  },
  {
    id: 'bbc-tech',
    name: 'BBC Technology',
    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
    type: 'rss',
  },
];

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'n8n-research-workflow-demo/1.0 (+https://github.com/armenkazarian8-wq/n8n-research-workflow-demo)',
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
        timeout: 20000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(fetchText(next, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRss(xml, source) {
  const items = [];
  const itemRe = /<item[\s\S]*?<\/item>/gi;
  let match;
  while ((match = itemRe.exec(xml)) !== null && items.length < 25) {
    const block = match[0];
    const title = decodeXml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = decodeXml((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '');
    const description = decodeXml(
      (block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] ||
        (block.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i) || [])[1] ||
        ''
    );
    const pubDate = decodeXml((block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
    if (!title || !link) continue;
    items.push({
      source_id: source.id,
      source_name: source.name,
      title,
      url: link,
      snippet: description.slice(0, 500),
      published_at: pubDate || null,
    });
  }

  // Atom <entry> fallback
  if (items.length === 0) {
    const entryRe = /<entry[\s\S]*?<\/entry>/gi;
    while ((match = entryRe.exec(xml)) !== null && items.length < 25) {
      const block = match[0];
      const title = decodeXml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
      let link = '';
      const linkHref = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
      if (linkHref) link = linkHref[1];
      else link = decodeXml((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '');
      const description = decodeXml(
        (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] ||
          (block.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] ||
          ''
      );
      const pubDate = decodeXml(
        (block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] ||
          (block.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [])[1] ||
          ''
      );
      if (!title || !link) continue;
      items.push({
        source_id: source.id,
        source_name: source.name,
        title,
        url: link,
        snippet: description.slice(0, 500),
        published_at: pubDate || null,
      });
    }
  }

  return items;
}

function normalizeKey(item) {
  try {
    const u = new URL(item.url);
    return `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/$/, '');
  } catch {
    return item.title.toLowerCase().trim();
  }
}

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function callGeminiWithRetry(item, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callGemini(item);
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      const retryable = /timeout|503|UNAVAILABLE|429|ECONNRESET|socket/i.test(msg);
      process.stdout.write(`retry ${i + 1}/${attempts} `);
      if (!retryable || i === attempts - 1) break;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

async function callGemini(item) {
  const prompt = `You are a research analyst for a content workflow.
Analyze the article below and return ONLY valid JSON (no markdown fences) with this exact shape:
{
  "summary": "2-3 sentence summary",
  "category": "one of: AI, Startups, Security, Developer Tools, Business, Science, Other",
  "key_points": ["point1", "point2", "point3"],
  "relevance_score": 1-10 integer (10 = highly relevant to AI/automation/product builders)
}

Title: ${item.title}
Source: ${item.source_name}
URL: ${item.url}
Snippet: ${item.snippet}`;

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  });

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const raw = await new Promise((resolve, reject) => {
    const u = new URL(apiUrl);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 90000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Never include the API key in errors
            return reject(new Error(`Gemini HTTP ${res.statusCode}: ${text.slice(0, 300).replace(GEMINI_API_KEY, '[REDACTED]')}`));
          }
          resolve(text);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gemini request timeout'));
    });
    req.write(body);
    req.end();
  });

  const parsed = JSON.parse(raw);
  const text =
    parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let analysis;
  try {
    analysis = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Gemini returned non-JSON');
    analysis = JSON.parse(m[0]);
  }

  const score = Math.max(1, Math.min(10, Number(analysis.relevance_score) || 5));
  return {
    summary: String(analysis.summary || '').trim(),
    category: String(analysis.category || 'Other').trim(),
    key_points: Array.isArray(analysis.key_points)
      ? analysis.key_points.map((p) => String(p)).slice(0, 5)
      : [],
    relevance_score: score,
  };
}

function toCsv(rows) {
  const headers = [
    'title',
    'url',
    'source_name',
    'category',
    'relevance_score',
    'summary',
    'key_points',
    'published_at',
    'processed_at',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.title,
        r.url,
        r.source_name,
        r.category,
        r.relevance_score,
        r.summary,
        (r.key_points || []).join(' | '),
        r.published_at,
        r.processed_at,
      ]
        .map(esc)
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });

  console.log('=== Research & Content Workflow Demo ===');
  console.log(`Model: ${GEMINI_MODEL}`);
  console.log(`Sources: ${SOURCES.length}`);
  console.log(`Max items to analyze: ${MAX_ITEMS}`);

  const collected = [];
  for (const source of SOURCES) {
    try {
      console.log(`Fetching ${source.name}...`);
      const xml = await fetchText(source.url);
      const items = parseRss(xml, source);
      console.log(`  -> ${items.length} items`);
      collected.push(...items);
    } catch (err) {
      console.warn(`  !! ${source.name} failed: ${err.message}`);
    }
  }

  // Deduplicate by URL/title before AI
  const seen = new Set();
  const unique = [];
  for (const item of collected) {
    const key = normalizeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  console.log(`Unique items after dedupe: ${unique.length}`);

  // Take a mix from each source
  const bySource = {};
  for (const item of unique) {
    bySource[item.source_id] = bySource[item.source_id] || [];
    bySource[item.source_id].push(item);
  }
  const selected = [];
  const sourceIds = Object.keys(bySource);
  let i = 0;
  while (selected.length < MAX_ITEMS && sourceIds.some((id) => bySource[id].length)) {
    const id = sourceIds[i % sourceIds.length];
    if (bySource[id].length) selected.push(bySource[id].shift());
    i += 1;
  }

  console.log(`Analyzing ${selected.length} items with Gemini...`);
  const results = [];
  for (const item of selected) {
    process.stdout.write(`  - ${item.title.slice(0, 70)}... `);
    try {
      const analysis = await callGeminiWithRetry(item);
      const row = {
        ...item,
        ...analysis,
        processed_at: new Date().toISOString(),
      };
      results.push(row);
      console.log(`OK [${analysis.category}/${analysis.relevance_score}]`);
    } catch (err) {
      console.log(`FAIL (${err.message})`);
    }
  }

  // Final dedupe + sort by score
  const finalSeen = new Set();
  const finalRows = [];
  for (const row of results) {
    const key = normalizeKey(row);
    if (finalSeen.has(key)) continue;
    finalSeen.add(key);
    finalRows.push(row);
  }
  finalRows.sort((a, b) => b.relevance_score - a.relevance_score || a.title.localeCompare(b.title));

  const payload = {
    generated_at: new Date().toISOString(),
    workflow: 'research-content-workflow-demo',
    model: GEMINI_MODEL,
    item_count: finalRows.length,
    items: finalRows,
  };

  const jsonPath = path.join(OUTPUT_DIR, 'research-results.json');
  const csvPath = path.join(OUTPUT_DIR, 'research-results.csv');
  const sampleJson = path.join(SAMPLE_DIR, 'research-results.json');
  const sampleCsv = path.join(SAMPLE_DIR, 'research-results.csv');
  const dashData = path.join(ROOT, 'dashboard', 'data.json');

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(csvPath, toCsv(finalRows));
  fs.writeFileSync(sampleJson, JSON.stringify(payload, null, 2));
  fs.writeFileSync(sampleCsv, toCsv(finalRows));
  fs.writeFileSync(dashData, JSON.stringify(payload, null, 2));

  console.log('');
  console.log(`Wrote ${finalRows.length} rows:`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${csvPath}`);
  console.log(`  ${sampleJson}`);
  console.log(`  ${dashData}`);
  if (finalRows.length === 0) {
    console.error('No rows produced. Failing.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('Pipeline failed:', err.message);
  process.exit(1);
});
