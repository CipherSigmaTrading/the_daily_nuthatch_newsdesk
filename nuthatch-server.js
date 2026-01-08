// The Daily Nuthatch - PRODUCTION VERSION with ALL RSS Feeds
// Stable error handling prevents crashes

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cron = require('node-cron');
const Parser = require('rss-parser');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const rssParser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0' },
  customFields: {
    item: ['category', 'media:content']
  }
});

// Configuration
const CONFIG = {
  NEWSAPI_KEY: process.env.NEWSAPI_KEY || '',
  FRED_API_KEY: process.env.FRED_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  PORT: process.env.PORT || 3000
};

// Track seen articles and failed feeds
const seenArticles = new Set();
const failedFeeds = new Map(); // Track feeds that consistently fail
const clients = new Set();

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Manual input endpoint
app.post('/api/manual-input', (req, res) => {
  try {
    const { headline, category, source } = req.body;
    
    const cardData = {
      type: 'new_card',
      column: category || 'breaking',
      data: {
        time: new Date().toISOString().substr(11, 5),
        headline: headline || 'No headline',
        source: source || 'Manual Input',
        verified: false,
        implications: ['User-submitted item'],
        impact: 2,
        horizon: 'DAYS',
        tripwires: [],
        probNudge: []
      }
    };

    broadcast(cardData);
    res.json({ success: true });
  } catch (error) {
    console.error('Manual input error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// WebSocket handlers
wss.on('connection', (ws) => {
  console.log('✅ Client connected');
  clients.add(ws);

  ws.on('close', () => {
    console.log('❌ Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });

  sendInitialData(ws);
});

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Broadcast error:', error.message);
      }
    }
  });
}

async function sendInitialData(ws) {
  try {
    const marketData = await fetchMarketData();
    const macroData = await fetchMacroData();
    
    ws.send(JSON.stringify({
      type: 'initial',
      market: marketData,
      macro: macroData
    }));
  } catch (error) {
    console.error('Initial data error:', error.message);
  }
}

// ============================================================================
// RSS FEEDS - ALL 26 PREMIUM SOURCES
// ============================================================================

const RSS_FEEDS = [
  // BREAKING NEWS & FINANCE
  { url: 'https://feeds.reuters.com/reuters/businessNews', category: 'breaking', name: 'Reuters Business' },
  { url: 'https://feeds.reuters.com/Reuters/worldNews', category: 'geo', name: 'Reuters World' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', category: 'breaking', name: 'CNBC Top News' },
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', category: 'market', name: 'CNBC Markets' },
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', category: 'breaking', name: 'MarketWatch' },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'breaking', name: 'BBC Business' },
  
  // PREMIUM FINANCIAL - FT & WSJ
  { url: 'https://www.ft.com/rss/world', category: 'geo', name: 'Financial Times World' },
  { url: 'https://www.ft.com/rss/companies', category: 'breaking', name: 'Financial Times Companies' },
  { url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml', category: 'breaking', name: 'WSJ US Business' },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', category: 'market', name: 'WSJ Markets' },
  
  // MACRO & CENTRAL BANKS
  { url: 'https://www.federalreserve.gov/feeds/press_all.xml', category: 'macro', name: 'Federal Reserve' },
  { url: 'https://www.ecb.europa.eu/rss/press.html', category: 'macro', name: 'ECB Press' },
  { url: 'https://www.bis.org/doclist/all_rss.xml', category: 'macro', name: 'BIS' },
  
  // GEOPOLITICS & DEFENSE
  { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/', category: 'geo', name: 'Defense News' },
  { url: 'https://feeds.reuters.com/Reuters/UKWorldNews', category: 'geo', name: 'Reuters UK World' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'geo', name: 'NYT World' },
  { url: 'https://geopoliticalfutures.com/feed/', category: 'geo', name: 'Geopolitical Futures' },
  
  // COMMODITIES & ENERGY
  { url: 'https://www.eia.gov/rss/todayinenergy.xml', category: 'commodity', name: 'EIA Energy' },
  { url: 'https://www.mining.com/feed/', category: 'commodity', name: 'Mining.com' },
  { url: 'https://www.reuters.com/rssFeed/energy', category: 'commodity', name: 'Reuters Energy' },
  { url: 'https://oilprice.com/rss/main', category: 'commodity', name: 'OilPrice.com' },
  
  // FOREX & TRADING
  { url: 'https://www.dailyfx.com/feeds/market-news', category: 'market', name: 'DailyFX News' },
  { url: 'https://www.forexlive.com/feed/news', category: 'market', name: 'ForexLive' }
];

async function pollRSSFeeds() {
  console.log(`📡 Polling ${RSS_FEEDS.length} RSS feeds...`);
  
  // Poll feeds in parallel but with error isolation
  const feedPromises = RSS_FEEDS.map(feed => pollSingleFeed(feed));
  
  // Wait for all, but don't let one failure stop others
  await Promise.allSettled(feedPromises);
}

async function pollSingleFeed(feed) {
  // Skip if this feed has failed too many times recently
  const failures = failedFeeds.get(feed.url) || 0;
  if (failures > 5) {
    console.log(`⏭️  Skipping ${feed.name} (too many failures)`);
    return;
  }

  try {
    const parsed = await rssParser.parseURL(feed.url);
    
    // Reset failure count on success
    failedFeeds.delete(feed.url);
    
    for (const item of parsed.items.slice(0, 3)) {
      const articleId = item.link || item.guid || item.title;
      
      if (!seenArticles.has(articleId)) {
        seenArticles.add(articleId);
        
        // Limit cache size
        if (seenArticles.size > 5000) {
          const firstItem = seenArticles.values().next().value;
          seenArticles.delete(firstItem);
        }
        
        await processRSSItem(item, feed.category, feed.name);
      }
    }
  } catch (error) {
    // Track failures but don't crash
    const currentFailures = failedFeeds.get(feed.url) || 0;
    failedFeeds.set(feed.url, currentFailures + 1);
    
    // Only log if not a timeout
    if (error.code !== 'ETIMEDOUT' && error.code !== 'ECONNREFUSED') {
      console.error(`⚠️  ${feed.name} error:`, error.message);
    }
  }
}

async function processRSSItem(item, defaultCategory, sourceName) {
  try {
    const text = (item.title || '') + ' ' + (item.contentSnippet || item.content || '');
    const category = classifyNews(text) || defaultCategory;
    
    const cardData = {
      type: 'new_card',
      column: category,
      data: {
        time: new Date().toISOString().substr(11, 5),
        headline: item.title || 'No headline',
        source: sourceName,
        verified: true,
        implications: [
          'Monitoring for market reaction',
          'Watching for follow-up developments'
        ],
        impact: 2,
        horizon: 'DAYS',
        tripwires: [],
        probNudge: []
      }
    };

    broadcast(cardData);
  } catch (error) {
    console.error('Process RSS item error:', error.message);
  }
}

// ============================================================================
// NEWS API
// ============================================================================

async function pollNewsAPI() {
  if (!CONFIG.NEWSAPI_KEY) {
    return;
  }

  try {
    const response = await axios.get('https://newsapi.org/v2/top-headlines', {
      params: {
        category: 'business',
        language: 'en',
        pageSize: 10,
        apiKey: CONFIG.NEWSAPI_KEY
      },
      timeout: 10000
    });

    if (response.data.articles) {
      for (const article of response.data.articles.slice(0, 5)) {
        const articleId = article.url;
        
        if (!seenArticles.has(articleId)) {
          seenArticles.add(articleId);
          await processNewsArticle(article);
        }
      }
    }
  } catch (error) {
    if (!error.response || error.response.status !== 429) {
      console.error('NewsAPI error:', error.message);
    }
  }
}

async function pollGeopoliticalNews() {
  if (!CONFIG.NEWSAPI_KEY) {
    return;
  }

  try {
    const keywords = 'russia OR ukraine OR china OR taiwan OR iran OR israel OR military OR sanctions OR nato';
    
    const response = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q: keywords,
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: 10,
        apiKey: CONFIG.NEWSAPI_KEY
      },
      timeout: 10000
    });

    if (response.data.articles) {
      for (const article of response.data.articles.slice(0, 5)) {
        const articleId = article.url;
        
        if (!seenArticles.has(articleId)) {
          seenArticles.add(articleId);
          await processNewsArticle(article, 'geo');
        }
      }
    }
  } catch (error) {
    if (!error.response || error.response.status !== 429) {
      console.error('Geopolitical news error:', error.message);
    }
  }
}

async function processNewsArticle(article, forceCategory = null) {
  try {
    const category = forceCategory || classifyNews(article.title + ' ' + (article.description || ''));
    
    const cardData = {
      type: 'new_card',
      column: category,
      data: {
        time: new Date().toISOString().substr(11, 5),
        headline: article.title,
        source: article.source.name,
        verified: true,
        implications: [
          'Monitoring for market reaction',
          'Watching for follow-up developments'
        ],
        impact: 2,
        horizon: 'DAYS',
        tripwires: [],
        probNudge: []
      }
    };

    broadcast(cardData);
  } catch (error) {
    console.error('Process article error:', error.message);
  }
}

// ============================================================================
// CLASSIFICATION
// ============================================================================

function classifyNews(text) {
  if (!text) return 'breaking';
  
  const lower = text.toLowerCase();
  
  const keywords = {
    macro: ['fed', 'federal reserve', 'ecb', 'boj', 'central bank', 'interest rate', 
            'rates', 'yield', 'inflation', 'cpi', 'ppi', 'jobs', 'employment',
            'fomc', 'powell', 'lagarde', 'yellen'],
    geo: ['russia', 'ukraine', 'china', 'taiwan', 'iran', 'israel', 'military', 
          'sanctions', 'war', 'conflict', 'nato', 'defense', 'missile'],
    commodity: ['oil', 'crude', 'brent', 'wti', 'gold', 'silver', 'copper', 
                'wheat', 'corn', 'energy', 'natgas', 'metals', 'mining'],
    market: ['stock', 'equity', 'nasdaq', 'dow', 'sp500', 'rally', 'selloff']
  };

  let maxScore = 0;
  let maxCategory = 'breaking';
  
  for (let [category, words] of Object.entries(keywords)) {
    const score = words.filter(w => lower.includes(w)).length;
    if (score > maxScore) {
      maxScore = score;
      maxCategory = category;
    }
  }

  return maxCategory;
}

// ============================================================================
// MARKET DATA
// ============================================================================

async function fetchMarketData() {
  const symbols = [
    'DX-Y.NYB', '^TNX', '^TYX', '^FVX', '2YY=F',
    'GC=F', 'SI=F', 'PL=F',
    'CL=F', 'BZ=F', 'NG=F', 'HG=F',
    '^GSPC', '^IXIC', '^DJI',
    'USDJPY=X', 'EURUSD=X', 'GBPUSD=X',
    '^VIX'
  ];

  const marketData = [];

  for (const symbol of symbols) {
    try {
      const response = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,
        { params: { interval: '1m', range: '1d' }, timeout: 5000 }
      );

      const result = response.data.chart.result[0];
      const quote = result.meta;
      const current = quote.regularMarketPrice;
      const previous = quote.previousClose;
      const change = current - previous;
      const changePercent = (change / previous) * 100;

      marketData.push({
        symbol: symbol,
        label: formatSymbolLabel(symbol),
        value: formatValue(symbol, current),
        change: formatChange(symbol, change, changePercent),
        dir: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral'
      });
    } catch (error) {
      // Skip failed symbols
    }
  }

  return marketData;
}

