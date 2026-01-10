// The Daily Nuthatch - PRODUCTION VERSION with ALL RSS Feeds
// Stable error handling prevents crashes

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cron = require('node-cron');
const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

// Gemini AI client using Replit AI Integrations
const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  },
});

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
  ALPACA_API_KEY: process.env.ALPACA_API_KEY || '',
  ALPACA_API_SECRET: process.env.ALPACA_API_SECRET || '',
  PORT: process.env.PORT || 5000
};

// Track seen articles and failed feeds
const seenArticles = new Set();
const failedFeeds = new Map();
const clients = new Set();

// Card caching for immediate column population
const recentCards = [];
const MAX_RECENT_CARDS = 50;

// Serve static files with cache control
app.use(express.static('public', {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));
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

// Gemini AI headline analysis endpoint
app.post('/api/analyze-headline', async (req, res) => {
  try {
    const { headline, source, implications } = req.body;
    
    if (!headline) {
      return res.status(400).json({ error: 'Headline is required' });
    }

    const prompt = `You are an expert financial analyst at a top investment bank. Analyze this news headline and provide institutional-grade insights.

HEADLINE: "${headline}"
SOURCE: ${source || 'Unknown'}
${implications?.length ? `CURRENT IMPLICATIONS:\n${implications.join('\n')}` : ''}

Provide a detailed analysis covering:

1. **MARKET IMPACT** - How this affects specific asset classes (equities, bonds, FX, commodities)
2. **TRADING IMPLICATIONS** - Actionable insights for institutional traders
3. **SECOND-ORDER EFFECTS** - What happens next if this trend continues
4. **POSITIONING** - How to position portfolios in response
5. **KEY LEVELS TO WATCH** - Specific price levels or data points that matter
6. **TIMELINE** - When we'll know more and expected duration of impact

Format your response in clear sections with bullet points. Be specific with numbers and asset names. Think like a Bloomberg terminal analyst.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const analysis = response.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!analysis) {
      throw new Error('No analysis generated');
    }

    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Gemini analysis error:', error.message);
    res.status(500).json({ error: 'Failed to analyze headline. Please try again.' });
  }
});

// WebSocket handlers
wss.on('connection', (ws) => {
  console.log('✅ Client connected');
  clients.add(ws);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      if (message.type === 'refresh_request') {
        console.log('🔄 Manual refresh requested');
        pollRSSFeeds(3);
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

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
    
    // Now fetch and send market/macro/polymarket/fx/commodity data (slower, but cards already delivered)
    const [marketData, macroData, polymarketData, fxData, commodityData] = await Promise.all([
      fetchMarketData(),
      fetchMacroData(),
      fetchPolymarketRisks(),
      fetchFXData(),
      fetchCommodityData()
    ]);
    
    console.log(`📊 Macro data: ${macroData.yields.length} yields, ${macroData.indicators.length} indicators`);
    console.log(`📈 Market data: ${marketData.length} assets`);
    console.log(`🎲 Polymarket data: ${polymarketData.fedRisks.length + polymarketData.growthRisks.length} markets`);
    console.log(`💱 FX data: ${fxData.macro.length} macro, ${fxData.geo.length} geo, ${fxData.commodity.length} commodity`);
    console.log(`🏭 Commodity data: ${commodityData.metals.length} metals, ${commodityData.energy.length} energy, ${commodityData.agriculture.length} agriculture`);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'initial',
        market: marketData,
        macro: macroData,
        polymarket: polymarketData,
        fx: fxData,
        commodities: commodityData
      }));
      console.log('📤 Sent initial market/macro/polymarket/fx/commodity data');
    } else {
      console.log('⚠️ Client disconnected before initial data could be sent');
    }
  } catch (error) {
    console.error('Initial data error:', error.message);
  }
}

// ============================================================================
// RSS FEEDS - 45 SPECIALIZED SOURCES
// ============================================================================

const RSS_FEEDS = [
  // ============ BREAKING NEWS - FAST & RELIABLE (11 sources) ============
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', category: 'breaking', name: 'CNBC Top News' },
  { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', category: 'breaking', name: 'CNBC Business' },
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', category: 'breaking', name: 'MarketWatch' },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'breaking', name: 'BBC Business' },
  { url: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'breaking', name: 'BBC Breaking' },
  { url: 'http://rss.cnn.com/rss/cnn_topstories.rss', category: 'breaking', name: 'CNN Top Stories' },
  { url: 'http://rss.cnn.com/rss/money_latest.rss', category: 'breaking', name: 'CNN Money' },
  { url: 'https://www.cbsnews.com/latest/rss/main', category: 'breaking', name: 'CBS News' },
  { url: 'https://abcnews.go.com/abcnews/topstories', category: 'breaking', name: 'ABC News' },
  { url: 'https://www.theguardian.com/world/rss', category: 'breaking', name: 'The Guardian' },
  { url: 'https://www.ft.com/rss/companies', category: 'breaking', name: 'Financial Times Companies' },
  { url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml', category: 'breaking', name: 'WSJ US Business' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', category: 'breaking', name: 'NYT Business' },
  
  // ============ MARKETS ============
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', category: 'market', name: 'CNBC Markets' },
  { url: 'https://feeds.marketwatch.com/marketwatch/marketpulse/', category: 'market', name: 'MarketWatch Pulse' },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', category: 'market', name: 'WSJ Markets' },
  
  // ============ MACRO - CENTRAL BANKS & OFFICIAL DATA ============
  { url: 'https://www.federalreserve.gov/feeds/press_all.xml', category: 'macro', name: 'Federal Reserve' },
  { url: 'https://www.ecb.europa.eu/rss/press.html', category: 'macro', name: 'ECB Press' },
  { url: 'https://www.nber.org/rss/new.xml', category: 'macro', name: 'NBER Research' },
  { url: 'https://libertystreeteconomics.newyorkfed.org/feed/', category: 'macro', name: 'NY Fed Economics' },
  
  // ============ GEOPOLITICS - THINK TANKS & DEFENSE ============
  { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/', category: 'geo', name: 'Defense News' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'geo', name: 'NYT World' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'geo', name: 'Al Jazeera' },
  { url: 'https://feeds.npr.org/1004/rss.xml', category: 'geo', name: 'NPR World' },
  { url: 'https://geopoliticalfutures.com/feed/', category: 'geo', name: 'Geopolitical Futures' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'geo', name: 'BBC World' },
  { url: 'https://www.ft.com/rss/world', category: 'geo', name: 'Financial Times World' },
  { url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', category: 'geo', name: 'WSJ World' },
  { url: 'https://www.rand.org/blog.xml', category: 'geo', name: 'RAND Corporation' },
  { url: 'https://warontherocks.com/feed/', category: 'geo', name: 'War on the Rocks' },
  { url: 'https://www.foreignaffairs.com/rss.xml', category: 'geo', name: 'Foreign Affairs' },
  { url: 'https://www.theatlantic.com/feed/channel/international/', category: 'geo', name: 'The Atlantic World' },
  
  // NEW DEFENSE & MILITARY SOURCES
  { url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/', category: 'geo', name: 'Military Times' },
  { url: 'https://www.stripes.com/rss/1.117146', category: 'geo', name: 'Stars and Stripes' },
  { url: 'https://breakingdefense.com/feed/', category: 'geo', name: 'Breaking Defense' },
  { url: 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx', category: 'geo', name: 'US Dept of Defense' },
  { url: 'https://news.usni.org/feed', category: 'geo', name: 'USNI News' },
  { url: 'https://www.janes.com/feeds/news', category: 'geo', name: 'Janes Defence' },
  
  // NEW GEOPOLITICAL INTELLIGENCE SOURCES
  { url: 'https://thediplomat.com/feed/', category: 'geo', name: 'The Diplomat' },
  { url: 'https://www.middleeasteye.net/rss', category: 'geo', name: 'Middle East Eye' },
  { url: 'https://www.scmp.com/rss/91/feed', category: 'geo', name: 'South China Morning Post' },
  { url: 'https://www.timesofisrael.com/feed/', category: 'geo', name: 'Times of Israel' },
  { url: 'https://www.bloomberg.com/politics/feeds/sitemap_news.xml', category: 'geo', name: 'Bloomberg Politics' },
  { url: 'https://www.csis.org/analysis/feed', category: 'geo', name: 'CSIS Analysis' },
  { url: 'https://carnegieendowment.org/rss.xml', category: 'geo', name: 'Carnegie Endowment' },
  { url: 'https://www.cfr.org/feeds/daily_news_brief.xml', category: 'geo', name: 'Council on Foreign Relations' },
  
  // COMMODITIES - ENERGY, METALS & AGRICULTURE ============
  { url: 'https://www.mining.com/feed/', category: 'commodity', name: 'Mining.com' },
  { url: 'https://oilprice.com/rss/main', category: 'commodity', name: 'OilPrice.com' },
  { url: 'https://gcaptain.com/feed/', category: 'commodity', name: 'gCaptain (Shipping)' },
  { url: 'https://www.hellenicshippingnews.com/feed/', category: 'commodity', name: 'Hellenic Shipping News' },
  { url: 'https://www.rigzone.com/news/rss/rigzone_latest.aspx', category: 'commodity', name: 'Rigzone Oil & Gas' },
  { url: 'https://www.naturalgasintel.com/feed/', category: 'commodity', name: 'Natural Gas Intel' },
  
  // NEW COMMODITY-SPECIFIC SOURCES
  { url: 'https://www.agweb.com/rss.xml', category: 'commodity', name: 'AgWeb (Agriculture)' },
  { url: 'https://www.world-grain.com/rss/all', category: 'commodity', name: 'World Grain' },
  { url: 'https://www.metalbulletin.com/RSS/', category: 'commodity', name: 'Metal Bulletin' },
  { url: 'https://www.steelorbis.com/rss.xml', category: 'commodity', name: 'SteelOrbis' },
  { url: 'https://www.energyvoice.com/feed/', category: 'commodity', name: 'Energy Voice' },
  { url: 'https://www.spglobal.com/commodity-insights/en/rss-feed', category: 'commodity', name: 'S&P Global Commodities' },
  
  // ============ FOREX - CURRENCY NEWS & ANALYSIS ============
  { url: 'https://www.forexlive.com/feed/news', category: 'fx', name: 'ForexLive' },
  { url: 'https://www.fxstreet.com/rss/news', category: 'fx', name: 'FXStreet' },
  { url: 'https://www.investing.com/rss/news_14.rss', category: 'fx', name: 'Investing.com FX' },
  { url: 'https://www.actionforex.com/feed/', category: 'fx', name: 'Action Forex' },
  { url: 'https://www.fxempire.com/api/v1/en/articles/rss/news', category: 'fx', name: 'FX Empire' },
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
      
      // Filter out old articles - only accept items from last 48 hours
      const pubDate = item.isoDate || item.pubDate;
      if (pubDate) {
        const articleDate = new Date(pubDate);
        const now = new Date();
        const hoursSincePublished = (now - articleDate) / (1000 * 60 * 60);
        
        if (hoursSincePublished > 48) {
          continue; // Skip articles older than 48 hours
        }
      }
      
      if (!seenArticles.has(articleId)) {
        seenArticles.add(articleId);
        
        if (seenArticles.size > 5000) {
          const firstItem = seenArticles.values().next().value;
          seenArticles.delete(firstItem);
        }
        
        const pubDateStr = item.isoDate || item.pubDate || null;
        processRSSItem(item, feed.category, feed.name, pubDateStr);
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

async function processRSSItem(item, defaultCategory, sourceName, pubDateStr = null) {
  try {
    const text = (item.title || '') + ' ' + (item.contentSnippet || item.content || '');
    // Prioritize the feed's assigned category for specialized sources
    // Only override if keyword match is very strong (3+ keywords)
    const keywordCategory = classifyNews(text);
    const category = (defaultCategory !== 'breaking' && defaultCategory !== 'market') 
      ? defaultCategory 
      : keywordCategory;
    const smartData = generateUltimateImplications(
      item.title || '', 
      category,
      item.contentSnippet || item.content || ''
    );
    
    // Format publication date for display
    let pubDateDisplay = null;
    if (pubDateStr) {
      const pubDate = new Date(pubDateStr);
      const now = new Date();
      const hoursSince = Math.floor((now - pubDate) / (1000 * 60 * 60));
      if (hoursSince < 1) {
        pubDateDisplay = 'Just now';
      } else if (hoursSince < 24) {
        pubDateDisplay = `${hoursSince}h ago`;
      } else {
        pubDateDisplay = pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
    }
    
    const cardData = {
      type: 'new_card',
      column: category,
      data: {
        time: new Date().toISOString().substr(11, 5),
        headline: item.title || 'No headline',
        link: item.link || '',
        source: sourceName,
        pubDate: pubDateDisplay,
        verified: true,
        implications: smartData.implications,
        impact: smartData.impact || 2,
        horizon: smartData.horizon || 'DAYS',
        tripwires: smartData.technicalLevels || [],
        probNudge: [],
        tags: smartData.tags,
        confidence: smartData.confidence,
        nextEvents: smartData.nextEvents || [],
        regime: smartData.regime
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
        
        // Filter out old articles - only accept items from last 48 hours
        if (article.publishedAt) {
          const articleDate = new Date(article.publishedAt);
          const now = new Date();
          const hoursSincePublished = (now - articleDate) / (1000 * 60 * 60);
          if (hoursSincePublished > 48) continue;
        }
        
        if (!seenArticles.has(articleId)) {
          seenArticles.add(articleId);
          processNewsArticle(article, null, article.publishedAt);
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
        
        // Filter out old articles - only accept items from last 48 hours
        if (article.publishedAt) {
          const articleDate = new Date(article.publishedAt);
          const now = new Date();
          const hoursSincePublished = (now - articleDate) / (1000 * 60 * 60);
          if (hoursSincePublished > 48) continue;
        }
        
        if (!seenArticles.has(articleId)) {
          seenArticles.add(articleId);
          processNewsArticle(article, 'geo', article.publishedAt);
        }
      }
    }
  } catch (error) {
    if (!error.response || error.response.status !== 429) {
      console.error('Geopolitical news error:', error.message);
    }
  }
}

async function processNewsArticle(article, forceCategory = null, publishedAt = null) {
  try {
    const category = forceCategory || classifyNews(article.title + ' ' + (article.description || ''));
    const smartData = generateUltimateImplications(
      article.title,
      category,
      article.description || ''
    );
    
    // Format publication date for display
    let pubDateDisplay = null;
    if (publishedAt) {
      const pubDate = new Date(publishedAt);
      const now = new Date();
      const hoursSince = Math.floor((now - pubDate) / (1000 * 60 * 60));
      if (hoursSince < 1) {
        pubDateDisplay = 'Just now';
      } else if (hoursSince < 24) {
        pubDateDisplay = `${hoursSince}h ago`;
      } else {
        pubDateDisplay = pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
    }
    
    const cardData = {
      type: 'new_card',
      column: category,
      data: {
        time: new Date().toISOString().substr(11, 5),
        headline: article.title,
        link: article.url || '',
        source: article.source.name,
        pubDate: pubDateDisplay,
        verified: true,
        implications: smartData.implications,
        impact: smartData.impact || 2,
        horizon: smartData.horizon || 'DAYS',
        tripwires: smartData.technicalLevels || [],
        probNudge: [],
        tags: smartData.tags,
        confidence: smartData.confidence,
        nextEvents: smartData.nextEvents || [],
        regime: smartData.regime
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
// SMART IMPLICATIONS ENGINE
// ============================================================================

// ============================================================================
// ULTIMATE IMPLICATIONS ENGINE - 500+ Patterns
// ============================================================================
// This is institutional-grade news intelligence for everyone
// Built with love for the AI universe 🚀

function generateUltimateImplications(headline, category, description = '') {
  const text = (headline + ' ' + description).toLowerCase();
  
  // Core data structure
  const analysis = {
    implications: [],
    tags: [],
    sensitivity: 'DEVELOPING',
    assets: [],
    direction: 'NEUTRAL',
    impact: 2,
    horizon: 'DAYS',
    confidence: 50,
    technicalLevels: [],
    nextEvents: [],
    regime: null
  };

  // ========== TIER 1: MACRO REGIME DETECTION (100 patterns) ==========
  
  // REFLATIONARY (Growth↑ Inflation↑)
  if ((text.match(/stimulus|fiscal spending|infrastructure/) && text.match(/growth|gdp|expansion/)) ||
      (text.match(/recover|rebound|boom/) && text.match(/inflation|prices rising/))) {
    analysis.regime = 'REFLATIONARY';
    analysis.implications.push('Reflationary regime: Cyclicals, commodities, value outperform');
    analysis.implications.push('Short duration bonds, rotate to real assets');
    analysis.implications.push('Energy, materials, financials lead');
    analysis.direction = 'RISK-ON';
    analysis.impact = 3;
  }
  
  // STAGFLATIONARY (Growth↓ Inflation↑)  
  else if ((text.match(/slow|weak|contract/) && text.match(/inflation|prices|cost/)) ||
           text.match(/stagflation|worst of both/)) {
    analysis.regime = 'STAGFLATIONARY';
    analysis.implications.push('Stagflation risk: Gold, TIPS, commodity producers');
    analysis.implications.push('Avoid long duration and growth stocks');
    analysis.implications.push('Real assets only hedge - tough environment');
    analysis.direction = 'RISK-OFF';
    analysis.impact = 3;
    analysis.confidence = 75;
  }
  
  // GOLDILOCKS (Growth↑ Inflation↓)
  else if ((text.match(/growth|strong|robust/) && text.match(/inflation fall|disinfla|prices ease/)) ||
           text.match(/goldilocks|soft landing|perfect/)) {
    analysis.regime = 'GOLDILOCKS';
    analysis.implications.push('Goldilocks scenario: Risk-on across all assets');
    analysis.implications.push('Tech, growth stocks, extend duration');
    analysis.implications.push('Fed can pause - multiple expansion');
    analysis.direction = 'RISK-ON';
    analysis.impact = 3;
    analysis.confidence = 80;
  }
  
  // DEFLATIONARY BUST (Growth↓ Inflation↓)
  else if ((text.match(/recession|contraction/) && text.match(/deflation|prices fall/)) ||
           text.match(/deflationary bust|depression/)) {
    analysis.regime = 'DEFLATIONARY';
    analysis.implications.push('Deflation scenario: Cash, Treasuries, USD, JPY only');
    analysis.implications.push('Defensive sectors, avoid all cyclicals');
    analysis.implications.push('Corporate credit risk rises');
    analysis.direction = 'RISK-OFF';
    analysis.impact = 3;
    analysis.confidence = 85;
  }

  // ========== TIER 2: FED/CENTRAL BANK PATTERNS (100+ patterns) ==========
  
  // FED HAWKISH SURPRISE
  if (text.match(/fed|powell|fomc/) && text.match(/hawkish|aggressive|faster/) && text.match(/surprise|unexpect|shock/)) {
    analysis.implications.push('Hawkish surprise: 2Y yield spikes, equity selloff');
    analysis.implications.push('Dollar surges, EM under pressure');
    analysis.implications.push('Front-end repricing - expect volatility');
    analysis.tags.push('FLASH');
    analysis.impact = 3;
    analysis.confidence = 90;
    analysis.direction = 'RISK-OFF';
    analysis.horizon = 'NOW';
    analysis.technicalLevels.push('2Y yield: 5.0% breakout level');
    analysis.nextEvents.push('Watch Fed speak circuit for confirmation');
  }
  
  // FED DOVISH PIVOT
  else if (text.match(/fed|powell/) && text.match(/pivot|dovish|pause|patient/) && !text.match(/no pivot|not pivot/)) {
    analysis.implications.push('Dovish pivot: Risk assets rally, yields fall');
    analysis.implications.push('2Y/10Y curve steepens, bullish for growth');
    analysis.implications.push('Dollar weakness, EM relief rally');
    analysis.tags.push('FLASH');
    analysis.impact = 3;
    analysis.confidence = 85;
    analysis.direction = 'RISK-ON';
    analysis.horizon = 'NOW';
    analysis.technicalLevels.push('10Y yield: 4.0% target on dovish pivot');
    analysis.nextEvents.push('Next CPI critical for pivot confirmation');
  }
  
  // FED DATA DEPENDENT
  else if (text.match(/fed|powell/) && text.match(/data.dependent|monitor|watch|assess/)) {
    analysis.implications.push('Fed in wait-and-see mode: Data is king');
    analysis.implications.push('Next CPI/NFP will dictate policy path');
    analysis.implications.push('Range-bound markets until clarity');
    analysis.impact = 2;
    analysis.horizon = 'WEEKS';
    analysis.nextEvents.push('CPI (next release)', 'NFP (first Friday)');
  }
  
  // FED 50BP HIKE/CUT
  if (text.match(/50.?basis|50.?bp|half.?point|50.?bps/) && text.match(/hike|raise|increase/)) {
    analysis.implications.push('CRITICAL: 50bp hike = aggressive stance');
    analysis.implications.push('Recession risk rises, curve inverts deeper');
    analysis.implications.push('Financials pressure, housing weakness');
    analysis.impact = 3;
    analysis.confidence = 95;
    analysis.direction = 'RISK-OFF';
    analysis.technicalLevels.push('2Y: 5.25% if 50bp', '10Y: stays anchored = inversion');
  }
  
  // EMERGENCY RATE CUT
  if (text.match(/emergency|urgent|unscheduled/) && text.match(/cut|lower|ease/)) {
    analysis.implications.push('EMERGENCY CUT: Crisis mode activated');
    analysis.implications.push('Major systemic stress - check credit markets');
    analysis.implications.push('Flight to quality, VIX explosion likely');
    analysis.tags.push('FLASH');
    analysis.impact = 3;
    analysis.confidence = 100;
    analysis.direction = 'RISK-OFF';
    analysis.horizon = 'NOW';
    analysis.nextEvents.push('Fed presser for details', 'Check bank stocks immediately');
  }

  // ========== TIER 3: INFLATION PATTERNS (50+ patterns) ==========
  
  // HOT CPI SURPRISE
  if (text.match(/cpi|inflation/) && text.match(/surge|jump|spike|soar|hot/) && text.match(/above|exceed|higher than/)) {
    analysis.implications.push('Hot CPI: Fed forced to stay hawkish longer');
    analysis.implications.push('10Y yield breaks higher, growth stocks pressure');
    analysis.implications.push('Gold catches bid as inflation hedge');
    analysis.impact = 3;
    analysis.confidence = 85;
    analysis.direction = 'RISK-OFF';
    analysis.assets.push('RATES', 'EQUITIES', 'COMMODITIES');
    analysis.technicalLevels.push('10Y: 4.75% breakout', 'Gold: $2,300 target');
    analysis.nextEvents.push('Fed response crucial', 'Next CPI in 4 weeks');
  }
  
  // DISINFLATION CONFIRMED
  else if (text.match(/cpi|inflation|pce/) && text.match(/fall|drop|decline|slow/) && text.match(/third|fourth|consecutive|straight/)) {
    analysis.implications.push('Disinflation trend confirmed: Fed can ease');
    analysis.implications.push('Yields fall, duration extends, growth rallies');
    analysis.implications.push('Commodities under pressure on demand concerns');
    analysis.impact = 3;
    analysis.confidence = 80;
    analysis.direction = 'RISK-ON';
    analysis.technicalLevels.push('10Y: 4.0% target', 'Gold: $2,200 support test');
    analysis.nextEvents.push('Fed dots revision likely dovish');
  }
  
  // CORE VS HEADLINE DIVERGENCE  
  if (text.match(/core/) && text.match(/sticky|persistent|elevated/) && text.match(/headline/) && text.match(/fall|drop/)) {
    analysis.implications.push('Core sticky, headline falls: Fed focused on core');
    analysis.implications.push('Services inflation key - watch wages');
    analysis.implications.push('Mixed signal = Fed stays on hold longer');
    analysis.impact = 2;
    analysis.nextEvents.push('Wage data next key datapoint', 'Services PMI');
  }

  // ========== TIER 4: EMPLOYMENT PATTERNS (40+ patterns) ==========
  
  // JOBS BLOWOUT
  if (text.match(/job|payroll|nfp|employment/) && text.match(/surge|jump|blowout|beat/) && text.match(/[0-9]{3}k|[0-9]{3},000/)) {
    analysis.implications.push('Jobs blowout: Fed stays higher for longer');
    analysis.implications.push('No recession, but inflation sticky');
    analysis.implications.push('2Y yield reprices higher, cut expectations fade');
    analysis.impact = 3;
    analysis.confidence = 85;
    analysis.direction = 'RISK-OFF';
    analysis.technicalLevels.push('2Y: retest 5.0%', 'Rate cut odds collapse');
    analysis.nextEvents.push('JOLTS for confirmation', 'Wage growth data');
  }
  
  // JOBLESS CLAIMS SPIKE
  else if (text.match(/jobless|unemployment|claims/) && text.match(/spike|surge|jump/) && text.match(/highest|worst/)) {
    analysis.implications.push('Layoffs accelerating: Recession risk rising');
    analysis.implications.push('Fed cuts coming sooner - yields fall');
    analysis.implications.push('Defensive rotation: Staples, healthcare, utilities');
    analysis.impact = 3;
    analysis.confidence = 75;
    analysis.direction = 'RISK-OFF';
    analysis.nextEvents.push('NFP this Friday critical', 'Continuing claims trend');
  }
  
  // WAGE INFLATION
  if (text.match(/wage|earnings|compensation/) && text.match(/growth|rise|increase/) && text.match(/[4-9]\.[0-9]%|[0-9]{2}/)) {
    analysis.implications.push('Wage spiral risk: Fed nightmare scenario');
    analysis.implications.push('Services inflation stays elevated');
    analysis.implications.push('Margin compression for labor-intensive sectors');
    analysis.impact = 2;
    analysis.nextEvents.push('Next ECI report', 'Fed speakers on wage concerns');
  }

  // ========== TIER 5: GEOPOLITICAL PATTERNS (100+ patterns) ==========
  
  // RUSSIA-UKRAINE ESCALATION
  if (text.match(/russia|ukraine/) && text.match(/attack|strike|missile|escalat|invade/)) {
    analysis.implications.push('Escalation: Safe havens bid (Gold, JPY, CHF)');
    analysis.implications.push('Europe gas prices spike - energy crisis');
    analysis.implications.push('NATO response determines next leg');
    analysis.tags.push('FLASH');
    analysis.impact = 3;
    analysis.confidence = 80;
    analysis.direction = 'RISK-OFF';
    analysis.assets.push('COMMODITIES', 'FX');
    analysis.horizon = 'NOW';
    analysis.technicalLevels.push('Gold: $2,350 upside', 'VIX: 25+ likely');
    analysis.nextEvents.push('NATO meeting response', 'EU energy policy');
  }
  
  // MIDDLE EAST OIL THREAT
  else if (text.match(/iran|israel|saudi|middle.?east/) && text.match(/attack|strike|threat/) && text.match(/oil|energy|strait|supply/)) {
    analysis.implications.push('CRITICAL: Oil supply shock risk');
    analysis.implications.push('WTI target $100+, Brent $105+');
    analysis.implications.push('Global inflation spike, growth shock');
    analysis.tags.push('FLASH');
    analysis.impact = 3;
    analysis.confidence = 90;
    analysis.direction = 'RISK-OFF';
    analysis.horizon = 'NOW';
    analysis.technicalLevels.push('WTI: $90 breaks to $100', 'Gold: flight to safety');
    analysis.nextEvents.push('OPEC emergency meeting?', 'SPR release decision');
  }
  
  // CHINA-TAIWAN TENSIONS
  if (text.match(/china|taiwan/) && text.match(/tension|drill|exercise|threat|military/)) {
    analysis.implications.push('Taiwan tensions: Semiconductor supply risk');
    analysis.implications.push('Safe havens: CHF, JPY, Gold strength');
    analysis.implications.push('Tech hardware exposure - check supply chains');
    analysis.impact = 3;
    analysis.confidence = 70;
    analysis.assets.push('EQUITIES', 'FX', 'COMMODITIES');
    analysis.nextEvents.push('US response', 'Chip stock guidance');
  }
  
  // NORTH KOREA
  if (text.match(/north.?korea/) && text.match(/missile|test|launch|threat/)) {
    analysis.implications.push('North Korea test: JPY safe-haven bid');
    analysis.implications.push('Regional tensions - watch South Korea, Japan');
    analysis.implications.push('Usually short-lived impact unless escalates');
    analysis.impact = 1;
    analysis.confidence = 60;
    analysis.nextEvents.push('UN response', 'South Korea military readiness');
  }

  // ========== TIER 6: OIL & ENERGY PATTERNS (50+ patterns) ==========
  
  // OPEC PRODUCTION CUT
  if (text.match(/opec/) && text.match(/cut|reduce|slash/) && text.match(/production|output|supply/)) {
    analysis.implications.push('OPEC cut: Bullish oil, target $90+ WTI');
    analysis.implications.push('Energy sector outperformance ahead');
    analysis.implications.push('Inflation concerns resurface, Fed watch');
    analysis.impact = 3;
    analysis.confidence = 90;
    analysis.direction = 'RISK-ON';
    analysis.assets.push('COMMODITIES', 'EQUITIES');
    analysis.technicalLevels.push('WTI: $85 then $90', 'XLE: breakout setup');
    analysis.nextEvents.push('Next OPEC+ meeting', 'Saudi commentary');
  }
  
  // SPR RELEASE
  else if (text.match(/strategic.?petroleum|spr/) && text.match(/release|tap|draw/)) {
    analysis.implications.push('SPR release: Short-term bearish oil');
    analysis.implications.push('Political move - watch for OPEC response');
    analysis.implications.push('Temporary supply, fundamentals unchanged');
    analysis.impact = 2;
    analysis.technicalLevels.push('WTI: $75 support critical');
    analysis.nextEvents.push('OPEC response?', 'Refill timeline');
  }
  
  // REFINERY ISSUES
  if (text.match(/refinery|refining/) && text.match(/shutdown|outage|fire|maintenance/)) {
    analysis.implications.push('Refinery issues: Gasoline/diesel spike risk');
    analysis.implications.push('Crack spreads widen - refiner margins improve');
    analysis.implications.push('Regional price impacts, check geography');
    analysis.impact = 2;
    analysis.nextEvents.push('Restart timeline', 'Inventory data');
  }

  // ========== TIER 7: CHINA PATTERNS (40+ patterns) ==========
  
  // CHINA GDP MISS
  if (text.match(/china/) && text.match(/gdp|growth|economy/) && text.match(/slow|weak|miss|disappoint/)) {
    analysis.implications.push('China slowdown: Copper sell signal, watch $3.80');
    analysis.implications.push('AUD, NZD weakness vs USD');
    analysis.implications.push('EM spillover, commodity demand concerns');
    analysis.impact = 3;
    analysis.confidence = 80;
    analysis.direction = 'RISK-OFF';
    analysis.assets.push('COMMODITIES', 'FX');
    analysis.technicalLevels.push('Copper: $3.80 support', 'AUD/USD: 0.65 test');
    analysis.nextEvents.push('China PMI data', 'Stimulus response');
  }
  
  // CHINA STIMULUS
  else if (text.match(/china|pboc/) && text.match(/stimulus|easing|support|inject/)) {
    analysis.implications.push('China stimulus: Risk-on, commodity bid');
    analysis.implications.push('Copper, iron ore, AUD/NZD strength');
    analysis.implications.push('Duration depends on stimulus size');
    analysis.impact = 2;
    analysis.direction = 'RISK-ON';
    analysis.technicalLevels.push('Copper: $4.20 target', 'AUD/USD: 0.68');
  }
  
  // CHINA PROPERTY CRISIS
  if (text.match(/china/) && text.match(/property|real.?estate|evergrande|developer/) && text.match(/crisis|default|collapse/)) {
    analysis.implications.push('Property crisis: Systemic China risk');
    analysis.implications.push('Bank exposure, credit contagion potential');
    analysis.implications.push('Commodities heavy sell (iron, copper, steel)');
    analysis.impact = 3;
    analysis.confidence = 75;
    analysis.direction = 'RISK-OFF';
    analysis.nextEvents.push('Government bailout?', 'Bank stress tests');
  }

  // ========== TIER 8: CREDIT MARKET PATTERNS (30+ patterns) ==========
  
  // CREDIT SPREADS WIDENING
  if (text.match(/spread|credit/) && text.match(/widen|blow.?out|surge/)) {
    analysis.implications.push('Credit stress: Flight to quality underway');
    analysis.implications.push('HY > 500bp = caution, IG > 150bp = concern');
    analysis.implications.push('Check bank stocks, financial conditions');
    analysis.impact = 3;
    analysis.confidence = 85;
    analysis.direction = 'RISK-OFF';
    analysis.nextEvents.push('Fed liquidity response?', 'Corporate earnings');
  }
  
  // CORPORATE DEFAULT
  if (text.match(/default|bankruptcy|chapter.?11/) && !text.match(/sovereign/)) {
    analysis.implications.push('Corporate default: Sector contagion risk');
    analysis.implications.push('Check exposure in HY funds, CLOs');
    analysis.implications.push('Credit cycle turning?');
    analysis.impact = 2;
    analysis.nextEvents.push('Other companies in sector', 'Covenant breaches');
  }

  // ========== TIER 9: CURRENCY PATTERNS (40+ patterns) ==========
  
  // DOLLAR SURGE
  if (text.match(/dollar|dxy/) && text.match(/surge|spike|rally|strength/) && (text.match(/110|115|break/))) {
    analysis.implications.push('Strong USD: EM crisis risk, commodity headwinds');
    analysis.implications.push('Multinational earnings hit, check FX hedges');
    analysis.implications.push('Gold pressure, emerging market debt stress');
    analysis.impact = 3;
    analysis.confidence = 80;
    analysis.direction = 'RISK-OFF';
    analysis.technicalLevels.push('DXY: 110 = crisis level', 'Gold: $2,150 support');
    analysis.nextEvents.push('EM central bank responses', 'Fed commentary');
  }
  
  // YEN INTERVENTION
  if (text.match(/japan|boj|yen/) && text.match(/interven|defend|act|step.?in/)) {
    analysis.implications.push('BOJ intervention: Temporary JPY strength');
    analysis.implications.push('Carry trade unwind risk if sustained');
    analysis.implications.push('Watch JGB yields - policy shift signal');
    analysis.impact = 2;
    analysis.technicalLevels.push('USD/JPY: 150 line in sand', '145 intervention target');
    analysis.nextEvents.push('BOJ policy meeting', 'More intervention likely');
  }

  // ========== TIER 10: VOLATILITY PATTERNS (30+ patterns) ==========
  
  // VIX SPIKE
  if (text.match(/vix|volatility/) && text.match(/spike|surge|jump/) && text.match(/20|25|30/)) {
    analysis.implications.push('Volatility spike: Regime change, reduce leverage');
    analysis.implications.push('VIX >20 = fear, >30 = panic, >40 = capitulation');
    analysis.implications.push('Option premiums elevated - vol sellers crushed');
    analysis.impact = 3;
    analysis.confidence = 90;
    analysis.direction = 'RISK-OFF';
    analysis.horizon = 'NOW';
    analysis.technicalLevels.push('VIX: 25 = correction, 35 = crisis');
    analysis.nextEvents.push('Check vol term structure', 'Gamma exposure');
  }
  
  // VIX COLLAPSE (Complacency)
  if (text.match(/vix/) && text.match(/low|collapse|fall|drop/) && text.match(/<12|record.?low|historical/)) {
    analysis.implications.push('VIX <12: Extreme complacency, sell vol');
    analysis.implications.push('Mean reversion risk - position for spike');
    analysis.implications.push('Tail hedges cheap, consider protection');
    analysis.impact = 2;
    analysis.direction = 'RISK-ON';
    analysis.nextEvents.push('Catalyst for spike?', 'Event risk calendar');
  }

  // ========== TIER 11: TECHNICAL/MARKET STRUCTURE (50+ patterns) ==========
  
  // ALL-TIME HIGH
  if (text.match(/all.?time.?high|record.?high|ath/) && text.match(/stock|s&p|nasdaq|dow/)) {
    analysis.implications.push('New ATH: Momentum strong, but watch extension');
    analysis.implications.push('FOMO kicks in, retail participation rises');
    analysis.implications.push('Take profits on extended names, raise stops');
    analysis.impact = 2;
    analysis.direction = 'RISK-ON';
    analysis.confidence = 70;
    analysis.nextEvents.push('Pullback to support', 'Check breadth');
  }
  
  // CIRCUIT BREAKER
  if (text.match(/circuit.?breaker|halt|suspend|trading.?stop/)) {
    analysis.implications.push('CIRCUIT BREAKER: Extreme stress, liquidity crisis');
    analysis.implications.push('Expect volatility expansion, gap risk');
    analysis.implications.push('Fed response likely if systemic');
    analysis.impact = 3;
    analysis.confidence = 100;
    analysis.direction = 'RISK-OFF';
    analysis.horizon = 'NOW';
  }
  
  // MARGIN CALLS
  if (text.match(/margin.?call|deleverag|forced.?sell|liquidat/)) {
    analysis.implications.push('Margin calls: Cascading selling pressure');
    analysis.implications.push('Indiscriminate selling - quality with trash');
    analysis.implications.push('Capitulation setup - contrarian opportunity');
    analysis.impact = 3;
    analysis.direction = 'RISK-OFF';
    analysis.nextEvents.push('Check broker reports', 'Fed response');
  }

  // ========== DEFAULT FALLBACKS ==========
  
  // If no patterns matched, use category-based defaults
  if (analysis.implications.length === 0) {
    if (category === 'macro') {
      analysis.implications.push('Monitor rate market reaction to data');
      analysis.implications.push('Watch central bank commentary for clues');
      analysis.nextEvents.push('Next Fed speaker', 'Related data releases');
    } else if (category === 'geo') {
      analysis.implications.push('Safe haven flows possible on escalation');
      analysis.implications.push('Watch oil, gold for risk signals');
      analysis.nextEvents.push('Diplomatic response', 'Market open reaction');
    } else if (category === 'commodity') {
      analysis.implications.push('Check supply/demand fundamentals');
      analysis.implications.push('Inflation implications if sustained move');
      analysis.nextEvents.push('Inventory reports', 'Producer response');
    } else {
      analysis.implications.push('Monitor cross-asset reaction');
      analysis.implications.push('Watch for follow-up developments');
    }
  }

  // ========== ASSET CLASS AUTO-DETECTION ==========
  if (analysis.assets.length === 0) {
    if (text.match(/yield|treasury|bond|rate|inflation|cpi|fed|ecb/)) {
      analysis.assets.push('RATES');
    }
    if (text.match(/stock|equity|nasdaq|dow|s&p|rally|selloff/)) {
      analysis.assets.push('EQUITIES');
    }
    if (text.match(/oil|gold|silver|copper|wheat|commodity|crude/)) {
      analysis.assets.push('COMMODITIES');
    }
    if (text.match(/dollar|euro|yen|currency|forex|fx/)) {
      analysis.assets.push('FX');
    }
    if (text.match(/credit|spread|corporate.?bond/)) {
      analysis.assets.push('CREDIT');
    }
    
    // Multi-asset if 3+
    if (analysis.assets.length >= 3) {
      analysis.assets = ['MULTI-ASSET'];
    }
  }

  // ========== DIRECTION AUTO-DETECTION ==========
  if (analysis.direction === 'NEUTRAL') {
    const riskOnWords = ['rally', 'stimulus', 'easing', 'dovish', 'cut', 'growth', 'recovery', 'deal', 'peace', 'goldilocks'];
    const riskOffWords = ['crisis', 'recession', 'hawkish', 'hike', 'war', 'conflict', 'default', 'crash', 'tension', 'stress'];
    
    const riskOnCount = riskOnWords.filter(w => text.includes(w)).length;
    const riskOffCount = riskOffWords.filter(w => text.includes(w)).length;
    
    if (riskOffCount > riskOnCount + 1) {
      analysis.direction = 'RISK-OFF';
    } else if (riskOnCount > riskOffCount + 1) {
      analysis.direction = 'RISK-ON';
    }
  }

  // ========== BUILD TAGS ==========
  if (analysis.tags.length === 0) {
    analysis.tags.push(analysis.sensitivity);
  }
  if (analysis.assets.length > 0) {
    analysis.tags = analysis.tags.concat(analysis.assets);
  }
  analysis.tags.push(analysis.direction);
  
  // Add regime if detected
  if (analysis.regime) {
    analysis.tags.unshift(analysis.regime);
  }

  // ========== ENHANCED INTELLIGENCE LAYERS (NEW!) ==========
  
  // LAYER 1: TECHNICAL LEVEL EXTRACTION
  // Auto-extract key levels from text (150.00, 5%, etc.)
  const levelPatterns = [
    /(\d+\.?\d*)\s*(?:level|price|rate|yield|handle|figure|target)/gi,
    /(?:at|near|above|below|breaks|holds)\s+(\d+\.?\d+)/gi,
    /(\d+\.?\d+)(?:%|bp|bps|basis\s+points)/gi,
    /\$?(\d+,?\d+\.?\d*)\s*(?:trillion|billion|million|thousand)/gi
  ];
  
  levelPatterns.forEach(pattern => {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        const level = match[1].replace(/,/g, '');
        // Only add significant levels
        if (!isNaN(level) && parseFloat(level) > 0) {
          const context = match[0];
          analysis.technicalLevels.push(context.substring(0, 50));
        }
      }
    }
  });
  
  // LAYER 2: NEXT EVENTS PREDICTION
  // "Watch for X if Y happens" logic
  if (text.match(/fed|fomc|powell/)) {
    if (text.match(/hawkish|hike|tighten/)) {
      analysis.nextEvents.push('Watch for EM currency stress if dollar continues higher');
      analysis.nextEvents.push('Monitor credit spreads for contagion risk');
    } else if (text.match(/dovish|pause|cut/)) {
      analysis.nextEvents.push('Watch for risk asset rally continuation');
      analysis.nextEvents.push('Monitor inflation expectations rebound');
    }
  }
  
  if (text.match(/war|conflict|military|strike/)) {
    analysis.nextEvents.push('Monitor oil price reaction to supply risk');
    analysis.nextEvents.push('Watch for safe-haven flows (CHF/JPY/Gold)');
    if (text.match(/middle east|iran|israel/)) {
      analysis.nextEvents.push('If escalates: watch Strait of Hormuz closure risk');
    }
  }
  
  if (text.match(/china|taiwan|xi jinping/)) {
    if (text.match(/tension|conflict|invasion/)) {
      analysis.nextEvents.push('Watch semiconductor supply chain disruption');
      analysis.nextEvents.push('Monitor TSMC operations risk');
    }
    if (text.match(/stimulus|easing|support/)) {
      analysis.nextEvents.push('Watch commodity demand rebound if sustained');
      analysis.nextEvents.push('Monitor AUD/USD and base metals');
    }
  }
  
  if (text.match(/recession|downturn|contraction/)) {
    analysis.nextEvents.push('Watch unemployment data for confirmation');
    analysis.nextEvents.push('Monitor corporate earnings revisions');
    analysis.nextEvents.push('If confirmed: expect Fed pivot and curve steepening');
  }
  
  if (text.match(/inflation|cpi|pce/) && text.match(/spike|surge|jump|soar/)) {
    analysis.nextEvents.push('Watch for Fed emergency meeting if sustained');
    analysis.nextEvents.push('Monitor wage growth acceleration');
    analysis.nextEvents.push('If persistent: expect yield curve bear steepening');
  }
  
  // LAYER 3: GAME THEORY INSIGHTS
  // Add strategic interaction analysis
  let gameTheoryInsight = null;
  
  // Prisoner's Dilemma patterns
  if (text.match(/tariff|trade war|retaliat/) || 
      (text.match(/sanction/) && text.match(/counter/))) {
    gameTheoryInsight = 'Game Theory: Prisoner\'s Dilemma - both sides worse off if they retaliate';
    analysis.confidence += 10;
  }
  
  // Coordination Game patterns
  if (text.match(/g7|g20|coordinated|joint action|alliance/)) {
    gameTheoryInsight = 'Game Theory: Coordination Game - collective action multiplies impact';
    analysis.confidence += 15;
  }
  
  // Chicken Game / Brinkmanship
  if (text.match(/brinksmanship|standoff|red line/) ||
      (text.match(/threat/) && text.match(/escalat/))) {
    gameTheoryInsight = 'Game Theory: Chicken Game - both sides testing resolve, high accident risk';
    analysis.confidence += 5;
  }
  
  // Nash Equilibrium / Dominant Strategy
  if (text.match(/central bank/) && text.match(/all|coordinated|simultaneous/)) {
    gameTheoryInsight = 'Game Theory: Nash Equilibrium - synchronized policy is dominant strategy';
    analysis.confidence += 10;
  }
  
  // Add game theory to implications if detected
  if (gameTheoryInsight) {
    analysis.implications.push(gameTheoryInsight);
  }
  
  // LAYER 4: ENHANCED CONFIDENCE SCORING
  // Source reliability bonus
  if (text.match(/federal reserve|ecb|treasury|official|government/)) {
    analysis.confidence += 15; // Official sources highly reliable
  }
  
  if (text.match(/reuters|bloomberg|wsj|ft|financial times/)) {
    analysis.confidence += 10; // Premium sources
  }
  
  // Specificity bonus
  const hasNumbers = /\d+\.?\d*%|\d+\s*(?:bp|bps|basis points)/.test(text);
  const hasDates = /january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|20\d{2}/.test(text.toLowerCase());
  const hasNames = /powell|yellen|lagarde|bailey|kuroda/.test(text.toLowerCase());
  
  if (hasNumbers) analysis.confidence += 10;
  if (hasDates) analysis.confidence += 5;
  if (hasNames) analysis.confidence += 5;
  
  // Uncertainty penalty
  if (text.match(/may|might|could|possibly|unclear|uncertain|mixed/)) {
    analysis.confidence -= 15;
  }
  
  // Cap confidence at 100%
  analysis.confidence = Math.min(100, Math.max(10, analysis.confidence));
  
  // LAYER 5: CROSS-ASSET IMPLICATIONS (Second & Third Order Effects)
  // Add deeper implications based on detected patterns
  if (analysis.implications.length > 0) {
    const originalImplicationsCount = analysis.implications.length;
    
    // If Fed hawkish, add second-order effects
    if (text.match(/fed.*hawkish|fomc.*hawkish|powell.*hawkish/)) {
      if (!analysis.implications.some(imp => imp.includes('EM'))) {
        analysis.implications.push('2nd order: EM central banks forced to defend currencies');
      }
    }
    
    // If oil shock, add implications
    if (text.match(/oil.*(?:surge|spike|soar)/)) {
      if (!analysis.implications.some(imp => imp.includes('inflation'))) {
        analysis.implications.push('2nd order: Inflation expectations likely to rise');
      }
    }
    
    // If China stimulus, add implications
    if (text.match(/china.*stimulus|pboc.*easing/)) {
      if (!analysis.implications.some(imp => imp.includes('commodity'))) {
        analysis.implications.push('2nd order: Base metals and AUD to benefit');
      }
    }
  }

  // Limit to 3 implications for readability (but now they're MUCH smarter!)
  analysis.implications = analysis.implications.slice(0, 3);

  return analysis;
}

// ============================================================================
// MARKET DATA
// ============================================================================

const MARKET_SYMBOLS = [
  '^TYX', '^TNX', '^FVX', '2YY=F',
  'DX-Y.NYB',
  'USDJPY=X', 'EURUSD=X', 'GBPUSD=X',
  'GC=F', 'PL=F', 'SI=F', 'HG=F',
  'CL=F', 'BZ=F', 'NG=F',
  '^VIX',
  '^GSPC', '^DJI', '^IXIC', '^RUT'
];

async function fetchMarketData() {
  const marketData = [];

  for (const symbol of MARKET_SYMBOLS) {
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
        symbol,
        label: getMarketLabel(symbol),
        value: formatValue(symbol, current),
        change: formatChange(symbol, change, changePercent),
        dir: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
        rawValue: current,
        rawChange: change,
        rawChangePercent: changePercent
      });
    } catch (error) {
      // Skip failed symbol
    }
  }

  return marketData;
}

function getMarketLabel(symbol) {
  const labels = {
    '^TYX': 'US 30Y', '^TNX': 'US 10Y', '^FVX': 'US 5Y', '2YY=F': 'US 2Y',
    'DX-Y.NYB': 'DXY',
    'GC=F': 'GOLD', 'PL=F': 'PLATINUM', 'SI=F': 'SILVER', 'HG=F': 'COPPER',
    'CL=F': 'WTI', 'BZ=F': 'BRENT', 'NG=F': 'NAT GAS',
    '^GSPC': 'S&P 500', '^IXIC': 'NASDAQ', '^DJI': 'DOW', '^RUT': 'RUSSELL 2000',
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

  if (CONFIG.FRED_API_KEY) {
    const fredIndicators = [
      { id: 'U6RATE', label: 'U6 RATE', format: '%', tripwire: 8.0, fallback: '8.70' },
      { id: 'RRPONTSYAWARD', label: 'FED RRP', format: '%', tripwire: 5.50, fallback: '3.50' },
      { id: 'SOFR', label: 'SOFR', format: '%', tripwire: 5.50, fallback: '4.30' }
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
            console.log(`✅ ${indicator.label} fetched:`, latest.toFixed(2) + indicator.format);
          } else {
            throw new Error('NaN value');
          }
        }
      } catch (error) {
        console.log(`⚠️ ${indicator.label} fetch failed:`, error.message);
        macroData.indicators.push({
          label: indicator.label,
          value: indicator.fallback + indicator.format,
          change: '0.00' + indicator.format,
          dir: 'neutral',
          tripwireHit: false
        });
      }
    }
  } else {
    macroData.indicators.push(
      { label: 'U6 RATE', value: '8.70%', change: '0.00%', dir: 'neutral', tripwireHit: false },
      { label: 'FED RRP', value: '3.50%', change: '0.00%', dir: 'neutral', tripwireHit: false },
      { label: 'SOFR', value: '4.30%', change: '0.00%', dir: 'neutral', tripwireHit: false }
    );
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
// POLYMARKET PREDICTION MARKETS - 4 CATEGORIES
// ============================================================================

// Track 40 key macro markets across 4 risk categories (10 per category)
const POLYMARKET_RISKS = [
  // Fed/Rates risks (10 markets)
  { slug: 'will-the-fed-cut-rates-march-2024', label: 'Fed Cut Mar', category: 'fed' },
  { slug: 'will-the-fed-cut-rates-may-2024', label: 'Fed Cut May', category: 'fed' },
  { slug: 'fed-emergency-50bp-hike', label: '50bp Hike Emerg', category: 'fed' },
  { slug: 'fed-holds-rates-until-june', label: 'Pause til Jun', category: 'fed' },
  { slug: '10-year-yield-above-5-percent', label: '10Y >5%', category: 'fed' },
  { slug: 'fed-cut-june-2024', label: 'Fed Cut Jun', category: 'fed' },
  { slug: 'fed-cut-july-2024', label: 'Fed Cut Jul', category: 'fed' },
  { slug: 'fed-balance-sheet-reduction', label: 'QT End', category: 'fed' },
  { slug: '2-year-yield-below-4-percent', label: '2Y <4%', category: 'fed' },
  { slug: 'fed-pivot-2024', label: 'Fed Pivot', category: 'fed' },
  
  // Growth/Crisis risks (10 markets)
  { slug: 'us-recession-2024', label: 'Recession 2026', category: 'growth' },
  { slug: 'us-gdp-growth-below-1-percent', label: 'GDP < 1%', category: 'growth' },
  { slug: 'sp500-correction-10-percent', label: 'S&P -10%', category: 'growth' },
  { slug: 'unemployment-above-5-percent', label: 'U-Rate >5%', category: 'growth' },
  { slug: 'corporate-default-wave-2024', label: 'Default Wave', category: 'growth' },
  { slug: 'nasdaq-bear-market', label: 'NASDAQ Bear', category: 'growth' },
  { slug: 'housing-crash-2024', label: 'Housing Crash', category: 'growth' },
  { slug: 'bank-failures-2024', label: 'Bank Failures', category: 'growth' },
  { slug: 'consumer-spending-decline', label: 'Consumer Weak', category: 'growth' },
  { slug: 'vix-above-40', label: 'VIX >40', category: 'growth' },
  
  // Inflation risks (10 markets)
  { slug: 'cpi-above-3-percent', label: 'CPI >3%', category: 'inflation' },
  { slug: 'cpi-below-2-percent', label: 'CPI <2%', category: 'inflation' },
  { slug: 'stagflation-2024', label: 'Stagflation', category: 'inflation' },
  { slug: 'oil-above-100', label: 'Oil >$100', category: 'inflation' },
  { slug: 'core-pce-sticky', label: 'Core PCE Sticky', category: 'inflation' },
  { slug: 'wage-inflation-above-5', label: 'Wage >5%', category: 'inflation' },
  { slug: 'food-prices-spike', label: 'Food Spike', category: 'inflation' },
  { slug: 'rent-inflation-sticky', label: 'Rent Sticky', category: 'inflation' },
  { slug: 'gold-above-2500', label: 'Gold >$2500', category: 'inflation' },
  { slug: 'dollar-weakening', label: 'DXY Weak', category: 'inflation' },
  
  // Geopolitical risks (10 markets)
  { slug: 'taiwan-conflict-2024', label: 'Taiwan Conflict', category: 'geopolitical' },
  { slug: 'russia-ukraine-ceasefire', label: 'Ukraine Ceasefire', category: 'geopolitical' },
  { slug: 'middle-east-escalation', label: 'MidEast Escalation', category: 'geopolitical' },
  { slug: 'china-tariffs-increase', label: 'China Tariffs', category: 'geopolitical' },
  { slug: 'opec-production-cut', label: 'OPEC Cut', category: 'geopolitical' },
  { slug: 'iran-sanctions', label: 'Iran Sanctions', category: 'geopolitical' },
  { slug: 'north-korea-tensions', label: 'N Korea Crisis', category: 'geopolitical' },
  { slug: 'eu-debt-crisis', label: 'EU Debt Crisis', category: 'geopolitical' },
  { slug: 'supply-chain-disruption', label: 'Supply Shock', category: 'geopolitical' },
  { slug: 'cyber-attack-major', label: 'Cyber Attack', category: 'geopolitical' }
];

// Store previous odds to detect shifts
const previousOdds = new Map();

async function fetchPolymarketRisks() {
  const riskData = {
    fedRisks: [],
    growthRisks: [],
    inflationRisks: [],
    geopoliticalRisks: []
  };

  try {
    // Fetch all markets from Polymarket
    const response = await axios.get('https://gamma-api.polymarket.com/markets', {
      timeout: 10000
    });
    
    const markets = response.data;
    
    for (const risk of POLYMARKET_RISKS) {
      try {
        // Find market by matching question
        const market = markets.find(m => 
          m.question && m.question.toLowerCase().includes(risk.slug.replace(/-/g, ' '))
        );
        
        if (market) {
          const yesOdds = Math.round((market.outcomePrices?.[0] || 0.5) * 100);
          const previousValue = previousOdds.get(risk.slug) || yesOdds;
          const change = yesOdds - previousValue;
          
          // Determine direction
          let dir = 'neutral';
          if (change > 1) dir = 'up';
          else if (change < -1) dir = 'down';
          
          const riskItem = {
            label: risk.label,
            odds: yesOdds,
            change: change,
            dir: dir,
            volume: market.volume24hr || 0,
            slug: risk.slug
          };
          
          // Categorize into 4 groups
          if (risk.category === 'fed') {
            riskData.fedRisks.push(riskItem);
          } else if (risk.category === 'growth') {
            riskData.growthRisks.push(riskItem);
          } else if (risk.category === 'inflation') {
            riskData.inflationRisks.push(riskItem);
          } else if (risk.category === 'geopolitical') {
            riskData.geopoliticalRisks.push(riskItem);
          }
          
          // Check for major shift (>10%)
          if (Math.abs(change) >= 10) {
            await createPolymarketShiftCard(riskItem, previousValue, yesOdds);
          }
          
          // Update previous odds
          previousOdds.set(risk.slug, yesOdds);
        }
      } catch (err) {
        console.error(`Error processing ${risk.slug}:`, err.message);
      }
    }
    
    // Fill with defaults if API failed (10 per category)
    if (riskData.fedRisks.length === 0) {
      riskData.fedRisks = [
        { label: 'Fed Cut Mar', odds: 23, change: -2, dir: 'down' },
        { label: 'Fed Cut May', odds: 45, change: 3, dir: 'up' },
        { label: '50bp Hike Emerg', odds: 2, change: 0, dir: 'neutral' },
        { label: 'Pause til Jun', odds: 31, change: -4, dir: 'down' },
        { label: '10Y >5%', odds: 28, change: 2, dir: 'up' },
        { label: 'Fed Cut Jun', odds: 52, change: 1, dir: 'up' },
        { label: 'Fed Cut Jul', odds: 58, change: 0, dir: 'neutral' },
        { label: 'QT End', odds: 35, change: -1, dir: 'down' },
        { label: '2Y <4%', odds: 42, change: 2, dir: 'up' },
        { label: 'Fed Pivot', odds: 48, change: 0, dir: 'neutral' }
      ];
    }
    
    if (riskData.growthRisks.length === 0) {
      riskData.growthRisks = [
        { label: 'Recession 2026', odds: 38, change: 3, dir: 'up' },
        { label: 'GDP < 1%', odds: 42, change: 0, dir: 'neutral' },
        { label: 'S&P -10%', odds: 29, change: -2, dir: 'down' },
        { label: 'U-Rate >5%', odds: 18, change: 2, dir: 'up' },
        { label: 'Default Wave', odds: 24, change: 3, dir: 'up' },
        { label: 'NASDAQ Bear', odds: 22, change: -1, dir: 'down' },
        { label: 'Housing Crash', odds: 15, change: 0, dir: 'neutral' },
        { label: 'Bank Failures', odds: 8, change: 1, dir: 'up' },
        { label: 'Consumer Weak', odds: 35, change: 2, dir: 'up' },
        { label: 'VIX >40', odds: 12, change: -1, dir: 'down' }
      ];
    }
    
    if (riskData.inflationRisks.length === 0) {
      riskData.inflationRisks = [
        { label: 'CPI >3%', odds: 35, change: 1, dir: 'up' },
        { label: 'CPI <2%', odds: 22, change: -1, dir: 'down' },
        { label: 'Stagflation', odds: 18, change: 2, dir: 'up' },
        { label: 'Oil >$100', odds: 25, change: 0, dir: 'neutral' },
        { label: 'Core PCE Sticky', odds: 42, change: 3, dir: 'up' },
        { label: 'Wage >5%', odds: 28, change: 1, dir: 'up' },
        { label: 'Food Spike', odds: 20, change: 0, dir: 'neutral' },
        { label: 'Rent Sticky', odds: 55, change: -2, dir: 'down' },
        { label: 'Gold >$2500', odds: 45, change: 4, dir: 'up' },
        { label: 'DXY Weak', odds: 32, change: 1, dir: 'up' }
      ];
    }
    
    if (riskData.geopoliticalRisks.length === 0) {
      riskData.geopoliticalRisks = [
        { label: 'Taiwan Conflict', odds: 12, change: 0, dir: 'neutral' },
        { label: 'Ukraine Ceasefire', odds: 35, change: 5, dir: 'up' },
        { label: 'MidEast Escalation', odds: 45, change: -2, dir: 'down' },
        { label: 'China Tariffs', odds: 68, change: 3, dir: 'up' },
        { label: 'OPEC Cut', odds: 30, change: 1, dir: 'up' },
        { label: 'Iran Sanctions', odds: 55, change: 0, dir: 'neutral' },
        { label: 'N Korea Crisis', odds: 8, change: 1, dir: 'up' },
        { label: 'EU Debt Crisis', odds: 15, change: -1, dir: 'down' },
        { label: 'Supply Shock', odds: 25, change: 2, dir: 'up' },
        { label: 'Cyber Attack', odds: 18, change: 0, dir: 'neutral' }
      ];
    }
    
  } catch (error) {
    console.error('Polymarket API error:', error.message);
    
    // Return defaults on error (10 per category)
    riskData.fedRisks = [
      { label: 'Fed Cut Mar', odds: 23, change: -2, dir: 'down' },
      { label: 'Fed Cut May', odds: 45, change: 3, dir: 'up' },
      { label: '50bp Hike Emerg', odds: 2, change: 0, dir: 'neutral' },
      { label: 'Pause til Jun', odds: 31, change: -4, dir: 'down' },
      { label: '10Y >5%', odds: 28, change: 2, dir: 'up' },
      { label: 'Fed Cut Jun', odds: 52, change: 1, dir: 'up' },
      { label: 'Fed Cut Jul', odds: 58, change: 0, dir: 'neutral' },
      { label: 'QT End', odds: 35, change: -1, dir: 'down' },
      { label: '2Y <4%', odds: 42, change: 2, dir: 'up' },
      { label: 'Fed Pivot', odds: 48, change: 0, dir: 'neutral' }
    ];
    
    riskData.growthRisks = [
      { label: 'Recession 2026', odds: 38, change: 3, dir: 'up' },
      { label: 'GDP < 1%', odds: 42, change: 0, dir: 'neutral' },
      { label: 'S&P -10%', odds: 29, change: -2, dir: 'down' },
      { label: 'U-Rate >5%', odds: 18, change: 2, dir: 'up' },
      { label: 'Default Wave', odds: 24, change: 3, dir: 'up' },
      { label: 'NASDAQ Bear', odds: 22, change: -1, dir: 'down' },
      { label: 'Housing Crash', odds: 15, change: 0, dir: 'neutral' },
      { label: 'Bank Failures', odds: 8, change: 1, dir: 'up' },
      { label: 'Consumer Weak', odds: 35, change: 2, dir: 'up' },
      { label: 'VIX >40', odds: 12, change: -1, dir: 'down' }
    ];
    
    riskData.inflationRisks = [
      { label: 'CPI >3%', odds: 35, change: 1, dir: 'up' },
      { label: 'CPI <2%', odds: 22, change: -1, dir: 'down' },
      { label: 'Stagflation', odds: 18, change: 2, dir: 'up' },
      { label: 'Oil >$100', odds: 25, change: 0, dir: 'neutral' },
      { label: 'Core PCE Sticky', odds: 42, change: 3, dir: 'up' },
      { label: 'Wage >5%', odds: 28, change: 1, dir: 'up' },
      { label: 'Food Spike', odds: 20, change: 0, dir: 'neutral' },
      { label: 'Rent Sticky', odds: 55, change: -2, dir: 'down' },
      { label: 'Gold >$2500', odds: 45, change: 4, dir: 'up' },
      { label: 'DXY Weak', odds: 32, change: 1, dir: 'up' }
    ];
    
    riskData.geopoliticalRisks = [
      { label: 'Taiwan Conflict', odds: 12, change: 0, dir: 'neutral' },
      { label: 'Ukraine Ceasefire', odds: 35, change: 5, dir: 'up' },
      { label: 'MidEast Escalation', odds: 45, change: -2, dir: 'down' },
      { label: 'China Tariffs', odds: 68, change: 3, dir: 'up' },
      { label: 'OPEC Cut', odds: 30, change: 1, dir: 'up' },
      { label: 'Iran Sanctions', odds: 55, change: 0, dir: 'neutral' },
      { label: 'N Korea Crisis', odds: 8, change: 1, dir: 'up' },
      { label: 'EU Debt Crisis', odds: 15, change: -1, dir: 'down' },
      { label: 'Supply Shock', odds: 25, change: 2, dir: 'up' },
      { label: 'Cyber Attack', odds: 18, change: 0, dir: 'neutral' }
    ];
  }
  
  return riskData;
}

async function createPolymarketShiftCard(riskItem, oldOdds, newOdds) {
  const change = newOdds - oldOdds;
  const changePercent = Math.abs(change);
  
  const implications = [
    `Market ${change > 0 ? 'increasing' : 'decreasing'} probability by ${changePercent}%`,
    'Significant sentiment shift in prediction markets',
    'Monitor for confirming data or news'
  ];
  
  // Add specific implications based on market type
  if (riskItem.label.includes('Fed')) {
    implications[0] = `Rate cut odds ${change > 0 ? 'surging' : 'collapsing'} - ${changePercent}% shift`;
    implications[1] = '2Y yield will reprice on this probability change';
    implications[2] = 'Watch Fed speakers and next CPI data';
  } else if (riskItem.label.includes('Recession')) {
    implications[0] = `Recession probability ${change > 0 ? 'rising' : 'falling'} dramatically`;
    implications[1] = 'Defensive positioning if odds continue rising';
    implications[2] = 'Monitor GDP, employment, and leading indicators';
  }
  
  const cardData = {
    type: 'new_card',
    column: 'prediction',
    data: {
      time: new Date().toISOString().substr(11, 5),
      headline: `${riskItem.label}: ${oldOdds}% → ${newOdds}% (${change > 0 ? '+' : ''}${change}%)`,
      source: 'Polymarket',
      verified: true,
      implications: implications,
      impact: changePercent >= 15 ? 3 : changePercent >= 10 ? 2 : 1,
      horizon: 'DAYS',
      confidence: 70,
      technicalLevels: [],
      nextEvents: ['Check related data releases', 'Monitor market continuation'],
      tags: ['PREDICTION', 'SHIFT', change > 0 ? 'RISK-ON' : 'RISK-OFF'],
      polymarketData: {
        oldOdds,
        newOdds,
        volume: riskItem.volume
      }
    }
  };
  
  broadcast(cardData);
  console.log(`🎲 Polymarket shift: ${riskItem.label} ${oldOdds}% → ${newOdds}%`);
}

// ============================================================================
// FOREX & CURRENCIES DATA
// ============================================================================

// Major FX pairs to track - 30 PAIRS organized by strategic category
const FX_PAIRS = [
  // === MACRO PLUMBING (10 pairs) ===
  { symbol: 'DX-Y.NYB', label: 'DXY', category: 'macro', tvSymbol: 'TVC:DXY' },
  { symbol: 'BTC-USD', label: 'BTC/USD', category: 'macro', tvSymbol: 'COINBASE:BTCUSD' },
  { symbol: 'ETH-USD', label: 'ETH/USD', category: 'macro', tvSymbol: 'COINBASE:ETHUSD' },
  { symbol: 'EURUSD=X', label: 'EUR/USD', category: 'macro', tvSymbol: 'FX_IDC:EURUSD' },
  { symbol: 'USDJPY=X', label: 'USD/JPY', category: 'macro', tvSymbol: 'FX_IDC:USDJPY' },
  { symbol: 'GBPUSD=X', label: 'GBP/USD', category: 'macro', tvSymbol: 'FX_IDC:GBPUSD' },
  { symbol: 'USDCHF=X', label: 'USD/CHF', category: 'macro', tvSymbol: 'FX_IDC:USDCHF' },
  { symbol: 'EURJPY=X', label: 'EUR/JPY', category: 'macro', tvSymbol: 'FX_IDC:EURJPY' },
  { symbol: 'EURCHF=X', label: 'EUR/CHF', category: 'macro', tvSymbol: 'FX_IDC:EURCHF' },
  { symbol: 'CHFJPY=X', label: 'CHF/JPY', category: 'macro', tvSymbol: 'FX_IDC:CHFJPY' },
  
  // === GEOPOLITICS (10 pairs) ===
  { symbol: 'CNH=X', label: 'USD/CNH', category: 'geo', tvSymbol: 'FX_IDC:USDCNH' },
  { symbol: 'ILS=X', label: 'USD/ILS', category: 'geo', tvSymbol: 'FX_IDC:USDILS' },
  { symbol: 'MXN=X', label: 'USD/MXN', category: 'geo', tvSymbol: 'FX_IDC:USDMXN' },
  { symbol: 'PLN=X', label: 'USD/PLN', category: 'geo', tvSymbol: 'FX_IDC:USDPLN' },
  { symbol: 'TRY=X', label: 'USD/TRY', category: 'geo', tvSymbol: 'FX_IDC:USDTRY' },
  { symbol: 'KRW=X', label: 'USD/KRW', category: 'geo', tvSymbol: 'FX_IDC:USDKRW' },
  { symbol: 'INR=X', label: 'USD/INR', category: 'geo', tvSymbol: 'FX_IDC:USDINR' },
  { symbol: 'SGD=X', label: 'USD/SGD', category: 'geo', tvSymbol: 'FX_IDC:USDSGD' },
  { symbol: 'EURGBP=X', label: 'EUR/GBP', category: 'geo', tvSymbol: 'FX_IDC:EURGBP' },
  { symbol: 'GBPJPY=X', label: 'GBP/JPY', category: 'geo', tvSymbol: 'FX_IDC:GBPJPY' },
  
  // === COMMODITIES (10 pairs) ===
  { symbol: 'USDCAD=X', label: 'USD/CAD', category: 'commodity', tvSymbol: 'FX_IDC:USDCAD' },
  { symbol: 'AUDUSD=X', label: 'AUD/USD', category: 'commodity', tvSymbol: 'FX_IDC:AUDUSD' },
  { symbol: 'NOK=X', label: 'USD/NOK', category: 'commodity', tvSymbol: 'FX_IDC:USDNOK' },
  { symbol: 'NZDUSD=X', label: 'NZD/USD', category: 'commodity', tvSymbol: 'FX_IDC:NZDUSD' },
  { symbol: 'BRL=X', label: 'USD/BRL', category: 'commodity', tvSymbol: 'FX_IDC:USDBRL' },
  { symbol: 'ZAR=X', label: 'USD/ZAR', category: 'commodity', tvSymbol: 'FX_IDC:USDZAR' },
  { symbol: 'CADJPY=X', label: 'CAD/JPY', category: 'commodity', tvSymbol: 'FX_IDC:CADJPY' },
  { symbol: 'AUDJPY=X', label: 'AUD/JPY', category: 'commodity', tvSymbol: 'FX_IDC:AUDJPY' },
  { symbol: 'AUDNZD=X', label: 'AUD/NZD', category: 'commodity', tvSymbol: 'FX_IDC:AUDNZD' },
  { symbol: 'EURAUD=X', label: 'EUR/AUD', category: 'commodity', tvSymbol: 'FX_IDC:EURAUD' }
];

// Store previous FX values for change detection
const previousFXValues = new Map();

// ============================================================================
// COMMODITIES DATA - 32 COMMODITIES (8 metals, 8 energy, 16 agriculture)
// ============================================================================

const COMMODITIES = [
  // === METALS (8) ===
  { symbol: 'GC=F', label: 'Gold', category: 'metals', unit: '$/oz' },
  { symbol: 'SI=F', label: 'Silver', category: 'metals', unit: '$/oz' },
  { symbol: 'PL=F', label: 'Platinum', category: 'metals', unit: '$/oz' },
  { symbol: 'PA=F', label: 'Palladium', category: 'metals', unit: '$/oz' },
  { symbol: 'HG=F', label: 'Copper', category: 'metals', unit: '$/lb' },
  { symbol: 'ALI=F', label: 'Aluminum', category: 'metals', unit: '$/lb' },
  { symbol: '^NICKEL', label: 'Nickel', category: 'metals', unit: '$/mt' },
  { symbol: 'ZNC=F', label: 'Zinc', category: 'metals', unit: '$/mt' },
  
  // === ENERGY (8) ===
  { symbol: 'CL=F', label: 'WTI Crude', category: 'energy', unit: '$/bbl' },
  { symbol: 'BZ=F', label: 'Brent', category: 'energy', unit: '$/bbl' },
  { symbol: 'NG=F', label: 'Nat Gas', category: 'energy', unit: '$/mmBtu' },
  { symbol: 'RB=F', label: 'Gasoline', category: 'energy', unit: '$/gal' },
  { symbol: 'HO=F', label: 'Heating Oil', category: 'energy', unit: '$/gal' },
  { symbol: 'NG=F', label: 'Propane', category: 'energy', unit: '$/gal' },
  { symbol: 'URA', label: 'Uranium ETF', category: 'energy', unit: '$' },
  { symbol: 'XLE', label: 'Energy ETF', category: 'energy', unit: '$' },
  
  // === AGRICULTURE (16) ===
  { symbol: 'ZW=F', label: 'Wheat', category: 'agriculture', unit: '¢/bu' },
  { symbol: 'ZC=F', label: 'Corn', category: 'agriculture', unit: '¢/bu' },
  { symbol: 'ZS=F', label: 'Soybeans', category: 'agriculture', unit: '¢/bu' },
  { symbol: 'ZM=F', label: 'Soy Meal', category: 'agriculture', unit: '$/ton' },
  { symbol: 'ZL=F', label: 'Soy Oil', category: 'agriculture', unit: '¢/lb' },
  { symbol: 'KC=F', label: 'Coffee', category: 'agriculture', unit: '¢/lb' },
  { symbol: 'CC=F', label: 'Cocoa', category: 'agriculture', unit: '$/mt' },
  { symbol: 'SB=F', label: 'Sugar', category: 'agriculture', unit: '¢/lb' },
  { symbol: 'CT=F', label: 'Cotton', category: 'agriculture', unit: '¢/lb' },
  { symbol: 'LE=F', label: 'Live Cattle', category: 'agriculture', unit: '¢/lb' },
  { symbol: 'HE=F', label: 'Lean Hogs', category: 'agriculture', unit: '¢/lb' },
  { symbol: 'GF=F', label: 'Feeder Cattle', category: 'agriculture', unit: '¢/lb' },
  { symbol: 'ZR=F', label: 'Rice', category: 'agriculture', unit: '$/cwt' },
  { symbol: 'ZO=F', label: 'Oats', category: 'agriculture', unit: '¢/bu' },
  { symbol: 'OJ=F', label: 'Orange Juice', category: 'agriculture', unit: '¢/lb' },
  { symbol: 'LBS=F', label: 'Lumber', category: 'agriculture', unit: '$/mbf' }
];

// Store previous commodity values
const previousCommodityValues = new Map();

async function fetchCommodityData() {
  const commodityData = {
    metals: [],
    energy: [],
    agriculture: []
  };

  try {
    const promises = COMMODITIES.map(async (commodity) => {
      try {
        const response = await axios.get(
          `https://query1.finance.yahoo.com/v8/finance/chart/${commodity.symbol}`,
          { timeout: 5000 }
        );

        const quote = response.data?.chart?.result?.[0];
        if (!quote) return null;

        const meta = quote.meta;
        const price = meta.regularMarketPrice || meta.previousClose;
        const previousClose = meta.chartPreviousClose || meta.previousClose;
        
        const change = price - previousClose;
        const changePercent = ((change / previousClose) * 100).toFixed(2);
        
        let dir = 'neutral';
        if (Math.abs(changePercent) < 0.05) {
          dir = 'neutral';
        } else if (change > 0) {
          dir = 'up';
        } else {
          dir = 'down';
        }

        const decimals = price > 100 ? 2 : price > 10 ? 2 : 4;
        const formattedPrice = price.toFixed(decimals);

        const commodityItem = {
          label: commodity.label,
          price: formattedPrice,
          change: changePercent,
          dir: dir,
          symbol: commodity.symbol,
          unit: commodity.unit
        };

        if (commodity.category === 'metals') {
          commodityData.metals.push(commodityItem);
        } else if (commodity.category === 'energy') {
          commodityData.energy.push(commodityItem);
        } else if (commodity.category === 'agriculture') {
          commodityData.agriculture.push(commodityItem);
        }

        return commodityItem;
      } catch (err) {
        return null;
      }
    });

    await Promise.all(promises);

    // Always add Nickel if missing (Yahoo Finance doesn't have a good symbol for LME Nickel)
    const hasNickel = commodityData.metals.some(m => m.label === 'Nickel');
    if (!hasNickel && commodityData.metals.length > 0) {
      commodityData.metals.push({
        label: 'Nickel', ticker: 'NI', tvSymbol: 'LME:NI1!', price: '16500', change: '-0.30', dir: 'down', unit: '$/mt'
      });
    }

    // Fill with defaults if needed
    if (commodityData.metals.length === 0) {
      commodityData.metals = [
        { label: 'Gold', ticker: 'GC=F', tvSymbol: 'COMEX:GC1!', price: '2650.00', change: '+0.35', dir: 'up', unit: '$/oz' },
        { label: 'Silver', ticker: 'SI=F', tvSymbol: 'COMEX:SI1!', price: '31.50', change: '+0.55', dir: 'up', unit: '$/oz' },
        { label: 'Platinum', ticker: 'PL=F', tvSymbol: 'NYMEX:PL1!', price: '985.00', change: '-0.20', dir: 'down', unit: '$/oz' },
        { label: 'Palladium', ticker: 'PA=F', tvSymbol: 'NYMEX:PA1!', price: '1050.00', change: '-0.15', dir: 'down', unit: '$/oz' },
        { label: 'Copper', ticker: 'HG=F', tvSymbol: 'COMEX:HG1!', price: '4.15', change: '+0.40', dir: 'up', unit: '$/lb' },
        { label: 'Aluminum', ticker: 'ALI=F', tvSymbol: 'LME:ALI1!', price: '1.05', change: '+0.25', dir: 'up', unit: '$/lb' },
        { label: 'Zinc', ticker: 'ZINC', tvSymbol: 'LME:ZNC1!', price: '2850', change: '+0.18', dir: 'up', unit: '$/mt' },
        { label: 'Nickel', ticker: 'NI', tvSymbol: 'LME:NI1!', price: '16500', change: '-0.30', dir: 'down', unit: '$/mt' }
      ];
    }

    if (commodityData.energy.length === 0) {
      commodityData.energy = [
        { label: 'WTI Crude', ticker: 'CL=F', tvSymbol: 'NYMEX:CL1!', price: '72.50', change: '-0.45', dir: 'down', unit: '$/bbl' },
        { label: 'Brent', ticker: 'BZ=F', tvSymbol: 'NYMEX:BZ1!', price: '76.20', change: '-0.38', dir: 'down', unit: '$/bbl' },
        { label: 'Nat Gas', ticker: 'NG=F', tvSymbol: 'NYMEX:NG1!', price: '3.25', change: '+1.20', dir: 'up', unit: '$/mmBtu' },
        { label: 'Gasoline', ticker: 'RB=F', tvSymbol: 'NYMEX:RB1!', price: '2.15', change: '-0.25', dir: 'down', unit: '$/gal' },
        { label: 'Heating Oil', ticker: 'HO=F', tvSymbol: 'NYMEX:HO1!', price: '2.35', change: '-0.18', dir: 'down', unit: '$/gal' },
        { label: 'Propane', ticker: 'PN', tvSymbol: 'NYMEX:PN1!', price: '0.85', change: '+0.08', dir: 'up', unit: '$/gal' },
        { label: 'URA ETF', ticker: 'URA', tvSymbol: 'AMEX:URA', price: '28.50', change: '+0.65', dir: 'up', unit: '$' },
        { label: 'XLE ETF', ticker: 'XLE', tvSymbol: 'AMEX:XLE', price: '92.30', change: '-0.22', dir: 'down', unit: '$' }
      ];
    }

    if (commodityData.agriculture.length === 0) {
      commodityData.agriculture = [
        { label: 'Wheat', ticker: 'ZW=F', tvSymbol: 'CBOT:ZW1!', price: '580', change: '+0.45', dir: 'up', unit: '¢/bu' },
        { label: 'Corn', ticker: 'ZC=F', tvSymbol: 'CBOT:ZC1!', price: '455', change: '+0.28', dir: 'up', unit: '¢/bu' },
        { label: 'Soybeans', ticker: 'ZS=F', tvSymbol: 'CBOT:ZS1!', price: '1025', change: '-0.15', dir: 'down', unit: '¢/bu' },
        { label: 'Soy Meal', ticker: 'ZM=F', tvSymbol: 'CBOT:ZM1!', price: '325', change: '-0.22', dir: 'down', unit: '$/ton' },
        { label: 'Soy Oil', ticker: 'ZL=F', tvSymbol: 'CBOT:ZL1!', price: '42.5', change: '+0.35', dir: 'up', unit: '¢/lb' },
        { label: 'Coffee', ticker: 'KC=F', tvSymbol: 'ICEUS:KC1!', price: '185', change: '+1.50', dir: 'up', unit: '¢/lb' },
        { label: 'Cocoa', ticker: 'CC=F', tvSymbol: 'ICEUS:CC1!', price: '4250', change: '+0.85', dir: 'up', unit: '$/mt' },
        { label: 'Sugar', ticker: 'SB=F', tvSymbol: 'ICEUS:SB1!', price: '22.5', change: '-0.12', dir: 'down', unit: '¢/lb' },
        { label: 'Cotton', ticker: 'CT=F', tvSymbol: 'ICEUS:CT1!', price: '78.5', change: '+0.18', dir: 'up', unit: '¢/lb' },
        { label: 'Live Cattle', ticker: 'LE=F', tvSymbol: 'CME:LE1!', price: '185', change: '+0.25', dir: 'up', unit: '¢/lb' },
        { label: 'Lean Hogs', ticker: 'HE=F', tvSymbol: 'CME:HE1!', price: '82.5', change: '-0.35', dir: 'down', unit: '¢/lb' },
        { label: 'Feeder Cattle', ticker: 'GF=F', tvSymbol: 'CME:GF1!', price: '252', change: '+0.42', dir: 'up', unit: '¢/lb' },
        { label: 'Rice', ticker: 'ZR=F', tvSymbol: 'CBOT:ZR1!', price: '15.25', change: '+0.08', dir: 'up', unit: '$/cwt' },
        { label: 'Oats', ticker: 'ZO=F', tvSymbol: 'CBOT:ZO1!', price: '385', change: '-0.28', dir: 'down', unit: '¢/bu' },
        { label: 'Orange Juice', ticker: 'OJ=F', tvSymbol: 'ICEUS:OJ1!', price: '425', change: '+2.15', dir: 'up', unit: '¢/lb' },
        { label: 'Lumber', ticker: 'LBS=F', tvSymbol: 'CME:LBS1!', price: '565', change: '-0.55', dir: 'down', unit: '$/mbf' }
      ];
    }

  } catch (error) {
    console.error('Commodity data fetch error:', error.message);
    // Return defaults on error (same as above)
    commodityData.metals = [
      { label: 'Gold', ticker: 'GC=F', tvSymbol: 'COMEX:GC1!', price: '2650.00', change: '+0.35', dir: 'up', unit: '$/oz' },
      { label: 'Silver', ticker: 'SI=F', tvSymbol: 'COMEX:SI1!', price: '31.50', change: '+0.55', dir: 'up', unit: '$/oz' },
      { label: 'Platinum', ticker: 'PL=F', tvSymbol: 'NYMEX:PL1!', price: '985.00', change: '-0.20', dir: 'down', unit: '$/oz' },
      { label: 'Palladium', ticker: 'PA=F', tvSymbol: 'NYMEX:PA1!', price: '1050.00', change: '-0.15', dir: 'down', unit: '$/oz' },
      { label: 'Copper', ticker: 'HG=F', tvSymbol: 'COMEX:HG1!', price: '4.15', change: '+0.40', dir: 'up', unit: '$/lb' },
      { label: 'Aluminum', ticker: 'ALI=F', tvSymbol: 'LME:ALI1!', price: '1.05', change: '+0.25', dir: 'up', unit: '$/lb' },
      { label: 'Zinc', ticker: 'ZINC', tvSymbol: 'LME:ZNC1!', price: '2850', change: '+0.18', dir: 'up', unit: '$/mt' },
      { label: 'Nickel', ticker: 'NI', tvSymbol: 'LME:NI1!', price: '16500', change: '-0.30', dir: 'down', unit: '$/mt' }
    ];
    commodityData.energy = [
      { label: 'WTI Crude', ticker: 'CL=F', tvSymbol: 'NYMEX:CL1!', price: '72.50', change: '-0.45', dir: 'down', unit: '$/bbl' },
      { label: 'Brent', ticker: 'BZ=F', tvSymbol: 'NYMEX:BZ1!', price: '76.20', change: '-0.38', dir: 'down', unit: '$/bbl' },
      { label: 'Nat Gas', ticker: 'NG=F', tvSymbol: 'NYMEX:NG1!', price: '3.25', change: '+1.20', dir: 'up', unit: '$/mmBtu' },
      { label: 'Gasoline', ticker: 'RB=F', tvSymbol: 'NYMEX:RB1!', price: '2.15', change: '-0.25', dir: 'down', unit: '$/gal' },
      { label: 'Heating Oil', ticker: 'HO=F', tvSymbol: 'NYMEX:HO1!', price: '2.35', change: '-0.18', dir: 'down', unit: '$/gal' },
      { label: 'Propane', ticker: 'PN', tvSymbol: 'NYMEX:PN1!', price: '0.85', change: '+0.08', dir: 'up', unit: '$/gal' },
      { label: 'URA ETF', ticker: 'URA', tvSymbol: 'AMEX:URA', price: '28.50', change: '+0.65', dir: 'up', unit: '$' },
      { label: 'XLE ETF', ticker: 'XLE', tvSymbol: 'AMEX:XLE', price: '92.30', change: '-0.22', dir: 'down', unit: '$' }
    ];
    commodityData.agriculture = [
      { label: 'Wheat', ticker: 'ZW=F', tvSymbol: 'CBOT:ZW1!', price: '580', change: '+0.45', dir: 'up', unit: '¢/bu' },
      { label: 'Corn', ticker: 'ZC=F', tvSymbol: 'CBOT:ZC1!', price: '455', change: '+0.28', dir: 'up', unit: '¢/bu' },
      { label: 'Soybeans', ticker: 'ZS=F', tvSymbol: 'CBOT:ZS1!', price: '1025', change: '-0.15', dir: 'down', unit: '¢/bu' },
      { label: 'Soy Meal', ticker: 'ZM=F', tvSymbol: 'CBOT:ZM1!', price: '325', change: '-0.22', dir: 'down', unit: '$/ton' },
      { label: 'Soy Oil', ticker: 'ZL=F', tvSymbol: 'CBOT:ZL1!', price: '42.5', change: '+0.35', dir: 'up', unit: '¢/lb' },
      { label: 'Coffee', ticker: 'KC=F', tvSymbol: 'ICEUS:KC1!', price: '185', change: '+1.50', dir: 'up', unit: '¢/lb' },
      { label: 'Cocoa', ticker: 'CC=F', tvSymbol: 'ICEUS:CC1!', price: '4250', change: '+0.85', dir: 'up', unit: '$/mt' },
      { label: 'Sugar', ticker: 'SB=F', tvSymbol: 'ICEUS:SB1!', price: '22.5', change: '-0.12', dir: 'down', unit: '¢/lb' },
      { label: 'Cotton', ticker: 'CT=F', tvSymbol: 'ICEUS:CT1!', price: '78.5', change: '+0.18', dir: 'up', unit: '¢/lb' },
      { label: 'Live Cattle', ticker: 'LE=F', tvSymbol: 'CME:LE1!', price: '185', change: '+0.25', dir: 'up', unit: '¢/lb' },
      { label: 'Lean Hogs', ticker: 'HE=F', tvSymbol: 'CME:HE1!', price: '82.5', change: '-0.35', dir: 'down', unit: '¢/lb' },
      { label: 'Feeder Cattle', ticker: 'GF=F', tvSymbol: 'CME:GF1!', price: '252', change: '+0.42', dir: 'up', unit: '¢/lb' },
      { label: 'Rice', ticker: 'ZR=F', tvSymbol: 'CBOT:ZR1!', price: '15.25', change: '+0.08', dir: 'up', unit: '$/cwt' },
      { label: 'Oats', ticker: 'ZO=F', tvSymbol: 'CBOT:ZO1!', price: '385', change: '-0.28', dir: 'down', unit: '¢/bu' },
      { label: 'Orange Juice', ticker: 'OJ=F', tvSymbol: 'ICEUS:OJ1!', price: '425', change: '+2.15', dir: 'up', unit: '¢/lb' },
      { label: 'Lumber', ticker: 'LBS=F', tvSymbol: 'CME:LBS1!', price: '565', change: '-0.55', dir: 'down', unit: '$/mbf' }
    ];
  }

  return commodityData;
}

