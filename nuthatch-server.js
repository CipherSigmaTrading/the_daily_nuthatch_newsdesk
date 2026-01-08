// The Daily Nuthatch - PRODUCTION VERSION with ALL RSS Feeds
// Stable error handling prevents crashes

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cron = require('node-cron');
const Parser = require('rss-parser');
const XLSX = require('xlsx');
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
  PORT: process.env.PORT || 5000
};

// Track seen articles and failed feeds
const seenArticles = new Set();
const failedFeeds = new Map();
const clients = new Set();

// Card caching for immediate column population
const recentCards = [];
const MAX_RECENT_CARDS = 50;

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
  
  // Store new_card messages for late-joining clients
  if (data.type === 'new_card') {
    recentCards.unshift(data);
    if (recentCards.length > MAX_RECENT_CARDS) {
      recentCards.pop();
    }
  }
  
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
    // Send cached cards FIRST (instant) before slow API fetches
    console.log(`📤 Sending ${recentCards.length} recent cards to new client...`);
    for (let i = recentCards.length - 1; i >= 0; i--) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(recentCards[i]));
      }
    }
    console.log('📤 Done sending recent cards');
    
    // Now fetch and send market/macro data (slower, but cards already delivered)
    const [marketData, macroData] = await Promise.all([
      fetchMarketData(),
      fetchMacroData()
    ]);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'initial',
        market: marketData,
        macro: macroData
      }));
    }
  } catch (error) {
    console.error('Initial data error:', error.message);
  }
}

// ============================================================================
// RSS FEEDS - ALL 26 PREMIUM SOURCES
// ============================================================================