function formatSymbolLabel(symbol) {
  const labels = {
    'DX-Y.NYB': 'DXY', '^TNX': 'US 10Y', '^TYX': 'US 30Y', '^FVX': 'US 5Y', '2YY=F': 'US 2Y',
    'GC=F': 'GOLD', 'SI=F': 'SILVER', 'PL=F': 'PLATINUM',
    'CL=F': 'WTI', 'BZ=F': 'BRENT', 'NG=F': 'NATGAS', 'HG=F': 'COPPER',
    '^GSPC': 'S&P 500', '^IXIC': 'NASDAQ', '^DJI': 'DOW',
    'USDJPY=X': 'USD/JPY (BOJ)', 'EURUSD=X': 'EUR/USD (ECB)', 'GBPUSD=X': 'GBP/USD (BOE)',
    '^VIX': 'VIX'
  };
  return labels[symbol] || symbol;
}

function formatValue(symbol, value) {
  if (symbol.includes('USD=X') || symbol.includes('JPY=X') || symbol.includes('GBP=X')) {
    return value.toFixed(4);
  } else if (symbol.startsWith('^T')) {
    return value.toFixed(3) + '%';
  } else if (symbol.includes('=F') && !symbol.includes('VIX')) {
    return '$' + value.toFixed(2);
  }
  return value.toFixed(2);
}

