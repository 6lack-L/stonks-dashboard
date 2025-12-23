<div align="center">

<h1> Stonks Dashboard </h1>

[![GitHub stars](https://img.shields.io/github/stars/pierridotite/stonks-dashboard?style=social)](https://github.com/praffall/stonks-dashboard/stargazers)
[![npm version](https://img.shields.io/npm/v/stonks-dashboard.svg)](https://www.npmjs.com/package/stonks-dashboard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<a href="https://www.producthunt.com/posts/stonks-dashboard?utm_source=badge-featured&utm_medium=badge&utm_souce=badge-stonks-dashboard" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=stonks-dashboard&theme=light" alt="Stonks Dashboard - Real-time crypto & stock dashboard for your terminal | Product Hunt" style="width: 200px; height: 54px;" width="250" height="54" /></a>

**Minimal real-time market dashboard for your terminal**

![Dashboard](assets/dashboard.png)

</div>

---

## Features

- **Watchlist:** Crypto, stocks, ETFs in one view
- **Trend chart:** Periods 1D, 7D, 30D, 90D
- **Details panel:** Key metrics (price, change, highs/lows)
- **Caching & rate limits:** Smooth updates with fewer API errors

## Quick Start

```bash
npx stonks-dashboard
```

Or install globally:

```bash
npm install -g stonks-dashboard
stonks-dashboard
```

## Local Development

```bash
git clone https://github.com/pierridotite/stonks-dashboard.git
cd stonks-dashboard
npm install
npm start
```

## Controls

- `↑`/`↓`: Navigate watchlist
- `1`–`4`: Switch period (1D/7D/30D/90D)
- `q` or `Ctrl+C`: Quit

## Configuration

Edit `config.json` to customize:

```json
{
  "tickers": ["BTC", "ETH", "AAPL", "TSLA"],
  "cryptoIds": { "BTC": "bitcoin", "ETH": "ethereum" },
  "updateInterval": 120000
}
```

## Data Sources

- **Crypto:** CoinGecko API
- **Stocks/ETFs:** Yahoo Finance API

Requests are rate-limited and cached (`cache.json`). Crypto details cache ~30 min; price series cache ~1 min.

## Requirements

- Node.js (LTS recommended)

## License

MIT - See [LICENSE](LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=pierridotite/stonks-dashboard&type=Date&theme=dark)](https://star-history.com/#pierridotite/stonks-dashboard&Date)