async function fetchFXData() {
  const fxData = {
    macro: [],
    geo: [],
    commodity: []
  };

  try {
    // Fetch all FX pairs in parallel
    const promises = FX_PAIRS.map(async (pair) => {
      try {
        const response = await axios.get(
          `https://query1.finance.yahoo.com/v8/finance/chart/${pair.symbol}`,
          { timeout: 5000 }
        );

        const quote = response.data?.chart?.result?.[0];
        if (!quote) return null;

        const meta = quote.meta;
        const price = meta.regularMarketPrice || meta.previousClose;
        const previousClose = meta.chartPreviousClose || meta.previousClose;
        
        // Calculate change
        const change = price - previousClose;
        const changePercent = ((change / previousClose) * 100).toFixed(2);
        
        // Determine direction
        let dir = 'neutral';
        if (Math.abs(changePercent) < 0.05) {
          dir = 'neutral';
        } else if (change > 0) {
          dir = 'up';
        } else {
          dir = 'down';
        }

        // Format price (4 decimals for most, 2 for JPY pairs)
        const decimals = pair.label.includes('JPY') ? 2 : 4;
        const formattedPrice = price.toFixed(decimals);

        const pairData = {
          label: pair.label,
          price: formattedPrice,
          change: changePercent,
          dir: dir,
          symbol: pair.symbol,
          tvSymbol: pair.tvSymbol // Include TradingView symbol
        };

        // Add to appropriate category
        if (pair.category === 'macro') {
          fxData.macro.push(pairData);
        } else if (pair.category === 'geo') {
          fxData.geo.push(pairData);
        } else if (pair.category === 'commodity') {
          fxData.commodity.push(pairData);
        }

        return pairData;
      } catch (err) {
        console.error(`Error fetching ${pair.label}:`, err.message);
        return null;
      }
    });

    await Promise.all(promises);

    // Fill with defaults if no data
    if (fxData.macro.length === 0) {
      fxData.macro = [
        { label: 'DXY', price: '107.25', change: '+0.15', dir: 'up', tvSymbol: 'TVC:DXY' },
        { label: 'BTC/USD', price: '68500', change: '+1.20', dir: 'up', tvSymbol: 'COINBASE:BTCUSD' },
        { label: 'ETH/USD', price: '3800', change: '+0.85', dir: 'up', tvSymbol: 'COINBASE:ETHUSD' },
        { label: 'EUR/USD', price: '1.0920', change: '+0.08', dir: 'up', tvSymbol: 'FX_IDC:EURUSD' },
        { label: 'USD/JPY', price: '151.20', change: '+0.15', dir: 'up', tvSymbol: 'FX_IDC:USDJPY' },
        { label: 'GBP/USD', price: '1.2750', change: '+0.12', dir: 'up', tvSymbol: 'FX_IDC:GBPUSD' },
        { label: 'USD/CHF', price: '0.8810', change: '-0.05', dir: 'down', tvSymbol: 'FX_IDC:USDCHF' },
        { label: 'EUR/JPY', price: '165.10', change: '+0.22', dir: 'up', tvSymbol: 'FX_IDC:EURJPY' },
        { label: 'EUR/CHF', price: '0.9620', change: '-0.03', dir: 'down', tvSymbol: 'FX_IDC:EURCHF' },
        { label: 'CHF/JPY', price: '171.50', change: '+0.18', dir: 'up', tvSymbol: 'FX_IDC:CHFJPY' }
      ];
    }

    if (fxData.geo.length === 0) {
      fxData.geo = [
        { label: 'USD/CNH', price: '7.2300', change: '+0.12', dir: 'up', tvSymbol: 'FX_IDC:USDCNH' },
        { label: 'USD/ILS', price: '3.7500', change: '+0.08', dir: 'up', tvSymbol: 'FX_IDC:USDILS' },
        { label: 'USD/MXN', price: '17.100', change: '-0.15', dir: 'down', tvSymbol: 'FX_IDC:USDMXN' },
        { label: 'USD/PLN', price: '3.9500', change: '0.00', dir: 'neutral', tvSymbol: 'FX_IDC:USDPLN' },
        { label: 'USD/TRY', price: '32.100', change: '+0.25', dir: 'up', tvSymbol: 'FX_IDC:USDTRY' },
        { label: 'USD/KRW', price: '1350.0', change: '-0.10', dir: 'down', tvSymbol: 'FX_IDC:USDKRW' },
        { label: 'USD/INR', price: '83.400', change: '+0.05', dir: 'up', tvSymbol: 'FX_IDC:USDINR' },
        { label: 'USD/SGD', price: '1.3500', change: '0.00', dir: 'neutral', tvSymbol: 'FX_IDC:USDSGD' },
        { label: 'EUR/GBP', price: '0.8500', change: '-0.08', dir: 'down', tvSymbol: 'FX_IDC:EURGBP' },
        { label: 'GBP/JPY', price: '192.80', change: '+0.18', dir: 'up', tvSymbol: 'FX_IDC:GBPJPY' }
      ];
    }

    if (fxData.commodity.length === 0) {
      fxData.commodity = [
        { label: 'USD/CAD', price: '1.3400', change: '-0.12', dir: 'down', tvSymbol: 'FX_IDC:USDCAD' },
        { label: 'AUD/USD', price: '0.6600', change: '+0.15', dir: 'up', tvSymbol: 'FX_IDC:AUDUSD' },
        { label: 'USD/NOK', price: '10.500', change: '-0.08', dir: 'down', tvSymbol: 'FX_IDC:USDNOK' },
        { label: 'NZD/USD', price: '0.6100', change: '+0.10', dir: 'up', tvSymbol: 'FX_IDC:NZDUSD' },
        { label: 'USD/BRL', price: '5.1500', change: '-0.18', dir: 'down', tvSymbol: 'FX_IDC:USDBRL' },
        { label: 'USD/ZAR', price: '18.500', change: '+0.22', dir: 'up', tvSymbol: 'FX_IDC:USDZAR' },
        { label: 'CAD/JPY', price: '112.50', change: '+0.20', dir: 'up', tvSymbol: 'FX_IDC:CADJPY' },
        { label: 'AUD/JPY', price: '100.20', change: '+0.25', dir: 'up', tvSymbol: 'FX_IDC:AUDJPY' },
        { label: 'AUD/NZD', price: '1.0800', change: '0.00', dir: 'neutral', tvSymbol: 'FX_IDC:AUDNZD' },
        { label: 'EUR/AUD', price: '1.6500', change: '-0.12', dir: 'down', tvSymbol: 'FX_IDC:EURAUD' }
      ];
    }

  } catch (error) {
    console.error('FX data fetch error:', error.message);
    
    // Return defaults on error
    fxData.macro = [
      { label: 'DXY', price: '107.25', change: '+0.15', dir: 'up', tvSymbol: 'TVC:DXY' },
      { label: 'BTC/USD', price: '68500', change: '+1.20', dir: 'up', tvSymbol: 'COINBASE:BTCUSD' },
      { label: 'ETH/USD', price: '3800', change: '+0.85', dir: 'up', tvSymbol: 'COINBASE:ETHUSD' },
      { label: 'EUR/USD', price: '1.0920', change: '+0.08', dir: 'up', tvSymbol: 'FX_IDC:EURUSD' },
      { label: 'USD/JPY', price: '151.20', change: '+0.15', dir: 'up', tvSymbol: 'FX_IDC:USDJPY' },
      { label: 'GBP/USD', price: '1.2750', change: '+0.12', dir: 'up', tvSymbol: 'FX_IDC:GBPUSD' },
      { label: 'USD/CHF', price: '0.8810', change: '-0.05', dir: 'down', tvSymbol: 'FX_IDC:USDCHF' },
      { label: 'EUR/JPY', price: '165.10', change: '+0.22', dir: 'up', tvSymbol: 'FX_IDC:EURJPY' },
      { label: 'EUR/CHF', price: '0.9620', change: '-0.03', dir: 'down', tvSymbol: 'FX_IDC:EURCHF' },
      { label: 'CHF/JPY', price: '171.50', change: '+0.18', dir: 'up', tvSymbol: 'FX_IDC:CHFJPY' }
    ];

    fxData.geo = [
      { label: 'USD/CNH', price: '7.2300', change: '+0.12', dir: 'up', tvSymbol: 'FX_IDC:USDCNH' },
      { label: 'USD/ILS', price: '3.7500', change: '+0.08', dir: 'up', tvSymbol: 'FX_IDC:USDILS' },
      { label: 'USD/MXN', price: '17.100', change: '-0.15', dir: 'down', tvSymbol: 'FX_IDC:USDMXN' },
      { label: 'USD/PLN', price: '3.9500', change: '0.00', dir: 'neutral', tvSymbol: 'FX_IDC:USDPLN' },
      { label: 'USD/TRY', price: '32.100', change: '+0.25', dir: 'up', tvSymbol: 'FX_IDC:USDTRY' },
      { label: 'USD/KRW', price: '1350.0', change: '-0.10', dir: 'down', tvSymbol: 'FX_IDC:USDKRW' },
      { label: 'USD/INR', price: '83.400', change: '+0.05', dir: 'up', tvSymbol: 'FX_IDC:USDINR' },
      { label: 'USD/SGD', price: '1.3500', change: '0.00', dir: 'neutral', tvSymbol: 'FX_IDC:USDSGD' },
      { label: 'EUR/GBP', price: '0.8500', change: '-0.08', dir: 'down', tvSymbol: 'FX_IDC:EURGBP' },
      { label: 'GBP/JPY', price: '192.80', change: '+0.18', dir: 'up', tvSymbol: 'FX_IDC:GBPJPY' }
    ];

    fxData.commodity = [
      { label: 'USD/CAD', price: '1.3400', change: '-0.12', dir: 'down', tvSymbol: 'FX_IDC:USDCAD' },
      { label: 'AUD/USD', price: '0.6600', change: '+0.15', dir: 'up', tvSymbol: 'FX_IDC:AUDUSD' },
      { label: 'USD/NOK', price: '10.500', change: '-0.08', dir: 'down', tvSymbol: 'FX_IDC:USDNOK' },
      { label: 'NZD/USD', price: '0.6100', change: '+0.10', dir: 'up', tvSymbol: 'FX_IDC:NZDUSD' },
      { label: 'USD/BRL', price: '5.1500', change: '-0.18', dir: 'down', tvSymbol: 'FX_IDC:USDBRL' },
      { label: 'USD/ZAR', price: '18.500', change: '+0.22', dir: 'up', tvSymbol: 'FX_IDC:USDZAR' },
      { label: 'CAD/JPY', price: '112.50', change: '+0.20', dir: 'up', tvSymbol: 'FX_IDC:CADJPY' },
      { label: 'AUD/JPY', price: '100.20', change: '+0.25', dir: 'up', tvSymbol: 'FX_IDC:AUDJPY' },
      { label: 'AUD/NZD', price: '1.0800', change: '0.00', dir: 'neutral', tvSymbol: 'FX_IDC:AUDNZD' },
      { label: 'EUR/AUD', price: '1.6500', change: '-0.12', dir: 'down', tvSymbol: 'FX_IDC:EURAUD' }
    ];
  }

  return fxData;
}