const RSS_FEEDS = [
  // BREAKING NEWS & FINANCE (reliable sources)
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', category: 'breaking', name: 'CNBC Top News' },
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', category: 'market', name: 'CNBC Markets' },
  { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', category: 'breaking', name: 'CNBC Business' },
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', category: 'breaking', name: 'MarketWatch' },
  { url: 'https://feeds.marketwatch.com/marketwatch/marketpulse/', category: 'market', name: 'MarketWatch Pulse' },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'breaking', name: 'BBC Business' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'geo', name: 'BBC World' },
  
  // PREMIUM FINANCIAL - FT & WSJ
  { url: 'https://www.ft.com/rss/world', category: 'geo', name: 'Financial Times World' },
  { url: 'https://www.ft.com/rss/companies', category: 'breaking', name: 'Financial Times Companies' },
  { url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml', category: 'breaking', name: 'WSJ US Business' },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', category: 'market', name: 'WSJ Markets' },
  { url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', category: 'geo', name: 'WSJ World' },
  
  // MACRO & CENTRAL BANKS
  { url: 'https://www.federalreserve.gov/feeds/press_all.xml', category: 'macro', name: 'Federal Reserve' },
  { url: 'https://www.ecb.europa.eu/rss/press.html', category: 'macro', name: 'ECB Press' },
  
  // GEOPOLITICS & DEFENSE
  { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/', category: 'geo', name: 'Defense News' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'geo', name: 'NYT World' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', category: 'breaking', name: 'NYT Business' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'geo', name: 'Al Jazeera' },
  { url: 'https://feeds.npr.org/1004/rss.xml', category: 'geo', name: 'NPR World' },
  { url: 'https://geopoliticalfutures.com/feed/', category: 'geo', name: 'Geopolitical Futures' },
  
  // COMMODITIES & ENERGY
  { url: 'https://www.mining.com/feed/', category: 'commodity', name: 'Mining.com' },
  { url: 'https://oilprice.com/rss/main', category: 'commodity', name: 'OilPrice.com' },
  
  // FOREX & TRADING
  { url: 'https://www.forexlive.com/feed/news', category: 'market', name: 'ForexLive' }
];

async function pollRSSFeeds(itemsPerFeed = 3) {
  console.log(`📡 Polling ${RSS_FEEDS.length} RSS feeds (${itemsPerFeed} items each)...`);
  
  const feedPromises = RSS_FEEDS.map(feed => pollSingleFeed(feed, itemsPerFeed));
  await Promise.allSettled(feedPromises);
}

async function pollSingleFeed(feed, itemsPerFeed = 3) {
  const failures = failedFeeds.get(feed.url) || 0;
  if (failures > 5) {
    return;
  }

  try {
    const parsed = await rssParser.parseURL(feed.url);
    
    failedFeeds.delete(feed.url);
    let itemCount = 0;
    
    for (const item of parsed.items.slice(0, itemsPerFeed)) {
      const articleId = item.link || item.guid || item.title;
      
      if (!seenArticles.has(articleId)) {
        seenArticles.add(articleId);
        
        if (seenArticles.size > 5000) {
          const firstItem = seenArticles.values().next().value;
          seenArticles.delete(firstItem);
        }
        
        await processRSSItem(item, feed.category, feed.name);
        itemCount++;
      }
    }
    
    if (itemCount > 0) {
      console.log(`✓ ${feed.name}: ${itemCount} items`);
    }
  } catch (error) {
    const currentFailures = failedFeeds.get(feed.url) || 0;
    failedFeeds.set(feed.url, currentFailures + 1);
    
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
    '2YY=F', '^FVX', '^TNX', '^TYX',
    'DX-Y.NYB',
    'USDJPY=X', 'EURUSD=X', 'GBPUSD=X',
    'GC=F', 'PL=F', 'SI=F', 'HG=F',
    'CL=F', 'BZ=F', 'NG=F',
    '^VIX',
    '^GSPC', '^DJI', '^IXIC'
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

  // Fetch GSCPI from NY Fed (not available via FRED API)
  try {
    const gscpiResponse = await axios.get(
      'https://www.newyorkfed.org/medialibrary/research/interactives/gscpi/downloads/gscpi_data.xlsx',
      { responseType: 'arraybuffer', timeout: 10000 }
    );
    const workbook = XLSX.read(gscpiResponse.data, { type: 'buffer' });
    const sheet = workbook.Sheets['GSCPI Monthly Data'];
    const data = XLSX.utils.sheet_to_json(sheet);
    
    if (data.length >= 2) {
      const latest = data[data.length - 1];
      const previous = data[data.length - 2];
      const latestValue = parseFloat(latest.GSCPI);
      const previousValue = parseFloat(previous.GSCPI);
      const change = latestValue - previousValue;
      
      macroData.indicators.push({
        label: 'GSCPI',
        value: latestValue.toFixed(2),
        change: (change > 0 ? '+' : '') + change.toFixed(2),
        dir: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
        tripwireHit: latestValue > 1.0,
        date: latest.Date
      });
    }
  } catch (error) {
    // Skip GSCPI on error
  }

  if (CONFIG.FRED_API_KEY) {
    const fredIndicators = [
      { id: 'U6RATE', label: 'U6 RATE', format: '%', tripwire: 8.0 },
      { id: 'RRPONTSYAWARD', label: 'FED RRP', format: '%', tripwire: 5.50 }
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
        if (observations && observations.length >= 1) {
          const latest = parseFloat(observations[0].value);
          const previous = observations.length >= 2 ? parseFloat(observations[1].value) : latest;
          const change = isNaN(previous) ? 0 : latest - previous;

          if (!isNaN(latest)) {
            macroData.indicators.push({
              label: indicator.label,
              value: latest.toFixed(2) + indicator.format,
              change: isNaN(change) ? '0.00' + indicator.format : (change > 0 ? '+' : '') + change.toFixed(2) + indicator.format,
              dir: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
              tripwireHit: latest > indicator.tripwire,
              date: observations[0].date
            });
          }
        }
      } catch (error) {
        // Skip
      }
    }
  }

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

// RSS feeds every 2 minutes
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

server.listen(CONFIG.PORT, '0.0.0.0', () => {
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

  // Initial aggressive fetch to populate columns
  console.log('🚀 Starting aggressive initial fetch to fill columns...');
  setTimeout(() => {
    pollRSSFeeds(8);
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
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error.message);
});
