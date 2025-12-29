#!/usr/bin/env node
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DataService } from './dataService.js';

class StonksDashboard {
  constructor() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const CONFIG_PATH = path.resolve(__dirname, '../config.json');
    this.config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    this.dataService = new DataService();
    this.assetsData = [];
    this.prevAssetsData = [];
    this.flashIndices = new Set();
    this.selectedIndex = 0;
    this.isLoading = true;
    this.connectionError = false;
    
    // Time periods: 1D, 7D, 30D, 90D
    this.periods = [
      { label: '1D', days: 1 },
      { label: '7D', days: 7 },
      { label: '30D', days: 30 },
      { label: '90D', days: 90 }
    ];
    this.currentPeriodIndex = 1; // Default 7D
    
    this.initScreen();
    this.initWidgets();
    this.setupKeyHandlers();
  }

  initScreen() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'STONKS DASHBOARD',
      fullUnicode: true
    });

    this.screen.key(['escape', 'q', 'C-c'], () => {
      return process.exit(0);
    });
  }

  initWidgets() {
    const grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen
    });

    // Watchlist table - left column
    this.watchlistTable = grid.set(0, 0, 12, 4, contrib.table, {
      keys: false,
      vi: false,
      mouse: false,
      interactive: false,
      label: ' WATCHLIST ',
      border: { type: 'line', fg: 'cyan' },
      fg: 'white',
      columnSpacing: 1,
      columnWidth: [8, 12, 10]
    });

    // Trend chart - top right
    this.trendChart = grid.set(0, 4, 7, 8, contrib.line, {
      label: ' PRICE TREND (7D) ',
      border: { type: 'line', fg: 'cyan' },
      style: {
        line: 'green',
        text: 'white',
        baseline: 'white',
        border: { fg: 'cyan' }
      },
      showLegend: false,
      xPadding: 3,
      yPadding: 1,
      wholeNumbersOnly: false,
      minY: null  // Auto-scale, don't start at 0
    });

    // Details box - bottom right
    this.detailsBox = grid.set(7, 4, 5, 8, blessed.box, {
      label: ' DETAILS ',
      border: { type: 'line', fg: 'cyan' },
      style: {
        border: { fg: 'cyan' }
      },
      tags: true,
      content: ' '
    });

    // Status bar at bottom
    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: {
        fg: 'cyan',
        bg: 'black'
      },
      tags: true,
      content: ' Loading...'
    });
    this.screen.append(this.statusBar);

    // Loading spinner
    this.loadingSpinner = blessed.loading({
      top: 'center',
      left: 'center',
      height: 5,
      width: 40,
      border: { type: 'line', fg: 'cyan' },
      style: { border: { fg: 'cyan' } }
    });
    this.screen.append(this.loadingSpinner);
  }

  setupKeyHandlers() {
    // Arrow up
    this.screen.key(['up', 'k'], () => {
      if (this.assetsData.length === 0) return;
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.refreshDisplay();
      }
    });

    // Arrow down
    this.screen.key(['down', 'j'], () => {
      if (this.assetsData.length === 0) return;
      if (this.selectedIndex < this.assetsData.length - 1) {
        this.selectedIndex++;
        this.refreshDisplay();
      }
    });

    // Period switch keys
    this.screen.key(['1'], () => this.switchPeriod(0));
    this.screen.key(['2'], () => this.switchPeriod(1));
    this.screen.key(['3'], () => this.switchPeriod(2));
    this.screen.key(['4'], () => this.switchPeriod(3));
  }

  refreshDisplay() {
    this.updateWatchlistTable();
    this.updateChartPanel();
    this.updateDetailsPanel();
    this.updateStatusBar();
    this.screen.render();
  }

  async switchPeriod(periodIndex) {
    if (periodIndex < 0 || periodIndex >= this.periods.length) return;
    if (this.currentPeriodIndex === periodIndex) return;
    
    this.currentPeriodIndex = periodIndex;
    
    this.loadingSpinner.load('Fetching data...');
    this.screen.render();
    
    await this.fetchData();
    
    this.loadingSpinner.stop();
    this.refreshDisplay();
  }

  formatPrice(price, symbol = '') {
    if (!price || isNaN(price)) {
      // Return appropriate zero value based on currency
      return symbol.endsWith('.L') ? '£0.00' : '$0.00';
    }
    
    // Handle London Stock Exchange stocks (ending in .L)
    // Yahoo Finance returns LSE prices in pence, so we need to convert
    if (symbol.endsWith('.L')) {
      if (price >= 100) {
        // Show as pounds: £1.23 (convert pence to pounds)
        const pounds = price / 100;
        return `£${pounds.toFixed(2)}`;
      } else {
        // Show as pence with decimal places: 2.05p
        return `${price.toFixed(2)}p`;
      }
    }
    
    // Default USD formatting for other stocks/crypto
    if (price >= 1000) {
      return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else if (price >= 1) {
      return `$${price.toFixed(2)}`;
    } else {
      return `$${price.toFixed(4)}`;
    }
  }

  formatChange(change) {
    if (!change || isNaN(change)) return '+0.00%';
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}%`;
  }

  getAssetCategory(asset) {
    if (asset.type === 'crypto') return 'crypto';
    if (asset.type === 'ETF' || asset.type === 'etf') return 'etf';
    if (asset.type === 'EQUITY' || asset.type === 'equity') return 'stock'
    return 'stock';
  }

  updateWatchlistTable() {
    if (this.assetsData.length === 0) return;

    const headers = ['SYMBOL', 'PRICE', 'CHANGE'];
    const rows = [];
    
    // Separate by type
    const cryptos = this.assetsData.filter(a => this.getAssetCategory(a) === 'crypto');
    const stocks = this.assetsData.filter(a => this.getAssetCategory(a) === 'stock');
    const etfs = this.assetsData.filter(a => this.getAssetCategory(a) === 'etf');
    
    const addSection = (title, assets) => {
      if (assets.length === 0) return;
      rows.push([chalk.cyan(title), '', '']);
      
      for (const asset of assets) {
        const isSelected = this.assetsData.indexOf(asset) === this.selectedIndex;
        const prefix = isSelected ? '>' : ' ';
        const symbol = `${prefix}${asset.symbol}`;
        const price = this.formatPrice(asset.price, asset.symbol);
        const change = this.formatChange(asset.change);
        
        if (isSelected) {
          rows.push([
            chalk.bgBlue.white(symbol.padEnd(7)),
            chalk.bgBlue.white(price.padEnd(11)),
            asset.change >= 0 ? chalk.bgBlue.green(change) : chalk.bgBlue.red(change)
          ]);
        } else {
          rows.push([
            chalk.white(symbol),
            chalk.white(price),
            asset.change >= 0 ? chalk.green(change) : chalk.red(change)
          ]);
        }
      }
    };
    
    addSection('-- CRYPTO --', cryptos);
    addSection('-- STOCKS --', stocks);
    addSection('-- ETFs --', etfs);

    this.watchlistTable.setData({ headers, data: rows });
  }

  updateChartPanel() {
    if (this.assetsData.length === 0 || this.selectedIndex < 0) return;
    if (this.selectedIndex >= this.assetsData.length) {
      this.selectedIndex = this.assetsData.length - 1;
    }

    const asset = this.assetsData[this.selectedIndex];
    if (!asset) return;
    
    // Filter out null/undefined values for history
    const rawHistory = asset.history || [];
    const history = rawHistory.filter(v => v !== null && v !== undefined && !isNaN(v));

    // Use timestamps if available and aligned
    const rawTs = asset.timestamps || [];
    const hasTimestamps = Array.isArray(rawTs) && rawTs.length === rawHistory.length;

    if (history.length === 0) {
      history.push(0);
    }
    
    const period = this.periods[this.currentPeriodIndex];
    const len = history.length;

    // Generate clean X-axis labels (prefer timestamps)
    const numLabels = Math.min(10, len);
    const step = Math.max(1, Math.floor(len / numLabels));

    const x = [];
    for (let i = 0; i < len; i++) {
      const isTick = (i === 0 || i === len - 1 || i % step === 0);
      if (!isTick) { x.push(' '); continue; }

      if (hasTimestamps) {
        const ts = rawTs[i];
        const d = new Date(ts);
        if (period.days === 1) {
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          x.push(`${hh}:${mm}`);
        } else if (period.days <= 7) {
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          x.push(`${m}/${day}`);
        } else {
          const m = String(d.getMonth() + 1).padStart(2, '0');
          x.push(`${m}`);
        }
      } else {
        // Fallback: index-based labels
        x.push(period.days === 1 ? `${i}h` : `${i + 1}`);
      }
    }

    const lineColor = asset.change >= 0 ? 'green' : 'red';
    const category = this.getAssetCategory(asset);
    const typeLabel = category === 'crypto' ? 'CRYPTO' : (category === 'etf' ? 'ETF' : 'STOCK');
    
    this.trendChart.setLabel(` ${asset.symbol} | ${typeLabel} | ${period.label} `);
    
    // Calculate min/max for proper Y scaling (add 5% padding)
    const minVal = Math.min(...history);
    const maxVal = Math.max(...history);
    const padding = (maxVal - minVal) * 0.05 || 1;

    this.trendChart.options.minY = minVal - padding;
    this.trendChart.options.maxY = maxVal + padding;

    this.trendChart.setData([{
      title: asset.symbol,
      x: x,
      y: history,
      style: { line: lineColor }
    }]);
  }

  formatNumber(num) {
    if (!num || isNaN(num)) return 'N/A';
    if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
    return num.toLocaleString();
  }

  updateDetailsPanel() {
    if (this.assetsData.length === 0 || this.selectedIndex < 0) return;
    if (this.selectedIndex >= this.assetsData.length) return;

    const asset = this.assetsData[this.selectedIndex];
    if (!asset) return;
    
    const changeColor = asset.change >= 0 ? 'green' : 'red';
    const changeText = this.formatChange(asset.change);
    
    // Determine asset type label
    const category = this.getAssetCategory(asset);
    let typeLabel = 'STOCK';
    let typeIcon = '[S]';
    if (category === 'crypto') {
      typeLabel = 'CRYPTO';
      typeIcon = '[C]';
    } else if (category === 'etf') {
      typeLabel = 'ETF';
      typeIcon = '[E]';
    }

    let content = '';
    
    if (asset.type === 'crypto') {
      // Crypto detailed view
      content = `
 {bold}{cyan-fg}${typeIcon} ${asset.symbol}{/cyan-fg}{/bold} {gray-fg}${typeLabel}{/gray-fg} ${asset.rank ? `#${asset.rank}` : ''}
 ${'─'.repeat(38)}
 {bold}Price{/bold}        ${this.formatPrice(asset.price, asset.symbol)}
 {bold}24h{/bold}          {${changeColor}-fg}${this.formatChange(asset.change24h || asset.change)}{/${changeColor}-fg}
 {bold}Open{/bold}         ${this.formatPrice(asset.open, asset.symbol)}
 ${'─'.repeat(38)}
 {bold}High 24h{/bold}     ${this.formatPrice(asset.high, asset.symbol)}
 {bold}Low 24h{/bold}      ${this.formatPrice(asset.low, asset.symbol)}
 {bold}ATH{/bold}          ${this.formatPrice(asset.high52w, asset.symbol)}
 {bold}ATL{/bold}          ${this.formatPrice(asset.low52w, asset.symbol)}
 ${'─'.repeat(38)}
 {bold}Mkt Cap{/bold}      ${this.formatNumber(asset.marketCap)}
 {bold}Volume 24h{/bold}   ${this.formatNumber(asset.volume)}
 {bold}Circ Supply{/bold}  ${this.formatNumber(asset.circulatingSupply)}
 ${'─'.repeat(38)}
 ${asset.fromCache ? '{yellow-fg}[CACHE]{/yellow-fg}' : '{green-fg}[LIVE]{/green-fg}'} ${asset.error ? '{red-fg}[ERROR]{/red-fg}' : ''}
`;
    } else {
      // Stock/ETF detailed view
      content = `
 {bold}{cyan-fg}${typeIcon} ${asset.symbol}{/cyan-fg}{/bold} {gray-fg}${typeLabel}{/gray-fg}
 ${'─'.repeat(38)}
 {bold}Price{/bold}        ${this.formatPrice(asset.price, asset.symbol)}
 {bold}Change{/bold}       {${changeColor}-fg}${changeText}{/${changeColor}-fg}
 {bold}Open{/bold}         ${this.formatPrice(asset.open, asset.symbol)}
 {bold}Prev Close{/bold}   ${this.formatPrice(asset.previousClose, asset.symbol)}
 ${'─'.repeat(38)}
 {bold}High{/bold}         ${this.formatPrice(asset.high, asset.symbol)}
 {bold}Low{/bold}          ${this.formatPrice(asset.low, asset.symbol)}
 {bold}52wk High{/bold}    ${this.formatPrice(asset.high52w, asset.symbol)}
 {bold}52wk Low{/bold}     ${this.formatPrice(asset.low52w, asset.symbol)}
 ${'─'.repeat(38)}
 {bold}Volume{/bold}       ${this.formatNumber(asset.volume)}
 {bold}Avg Vol{/bold}      ${this.formatNumber(asset.avgVolume)}
 {bold}Mkt Cap{/bold}      ${this.formatNumber(asset.marketCap)}
 {bold}P/E{/bold}          ${asset.pe ? asset.pe.toFixed(2) : 'N/A'}
 ${'─'.repeat(38)}
 ${asset.fromCache ? '{yellow-fg}[CACHE]{/yellow-fg}' : '{green-fg}[LIVE]{/green-fg}'} ${asset.error ? '{red-fg}[ERROR]{/red-fg}' : ''}
`;
    }

    this.detailsBox.setContent(content);
  }

  updateStatusBar() {
    const now = new Date().toLocaleTimeString();
    const period = this.periods[this.currentPeriodIndex].label;
    const assetCount = this.assetsData.length;
    const selected = this.selectedIndex + 1;
    
    const status = this.connectionError 
      ? '{yellow-fg}CACHED{/yellow-fg}' 
      : '{green-fg}LIVE{/green-fg}';
    
    this.statusBar.setContent(
      ` ${status} | ${selected}/${assetCount} | ${period} | ${now} | {cyan-fg}[1-4]{/cyan-fg} Period | {cyan-fg}[UP/DOWN]{/cyan-fg} Navigate | {cyan-fg}[q]{/cyan-fg} Quit`
    );
  }

  async fetchData() {
    try {
      this.connectionError = false;
      const period = this.periods[this.currentPeriodIndex];
      const newData = await this.dataService.fetchAllAssets(
        this.config.tickers,
        this.config.cryptoIds,
        period.days
      );
      
      // Compute flash indices
      const prevBySymbol = new Map(this.prevAssetsData.map(a => [a.symbol, a]));
      this.flashIndices.clear();
      for (const asset of newData) {
        const prev = prevBySymbol.get(asset.symbol);
        if (prev && prev.price > 0) {
          const deltaPct = Math.abs((asset.price - prev.price) / prev.price) * 100;
          if (deltaPct >= 2) {
            this.flashIndices.add(asset.symbol);
          }
        }
      }
      
      this.prevAssetsData = this.assetsData;
      this.assetsData = newData;
      
      // Clamp selected index
      if (this.selectedIndex >= this.assetsData.length) {
        this.selectedIndex = Math.max(0, this.assetsData.length - 1);
      }
      
      this.connectionError = this.assetsData.some(asset => asset.error);
      
    } catch (error) {
      this.connectionError = true;
    }
  }

  async startGameLoop() {
    await this.fetchData();
    
    this.isLoading = false;
    this.loadingSpinner.stop();
    this.refreshDisplay();

    // Update loop
    setInterval(async () => {
      await this.fetchData();
      this.refreshDisplay();
    }, this.config.updateInterval);
  }

  async start() {
    this.loadingSpinner.load('Loading market data...');
    this.screen.render();
    await this.startGameLoop();
  }
}

const dashboard = new StonksDashboard();
dashboard.start().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
