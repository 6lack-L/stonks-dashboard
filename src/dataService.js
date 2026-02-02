import axios from 'axios';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Global rate limiter for CoinGecko - sequential with delay
let lastCoinGeckoCall = 0;
const COINGECKO_DELAY = 5000; // 5 seconds between calls to avoid 429

// File cache settings
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT_DIR, 'cache.json');
const CACHE_TTL = 60 * 1000; // 1 minute cache validity
const DETAIL_TTL = 30 * 60 * 1000; // 30 minutes for crypto detail

async function waitForCoinGecko() {
  const now = Date.now();
  const elapsed = now - lastCoinGeckoCall;
  if (elapsed < COINGECKO_DELAY) {
    await new Promise(resolve => setTimeout(resolve, COINGECKO_DELAY - elapsed));
  }
  lastCoinGeckoCall = Date.now();
}

async function axiosGetWithRetry(url, options, retries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await waitForCoinGecko();
      return await axios.get(url, options);
    } catch (e) {
      const status = e.response?.status;
      const shouldRetry = status === 429 || (status >= 500) || !status;
      if (attempt < retries && shouldRetry) {
        const jitter = Math.floor(Math.random() * 300);
        const delay = baseDelay * Math.pow(2, attempt) + jitter;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

export class DataService {
  constructor() {
    this.cache = new Map();
    this.loadFileCache();
  }

  loadFileCache() {
    try {
      if (existsSync(CACHE_FILE)) {
        const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
        for (const [key, value] of Object.entries(data)) {
          this.cache.set(key, value);
        }
        console.log(`[Cache] Loaded ${Object.keys(data).length} entries from file`);
      }
    } catch (error) {
      console.error('[Cache] Error loading cache file:', error.message);
    }
  }

  saveFileCache() {
    try {
      const data = Object.fromEntries(this.cache);
      writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[Cache] Error saving cache file:', error.message);
    }
  }

  isCacheValid(cacheKey, ttl = CACHE_TTL) {
    const cached = this.cache.get(cacheKey);
    if (!cached || !cached.timestamp) return false;
    return (Date.now() - cached.timestamp) < ttl;
  }

  async fetchCryptoData(symbol, coinId, days = 7) {
    const chartKey = `crypto-${symbol}-${days}`;
    const detailKey = `detail-${coinId}`;

    // Use cached chart if valid
    if (this.isCacheValid(chartKey)) {
      return { ...this.cache.get(chartKey), fromCache: true };
    }

    try {
      // Fetch chart sequentially with delay
      const chartResponse = await axiosGetWithRetry(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`, {
        params: { vs_currency: 'usd', days: days },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      });

      // Build aligned timestamps + prices arrays, filtering invalid points
      const pairs = chartResponse.data.prices || [];
      const timestamps = [];
      const prices = [];
      for (const p of pairs) {
        const ts = p?.[0];
        const val = p?.[1];
        if (val !== null && val !== undefined && !isNaN(val)) {
          timestamps.push(typeof ts === 'number' ? ts : Date.now());
          prices.push(val);
        }
      }
      if (prices.length === 0) prices.push(0);
      const validPrices = prices.filter(p => p > 0);

      // Try to use cached details (longer TTL)
      let detailData = this.isCacheValid(detailKey, DETAIL_TTL) ? this.cache.get(detailKey) : null;
      if (!detailData) {
        // Space requests to avoid burst 429
        try {
          const detailResponse = await axiosGetWithRetry(`https://api.coingecko.com/api/v3/coins/${coinId}`, {
            params: { localization: false, tickers: false, community_data: false, developer_data: false },
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
          });
          const md = detailResponse.data.market_data || {};
          detailData = {
            currentPrice: md.current_price?.usd || null,
            change24h: md.price_change_percentage_24h || 0,
            high24h: md.high_24h?.usd || null,
            low24h: md.low_24h?.usd || null,
            ath: md.ath?.usd || null,
            atl: md.atl?.usd || null,
            marketCap: md.market_cap?.usd || 0,
            volume24h: md.total_volume?.usd || 0,
            circulatingSupply: md.circulating_supply || 0,
            totalSupply: md.total_supply || 0,
            rank: detailResponse.data.market_cap_rank || 0,
            timestamp: Date.now()
          };
          this.cache.set(detailKey, detailData);
          this.saveFileCache();
        } catch (e) {
          // Details optional; continue with chart-only data
          detailData = null;
        }
      }

      const currentPrice = (detailData?.currentPrice ?? prices[prices.length - 1]) || 0;
      const firstPrice = prices[0] || currentPrice;
      const change = firstPrice > 0 ? ((currentPrice - firstPrice) / firstPrice) * 100 : 0;

      const result = {
        symbol,
        type: 'crypto',
        price: currentPrice,
        change,
        change24h: detailData?.change24h ?? 0,
        history: prices,
        timestamps,
        // Extended
        open: prices[0] || 0,
        high: (detailData?.high24h ?? (validPrices.length > 0 ? Math.max(...validPrices) : 0)) || 0,
        low: (detailData?.low24h ?? (validPrices.length > 0 ? Math.min(...validPrices) : 0)) || 0,
        high52w: detailData?.ath ?? 0,
        low52w: detailData?.atl ?? 0,
        marketCap: detailData?.marketCap ?? 0,
        volume: detailData?.volume24h ?? 0,
        circulatingSupply: detailData?.circulatingSupply ?? 0,
        totalSupply: detailData?.totalSupply ?? 0,
        rank: detailData?.rank ?? 0,
        timestamp: Date.now(),
        error: false
      };

      this.cache.set(chartKey, result);
      this.saveFileCache();
      return result;

    } catch (error) {
      console.error(`[Crypto] ${symbol}: ${error.message}`);

      if (this.cache.has(chartKey)) {
        return { ...this.cache.get(chartKey), error: true, fromCache: true };
      }

      return {
        symbol,
        type: 'crypto',
        price: 0,
        change: 0,
        change24h: 0,
        history: [0],
        open: 0,
        high: 0,
        low: 0,
        high52w: 0,
        low52w: 0,
        marketCap: 0,
        volume: 0,
        circulatingSupply: 0,
        totalSupply: 0,
        rank: 0,
        error: true
      };
    }
  }

  async fetchStockData(symbol, days = 7) {
    const cacheKey = `stock-${symbol}-${days}`;

    // Return cached data if valid
    if (this.isCacheValid(cacheKey)) {
      return { ...this.cache.get(cacheKey), fromCache: true };
    }

    let range = '1d';
    let interval = '1d';
    if (days <= 1) {
      range = '1m';
      interval = '1h';
    } else if (days <= 7) {
      range = '7d';
      interval = '1d';
    } else if (days <= 30) {
      range = '1mo';
      interval = '1d';
    } else {
      range = '3mo';
      interval = '1d';
    }

    try {
      // Fetch chart data
      const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
        params: { interval, range },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      });

      const result = response.data.chart.result[0];
      const quote = result.indicators.quote[0];
      const meta = result.meta;

      // Align timestamps with close prices, filtering invalid points
      const rawCloses = quote.close || [];
      const rawTimestamps = result.timestamp || [];
      const closePrices = [];
      const timestamps = [];
      for (let i = 0; i < rawCloses.length; i++) {
        const val = rawCloses[i];
        if (val !== null && val !== undefined && !isNaN(val)) {
          closePrices.push(val);
          const ts = rawTimestamps[i];
          timestamps.push(typeof ts === 'number' ? ts * 1000 : Date.now());
        }
      }

      if (closePrices.length === 0) closePrices.push(0);

      const currentPrice = meta.regularMarketPrice || closePrices[closePrices.length - 1] || 0;
      const previousClose = meta.chartPreviousClose || closePrices[0] || currentPrice;
      const change = previousClose > 0 ? ((currentPrice - previousClose) / previousClose) * 100 : 0;
      const validPrices = closePrices.filter(p => p > 0);

      // Get first price of the day as open (approximation)
      const openPrices = (quote.open || []).filter(p => p !== null && !isNaN(p));
      const openPrice = openPrices[openPrices.length - 1] || previousClose;

      const data = {
        symbol,
        type: meta.instrumentType,
        price: currentPrice,
        change,
        change24h: change,
        history: closePrices,
        timestamps,
        // Extended data
        open: openPrice,
        previousClose: previousClose,
        high: meta.regularMarketDayHigh || (validPrices.length > 0 ? Math.max(...validPrices) : 0),
        low: meta.regularMarketDayLow || (validPrices.length > 0 ? Math.min(...validPrices) : 0),
        high52w: meta.fiftyTwoWeekHigh || 0,
        low52w: meta.fiftyTwoWeekLow || 0,
        marketCap: 0,
        volume: meta.regularMarketVolume || 0,
        avgVolume: 0,
        pe: 0,
        timestamp: Date.now(),
        error: false
      };

      // Try to get additional quote data
      try {
        const quoteResponse = await axios.get(`https://query1.finance.yahoo.com/v7/finance/quote`, {
          params: { symbols: symbol },
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 5000
        });

        const quoteData = quoteResponse.data.quoteResponse?.result?.[0];
        if (quoteData) {
          data.marketCap = quoteData.marketCap || 0;
          data.pe = quoteData.trailingPE || quoteData.forwardPE || 0;
          data.avgVolume = quoteData.averageDailyVolume3Month || quoteData.averageDailyVolume10Day || 0;
          data.high52w = quoteData.fiftyTwoWeekHigh || data.high52w;
          data.low52w = quoteData.fiftyTwoWeekLow || data.low52w;
          data.open = quoteData.regularMarketOpen || data.open;
        }
      } catch (e) {
        // Quote data is optional, continue without it
      }

      this.cache.set(cacheKey, data);
      this.saveFileCache();
      return data;

    } catch (error) {
      console.error(`[Stock] ${symbol}: ${error.message}`);

      if (this.cache.has(cacheKey)) {
        return { ...this.cache.get(cacheKey), error: true, fromCache: true };
      }

      return {
        symbol,
        type: 'stock',
        price: 0,
        change: 0,
        change24h: 0,
        history: [0],
        open: 0,
        previousClose: 0,
        high: 0,
        low: 0,
        high52w: 0,
        low52w: 0,
        marketCap: 0,
        volume: 0,
        avgVolume: 0,
        pe: 0,
        error: true
      };
    }
  }

  async fetchAllAssets(tickers, cryptoIds, days = 7) {
    const results = [];

    // Sequential fetching to respect rate limits
    for (const ticker of tickers) {
      const coinId = cryptoIds[ticker];
      if (coinId) {
        results.push(await this.fetchCryptoData(ticker, coinId, days));
      } else {
        results.push(await this.fetchStockData(ticker, days));
      }
    }

    return results;
  }
}