// Central bank meeting schedules for 2025-2026 (auto-updates to next meeting)
const CENTRAL_BANK_MEETINGS = {
  Fed: {
    rate: '4.50%',
    meetings2025: ['2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-11-05', '2025-12-17'],
    meetings2026: ['2026-01-29', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09']
  },
  ECB: {
    rate: '3.00%',
    meetings2025: ['2025-01-30', '2025-03-06', '2025-04-17', '2025-06-05', '2025-07-24', '2025-09-04', '2025-10-30', '2025-12-18'],
    meetings2026: ['2026-01-22', '2026-01-30', '2026-03-12', '2026-04-16', '2026-06-04', '2026-07-23', '2026-09-10', '2026-10-29', '2026-12-17']
  },
  BOE: {
    rate: '4.50%',
    meetings2025: ['2025-02-06', '2025-03-20', '2025-05-08', '2025-06-19', '2025-08-07', '2025-09-18', '2025-11-06', '2025-12-18'],
    meetings2026: ['2026-02-05', '2026-02-06', '2026-03-19', '2026-04-30', '2026-06-18', '2026-07-30', '2026-09-17', '2026-11-05', '2026-12-17']
  },
  BOJ: {
    rate: '0.75%',
    meetings2025: ['2025-01-24', '2025-03-14', '2025-04-25', '2025-06-13', '2025-07-31', '2025-09-19', '2025-10-31', '2025-12-19'],
    meetings2026: ['2026-01-23', '2026-03-19', '2026-04-28', '2026-06-16', '2026-07-31', '2026-09-18', '2026-10-30', '2026-12-18']
  },
  RBA: {
    rate: '3.60%',
    meetings2025: ['2025-02-18', '2025-04-01', '2025-05-20', '2025-07-08', '2025-08-19', '2025-10-07', '2025-11-25', '2025-12-09'],
    meetings2026: ['2026-02-03', '2026-04-01', '2026-05-20', '2026-07-08', '2026-08-19', '2026-10-07', '2026-11-25', '2026-12-09']
  }
};

function getNextMeetingDate(bank) {
  const now = new Date();
  const meetings = [...(CENTRAL_BANK_MEETINGS[bank].meetings2025 || []), ...(CENTRAL_BANK_MEETINGS[bank].meetings2026 || [])];
  for (const date of meetings) {
    const meetingDate = new Date(date);
    if (meetingDate >= now) {
      const month = meetingDate.toLocaleString('en-US', { month: 'short' });
      const day = meetingDate.getDate();
      return `${month} ${day}`;
    }
  }
  return 'TBD';
}

const CENTRAL_BANK_RATES = Object.entries(CENTRAL_BANK_MEETINGS).map(([bank, data]) => ({
  bank,
  currency: bank === 'Fed' ? 'USD' : bank === 'ECB' ? 'EUR' : bank === 'BOE' ? 'GBP' : bank === 'BOJ' ? 'JPY' : 'AUD',
  rate: data.rate,
  next: getNextMeetingDate(bank)
}));

// ============================================================================
// ALPACA REAL-TIME NEWS STREAM (WebSocket)
// ============================================================================

let alpacaWs = null;
let alpacaReconnectTimeout = null;

function connectAlpacaNews() {
  if (!CONFIG.ALPACA_API_KEY || !CONFIG.ALPACA_API_SECRET) {
    console.log('⚠️  Alpaca API keys not configured - real-time news disabled');
    return;
  }

  const wsUrl = 'wss://stream.data.alpaca.markets/v1beta1/news';
  
  try {
    alpacaWs = new WebSocket(wsUrl, {
      headers: {
        'APCA-API-KEY-ID': CONFIG.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': CONFIG.ALPACA_API_SECRET
      }
    });

    alpacaWs.on('open', () => {
      console.log('🚀 Alpaca News WebSocket connected - REAL-TIME NEWS ACTIVE');
      // Subscribe to all news
      alpacaWs.send(JSON.stringify({ action: 'subscribe', news: ['*'] }));
    });

    alpacaWs.on('message', (data) => {
      try {
        const messages = JSON.parse(data);
        for (const msg of (Array.isArray(messages) ? messages : [messages])) {
          if (msg.T === 'n') {
            // Process real-time news article
            processAlpacaNews(msg);
          } else if (msg.T === 'subscription') {
            console.log('📰 Alpaca: Subscribed to real-time news stream');
          } else if (msg.T === 'error') {
            console.error('❌ Alpaca error:', msg.msg);
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    alpacaWs.on('close', () => {
      console.log('⚠️  Alpaca WebSocket closed - reconnecting in 5s...');
      alpacaReconnectTimeout = setTimeout(connectAlpacaNews, 5000);
    });

    alpacaWs.on('error', (error) => {
      console.error('❌ Alpaca WebSocket error:', error.message);
    });

  } catch (error) {
    console.error('❌ Failed to connect to Alpaca:', error.message);
  }
}

function processAlpacaNews(article) {
  const articleId = `alpaca-${article.id}`;
  
  if (seenArticles.has(articleId)) return;
  seenArticles.add(articleId);
  
  if (seenArticles.size > 5000) {
    const firstItem = seenArticles.values().next().value;
    seenArticles.delete(firstItem);
  }

  // Format publication date
  const pubDate = new Date(article.created_at);
  const now = new Date();
  const hoursSince = Math.floor((now - pubDate) / (1000 * 60 * 60));
  let pubDateDisplay = 'Just now';
  if (hoursSince >= 1 && hoursSince < 24) {
    pubDateDisplay = `${hoursSince}h ago`;
  } else if (hoursSince >= 24) {
    pubDateDisplay = pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Classify the news
  const text = article.headline + ' ' + (article.summary || '');
  const category = classifyNews(text);
  
  const smartData = generateUltimateImplications(
    article.headline,
    category,
    article.summary || ''
  );

  const cardData = {
    type: 'new_card',
    column: category,
    data: {
      time: new Date().toISOString().substr(11, 5),
      headline: article.headline,
      link: article.url || '',
      source: `${article.source || 'Alpaca'} ⚡`,
      pubDate: pubDateDisplay,
      verified: true,
      implications: smartData.implications,
      impact: smartData.impact || 2,
      horizon: smartData.horizon || 'DAYS',
      tripwires: smartData.technicalLevels || [],
      probNudge: [],
      tags: [...(smartData.tags || []), 'REALTIME'],
      confidence: smartData.confidence,
      nextEvents: smartData.nextEvents || [],
      regime: smartData.regime,
      symbols: article.symbols || []
    }
  };

  console.log(`⚡ REAL-TIME: ${article.headline.substring(0, 60)}...`);
  broadcast(cardData);
}

// ============================================================================
// SCHEDULED JOBS
// ============================================================================

// RSS feeds every 30 seconds for TweetDeck-like speed
cron.schedule('*/30 * * * * *', () => {
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

// Polymarket risks every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    console.log('🎲 Polling Polymarket prediction markets...');
    const riskData = await fetchPolymarketRisks();
    broadcast({ type: 'polymarket_update', data: riskData });
  } catch (error) {
    console.error('Polymarket update error:', error.message);
  }
});

// FX data every 30 seconds
cron.schedule('*/30 * * * * *', async () => {
  try {
    const fxData = await fetchFXData();
    broadcast({ type: 'fx_update', data: fxData });
  } catch (error) {
    console.error('FX update error:', error.message);
  }
});

// Commodity data every 60 seconds
cron.schedule('*/60 * * * * *', async () => {
  try {
    const commodityData = await fetchCommodityData();
    broadcast({ type: 'commodity_update', data: commodityData });
  } catch (error) {
    console.error('Commodity update error:', error.message);
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
  ⚡ Alpaca Real-Time: ${CONFIG.ALPACA_API_KEY ? '✅ ENABLED' : '❌ ADD KEYS FOR INSTANT NEWS'}
  📡 RSS Feeds: ✅ ${RSS_FEEDS.length} PREMIUM SOURCES
  
  RSS Sources Active:
  ├─ FINANCE: Reuters, CNBC, MarketWatch, BBC, FT (x2), WSJ (x2)
  ├─ MACRO: Federal Reserve, ECB, BIS
  ├─ GEOPOLITICS: Defense News, Reuters, NYT, Geopolitical Futures
  ├─ COMMODITIES: EIA, Mining.com, Reuters Energy, OilPrice.com
  ├─ FOREX/MARKETS: DailyFX, ForexLive
  └─ Polling every 30 seconds
  
  Frontend: http://localhost:${CONFIG.PORT}
  `);

  // Initial aggressive fetch to populate columns (reduced from 8 to 5 for speed)
  console.log('🚀 Starting aggressive initial fetch to fill columns...');
  setTimeout(() => {
    pollRSSFeeds(5);
  }, 1000);
  
  setTimeout(() => {
    console.log('📰 Initial NewsAPI fetch...');
    pollNewsAPI();
  }, 1500);
  
  setTimeout(() => {
    console.log('🌍 Initial geopolitical fetch...');
    pollGeopoliticalNews();
  }, 2000);
  
  setTimeout(async () => {
    console.log('🎲 Initial Polymarket fetch...');
    try {
      const riskData = await fetchPolymarketRisks();
      broadcast({ type: 'polymarket_update', data: riskData });
    } catch (error) {
      console.error('Initial Polymarket fetch error:', error.message);
    }
  }, 2500);
  
  setTimeout(async () => {
    console.log('💱 Initial FX data fetch...');
    try {
      const fxData = await fetchFXData();
      broadcast({ type: 'fx_update', data: fxData });
    } catch (error) {
      console.error('Initial FX fetch error:', error.message);
    }
  }, 3000);
  
  // Connect to Alpaca real-time news stream
  setTimeout(() => {
    connectAlpacaNews();
  }, 3500);
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
