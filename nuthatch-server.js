// The Daily Nuthatch - STABLE VERSION
// Clean build with all requested features

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const CONFIG = {
  NEWSAPI_KEY: process.env.NEWSAPI_KEY || '',
  FRED_API_KEY: process.env.FRED_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  PORT: process.env.PORT || 3000
};

// Track seen articles
const seenArticles = new Set();
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
// NEWS API - Business/Macro News
// ============================================================================

async function pollNewsAPI() {
  if (!CONFIG.NEWSAPI_KEY) {
    console.log('⚠️  NewsAPI key not configured');
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
          
          if (seenArticles.size > 1000) {
            seenArticles.clear();
          }
          
          await processNewsArticle(article);
        }
      }
    }
  } catch (error) {
    if (error.response?.status !== 429) {
      console.error('NewsAPI error:', error.message);
    }
  }
}

// ============================================================================
// NEWS API - Geopolitical News
// ============================================================================

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
          
          if (seenArticles.size > 1000) {
            seenArticles.clear();
          }
          
          await processNewsArticle(article, 'geo');
        }
      }
    }
  } catch (error) {
    if (error.response?.status !== 429) {
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
    macro: ['fed', 'federal reserve', 'ecb', 'central bank', 'interest rate', 
            'rates', 'yield', 'inflation', 'cpi', 'jobs', 'employment'],
    geo: ['russia', 'ukraine', 'china', 'taiwan', 'iran', 'military', 
          'sanctions', 'war', 'conflict', 'nato'],
    commodity: ['oil', 'crude', 'brent', 'wti', 'gold', 'silver', 'copper', 
                'wheat', 'energy', 'natgas', 'metals'],
    market: ['stock', 'equity', 'nasdaq', 'dow', 'rally', 'selloff']
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
// MARKET DATA - Yahoo Finance
// ============================================================================

async function fetchMarketData() {
  const symbols = [
    // Dollar & US Yields
    'DX-Y.NYB',      // Dollar Index
    '^TNX',          // US 10Y
    '^TYX',          // US 30Y
    '^FVX',          // US 5Y
    '2YY=F',         // US 2Y (futures)
    
    // Precious Metals
    'GC=F',          // Gold
    'SI=F',          // Silver
    'PL=F',          // Platinum
    
    // Energy
    'CL=F',          // WTI
    'BZ=F',          // Brent
    'NG=F',          // NatGas
    
    // Base Metals
    'HG=F',          // Copper
    
    // Equities
    '^GSPC',         // S&P 500
    '^IXIC',         // NASDAQ
    '^DJI',          // Dow
    
    // Forex (International Policy Proxies)
    'USDJPY=X',      // USD/JPY (BOJ proxy)
    'EURUSD=X',      // EUR/USD (ECB proxy)
    'GBPUSD=X',      // GBP/USD (BOE proxy)
    
    // Volatility
    '^VIX'           // VIX
  ];

  const marketData = [];

  for (const symbol of symbols) {
    try {
      const response = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,
        {
          params: { interval: '1m', range: '1d' },
          timeout: 5000
        }
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
      // Skip failed symbols silently
    }
  }

  return marketData;
}

function formatSymbolLabel(symbol) {
  const labels = {
    'DX-Y.NYB': 'DXY',
    '^TNX': 'US 10Y',
    '^TYX': 'US 30Y',
    '^FVX': 'US 5Y',
    '2YY=F': 'US 2Y',
    'GC=F': 'GOLD',
    'SI=F': 'SILVER',
    'PL=F': 'PLATINUM',
    'CL=F': 'WTI',
    'BZ=F': 'BRENT',
    'NG=F': 'NATGAS',
    'HG=F': 'COPPER',
    '^GSPC': 'S&P 500',
    '^IXIC': 'NASDAQ',
    '^DJI': 'DOW',
    'USDJPY=X': 'USD/JPY (BOJ)',
    'EURUSD=X': 'EUR/USD (ECB)',
    'GBPUSD=X': 'GBP/USD (BOE)',
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
  } else {
    return value.toFixed(2);
  }
}

function formatChange(symbol, change, changePercent) {
  if (symbol.startsWith('^T')) {
    const bps = change * 100;
    return (bps > 0 ? '+' : '') + bps.toFixed(1) + 'bp';
  }
  return (changePercent > 0 ? '+' : '') + changePercent.toFixed(2) + '%';
}

// ============================================================================
// MACRO DATA - FRED
// ============================================================================

async function fetchMacroData() {
  if (!CONFIG.FRED_API_KEY) {
    console.log('⚠️  FRED API key not configured');
    return [];
  }

  const indicators = [
    { id: 'SOFR', label: 'SOFR', tripwire: 5.50 },
    { id: 'RRPONTSYD', label: 'Fed RRP', tripwire: 200 }
  ];

  const macroData = [];

  for (const indicator of indicators) {
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

        macroData.push({
          label: indicator.label,
          value: latest.toFixed(2),
          change: (change > 0 ? '+' : '') + change.toFixed(2),
          dir: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
          tripwireHit: latest > indicator.tripwire,
          date: observations[0].date
        });
      }
    } catch (error) {
      // Skip
    }
  }

  return macroData;
}

// ============================================================================
// SCHEDULED JOBS
// ============================================================================

// Business news every 5 minutes
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
  ║   THE DAILY NUTHATCH LIVE DESK - STABLE VERSION      ║
  ║   Port: ${CONFIG.PORT}                                        ║
  ╚═══════════════════════════════════════════════════════╝
  
  📡 WebSocket: RUNNING
  📰 NewsAPI: ${CONFIG.NEWSAPI_KEY ? '✅ ENABLED' : '❌ DISABLED'}
  🏦 FRED Data: ${CONFIG.FRED_API_KEY ? '✅ ENABLED' : '❌ DISABLED'}
  📊 Market Data: ✅ ENABLED
  
  Assets: 19 live quotes
  ├─ US Yields: 10Y, 30Y, 5Y, 2Y
  ├─ Precious: Gold, Silver, Platinum  
  ├─ Energy: WTI, Brent, NatGas
  ├─ Equities: S&P, Nasdaq, Dow
  ├─ Forex (Int'l Policy): USD/JPY (BOJ), EUR/USD (ECB), GBP/USD (BOE)
  └─ Other: DXY, Copper, VIX
  
  News Sources:
  ├─ Business/Macro (every 5 min)
  └─ Geopolitics (every 7 min)
  
  Frontend: http://localhost:${CONFIG.PORT}
  `);

  // Initial fetches
  setTimeout(() => {
    console.log('📰 Initial NewsAPI fetch (business)...');
    pollNewsAPI();
  }, 3000);
  
  setTimeout(() => {
    console.log('🌍 Initial NewsAPI fetch (geopolitics)...');
    pollGeopoliticalNews();
  }, 5000);
});

// Graceful shutdown
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