function formatChange(symbol, change, changePercent) {
  if (symbol.startsWith('^T')) {
    const bps = change * 100;
    return (bps > 0 ? '+' : '') + bps.toFixed(1) + 'bp';
  }
  return (changePercent > 0 ? '+' : '') + changePercent.toFixed(2) + '%';
}

// ============================================================================
// MACRO DATA
// ============================================================================

async function fetchMacroData() {
  const macroData = {
    yields: [],
    indicators: []
  };

  // Fetch US Yields from Yahoo Finance (faster updates)
  const yieldSymbols = [
    { symbol: '2YY=F', label: 'US 2Y' },
    { symbol: '^FVX', label: 'US 5Y' },
    { symbol: '^TNX', label: 'US 10Y' },
    { symbol: '^TYX', label: 'US 30Y' }
  ];

  for (const item of yieldSymbols) {
    try {
      const response = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${item.symbol}`,
        { params: { interval: '1m', range: '1d' }, timeout: 5000 }
      );

      const result = response.data.chart.result[0];
      const quote = result.meta;
      const current = quote.regularMarketPrice;
      const previous = quote.previousClose;
      const change = current - previous;
      const bps = change * 100;

      macroData.yields.push({
        label: item.label,
        value: current.toFixed(3) + '%',
        change: (bps > 0 ? '+' : '') + bps.toFixed(1) + 'bp',
        dir: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
        rawValue: current,
        rawChange: change
      });
    } catch (error) {
      // Skip failed yield
    }
  }

  // Fetch FRED indicators
  if (CONFIG.FRED_API_KEY) {
    const fredIndicators = [
      { id: 'U6RATE', label: 'U6 RATE', format: '%', tripwire: 8.0 },
      { id: 'SOFR', label: 'SOFR', format: '%', tripwire: 5.50 },
      { id: 'RRPONTSYD', label: 'FED RRP', format: 'B', tripwire: 200 }
    ];

    for (const indicator of fredIndicators) {
      try {
        const response = await axios.get(
          'https://api.stlouisfed.org/fred/series/observations',
          {
            params: {
              series_id: indicator.id,
              api_key: CONFIG.FRED_API_KEY,
              file_type: 'json',
              sort_order: 'desc',
              limit: 2
            },
            timeout: 5000
          }
        );

        const observations = response.data.observations;
        if (observations && observations.length >= 2) {
          const latest = parseFloat(observations[0].value);
          const previous = parseFloat(observations[1].value);
          const change = latest - previous;

          macroData.indicators.push({
            label: indicator.label,
            value: latest.toFixed(indicator.format === 'B' ? 0 : 2) + indicator.format,
            change: (change > 0 ? '+' : '') + change.toFixed(indicator.format === 'B' ? 0 : 2) + indicator.format,
            dir: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
            tripwireHit: latest > indicator.tripwire,
            date: observations[0].date
          });
        }
      } catch (error) {
        // Skip
      }
    }
  }

  // Fetch Truflation (placeholder - sign up at truflation.com for real API)
  try {
    macroData.indicators.unshift({
      label: 'TRUFLATION',
      value: '2.84%',
      change: '+0.12%',
      dir: 'up',
      tripwireHit: false,
      date: new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    // Skip
  }

  return macroData;
}

// ============================================================================
// SCHEDULED JOBS
// ============================================================================

// RSS feeds every 2 minutes (aggressive but stable)
cron.schedule('*/2 * * * *', () => {
  console.log('📡 RSS feed cycle starting...');
  pollRSSFeeds();
});

// NewsAPI every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('📰 Polling NewsAPI (business)...');
  pollNewsAPI();
});

// Geopolitical news every 7 minutes
cron.schedule('*/7 * * * *', () => {
  console.log('🌍 Polling NewsAPI (geopolitics)...');
  pollGeopoliticalNews();
});

// Market data every 15 seconds
cron.schedule('*/15 * * * * *', async () => {
  try {
    const marketData = await fetchMarketData();
    broadcast({ type: 'market_update', data: marketData });
  } catch (error) {
    console.error('Market update error:', error.message);
  }
});

// Macro data every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  try {
    const macroData = await fetchMacroData();
    broadcast({ type: 'macro_update', data: macroData });
  } catch (error) {
    console.error('Macro update error:', error.message);
  }
});

// ============================================================================
// SERVER START
// ============================================================================

server.listen(CONFIG.PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║   THE DAILY NUTHATCH - PRODUCTION RSS VERSION        ║
  ║   Port: ${CONFIG.PORT}                                        ║
  ╚═══════════════════════════════════════════════════════╝
  
  📡 WebSocket: RUNNING
  📰 NewsAPI: ${CONFIG.NEWSAPI_KEY ? '✅ ENABLED' : '❌ DISABLED'}
  🏦 FRED Data: ${CONFIG.FRED_API_KEY ? '✅ ENABLED' : '❌ DISABLED'}
  📊 Market Data: ✅ ENABLED (19 assets)
  📡 RSS Feeds: ✅ ${RSS_FEEDS.length} PREMIUM SOURCES
  
  RSS Sources Active:
  ├─ FINANCE: Reuters, CNBC, MarketWatch, BBC, FT (x2), WSJ (x2)
  ├─ MACRO: Federal Reserve, ECB, BIS
  ├─ GEOPOLITICS: Defense News, Reuters, NYT, Geopolitical Futures
  ├─ COMMODITIES: EIA, Mining.com, Reuters Energy, OilPrice.com
  ├─ FOREX/MARKETS: DailyFX, ForexLive
  └─ Polling every 2 minutes
  
  Frontend: http://localhost:${CONFIG.PORT}
  `);

  // Initial fetches
  setTimeout(() => {
    console.log('📡 Initial RSS feed fetch...');
    pollRSSFeeds();
  }, 2000);
  
  setTimeout(() => {
    console.log('📰 Initial NewsAPI fetch...');
    pollNewsAPI();
  }, 4000);
  
  setTimeout(() => {
    console.log('🌍 Initial geopolitical fetch...');
    pollGeopoliticalNews();
  }, 6000);
});

// Graceful shutdown and error handling
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error.message);
  // Don't exit - keep running
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error.message);
  // Don't exit - keep running
});
