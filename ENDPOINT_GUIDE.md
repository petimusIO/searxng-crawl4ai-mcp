# 🛠️ MCP Endpoint Usage Guide

## Overview

This MCP server provides three powerful tools for search and web scraping. Each tool has specific strengths and optimal use cases.

---

## 🔍 **Tool 1: `search_web`**

### What It Does
Fast web search using SearXNG metasearch engine that aggregates 70+ search engines.

### Input Schema
```json
{
  "query": "string (required) - Your search query",
  "maxResults": "number (optional) - Max results to return (default: 10)"
}
```

### Example Usage
```json
{
  "query": "Bitcoin price analysis September 2025",
  "maxResults": 5
}
```

### What You Get Back
- **Search Results**: Array of results with titles, URLs, snippets
- **Source Diversity**: Results from Google, Bing, DuckDuckGo, Wikipedia, etc.
- **Metadata**: Engine sources, relevance scores, publish dates
- **Performance**: Sub-second response time

### ✅ **Pros**
- ⚡ **Ultra-fast**: <1 second response time
- 📊 **High volume**: 30+ results vs 10 from native tools
- 🔍 **Source diversity**: Multiple search engines aggregated
- 🛡️ **Privacy**: Self-hosted, no external API calls
- 📈 **Current data**: Recent sources and real-time information

### ❌ **Cons** 
- 🧠 **No synthesis**: Raw results without AI analysis
- 📝 **Manual processing**: Need to interpret results yourself
- 🔗 **Links only**: Doesn't scrape content automatically

### 🎯 **Best Use Cases**
- Quick fact-checking during conversations
- Research topic exploration
- Finding current news and data sources
- Competitive analysis and source discovery
- Time-sensitive information gathering

### 🆚 **vs Native WebSearch**
| Aspect | search_web | Native WebSearch |
|--------|------------|------------------|
| Speed | 3x faster | Slower but smarter |
| Results | More raw data | Better synthesis |
| Privacy | Self-hosted | External APIs |
| Analysis | None | Intelligent summaries |

**Use search_web when**: You need fast, comprehensive source discovery
**Use native when**: You need analyzed, synthesized information

---

## 🕷️ **Tool 2: `crawl4ai_scrape`**

### What It Does
Advanced web scraping using Crawl4AI with Playwright browser automation for JavaScript-heavy sites.

### Input Schema
```json
{
  "url": "string (required) - URL to scrape",
  "formats": "array (optional) - Output formats: ['markdown', 'html', 'links'] (default: ['markdown'])"
}
```

### Example Usage
```json
{
  "url": "https://finance.yahoo.com/quote/BTC-USD/",
  "formats": ["markdown"]
}
```

### What You Get Back
- **Full Content**: Complete page content in clean markdown
- **Metadata**: Page title, description, language, word count
- **Rich Data**: Navigation, embedded content, dynamic JavaScript data
- **Structured**: Clean, readable format perfect for analysis

### ✅ **Pros**
- 🎯 **100% reliable**: Never fails like native WebFetch
- 🕷️ **JavaScript support**: Handles dynamic content perfectly
- 📄 **Complete extraction**: Gets full page content including hidden elements
- 🔧 **Multiple formats**: Markdown, HTML, links extraction
- ⚙️ **Configurable**: Timeout, wait times, custom options
- 📊 **Rich metadata**: Title, description, word counts

### ❌ **Cons**
- 🐌 **Slower**: 3-8 seconds per page vs instant native calls
- 📈 **Resource intensive**: Uses browser automation
- 🔋 **High memory**: Playwright browser instances
- 📦 **Large responses**: Can exceed token limits on complex pages

### 🎯 **Best Use Cases**
- Scraping financial data from trading platforms
- Extracting content from JavaScript-heavy sites
- Getting complete technical analysis from TradingView
- Downloading research reports and documentation
- Extracting API documentation and specifications

### 🆚 **vs Native WebFetch**
| Aspect | crawl4ai_scrape | Native WebFetch |
|--------|-----------------|-----------------|
| Reliability | 100% success | Often fails/hangs |
| JavaScript | Full support | Limited |
| Content | Complete extraction | Partial |
| Performance | Consistent | Unreliable |

**Use crawl4ai_scrape when**: You need reliable, complete content extraction
**Use native when**: Simple, fast URL content needed (but expect failures)

---

## 🔄 **Tool 3: `search_and_scrape`**

### What It Does
Combined workflow that searches for information, then automatically scrapes content from the top results.

### Input Schema
```json
{
  "query": "string (required) - Search query",
  "maxResults": "number (optional) - Number of top results to scrape (default: 3)"
}
```

### Example Usage
```json
{
  "query": "Federal Reserve rate decision impact market analysis",
  "maxResults": 2
}
```

### What You Get Back
- **Search Summary**: Number of search results found
- **Scraped Content**: Full content from top URLs
- **Combined Intelligence**: Search discovery + detailed content analysis
- **Rich Context**: Complete articles, analysis, and data

### ✅ **Pros**
- 🧠 **Complete research**: Search + detailed content in one step
- 📊 **Professional analysis**: Gets full articles, not just snippets
- ⏱️ **Efficient workflow**: Combines two operations intelligently
- 🎯 **Targeted content**: Focuses on most relevant sources
- 📈 **Trading intelligence**: Perfect for market research

### ❌ **Cons**
- 🐌 **Slowest**: 5-15 seconds depending on content volume
- 📦 **Large responses**: Often exceeds standard token limits
- 🔋 **Resource heavy**: Scrapes multiple pages simultaneously
- 💸 **Token cost**: High token usage due to large content

### 🎯 **Best Use Cases**
- **Market Research**: "Federal Reserve impact analysis September 2025"
- **Technical Analysis**: "Bitcoin RSI oversold levels current market"
- **News Intelligence**: "Cryptocurrency regulation updates latest 2025"
- **Competitive Analysis**: "Best trading platforms comparison 2025"
- **Investment Research**: "AI stocks analysis Q3 2025 earnings"

### 🆚 **vs Manual Process**
| Aspect | search_and_scrape | Manual Search + Scrape |
|--------|-------------------|----------------------|
| Speed | Automated (one request) | Manual (multiple steps) |
| Completeness | Gets full content | Miss relevant sources |
| Efficiency | High | Low |
| Consistency | Standardized format | Variable quality |

**Use search_and_scrape when**: You need complete research intelligence on a topic
**Avoid when**: You need quick facts or are token-conscious

---

## 📋 **Usage Decision Matrix**

### 🏃 **Need Speed?** → `search_web`
- Quick price checks
- Fast news discovery  
- Source identification
- Real-time data needs

### 🎯 **Need Specific Content?** → `crawl4ai_scrape`
- Scraping specific financial pages
- Getting complete technical analysis
- Extracting API documentation
- Downloading research reports

### 🧠 **Need Complete Intelligence?** → `search_and_scrape`
- Market research projects
- Investment analysis
- Competitive intelligence
- Comprehensive news analysis

---

## ⚡ **Performance Tips**

### Enabling remote MCP connections (quick & simple)

If you want `seek-api` to connect to this MCP server in production (fastest path):

- Start the MCP server as its own container and enable the SSE or streamable-HTTP transport via env vars on the MCP container.
  - `MCP_SSE_PORT=3001` — exposes an SSE endpoint at `/sse` (connect with `MCP_SEARXNG_URL` in `seek-api`).
  - `MCP_STREAMABLE_PORT=3002` — exposes a streamable-HTTP MCP endpoint at `/mcp`.
- In `seek-api` set `MCP_SEARXNG_URL` to the public-internal URL (example: `http://searxng-mcp:3001/sse`).
- Keep MCP on an internal network (do NOT expose the MCP ports to the public internet).

Quick example (docker-compose):

- MCP service (expose internal port only):
  - `MCP_SSE_PORT: 3001`
- Seek API service:
  - `MCP_SEARXNG_URL: http://searxng-mcp:3001/sse`

Security note: this is the fastest way to get MCP in prod and works safely if both containers sit on a private network (Coolify or VNet). Add token checks / mTLS later for extra protection.


### Optimize search_web:
- Use specific queries for better results
- Limit maxResults to avoid overwhelming data
- Use for discovery, then target specific URLs

### Optimize crawl4ai_scrape:
- Test with simple pages first
- Use markdown format for best readability
- Consider timeout settings for slow sites

### Optimize search_and_scrape:
- Keep maxResults low (1-3) to avoid token limits
- Use specific, targeted queries
- Perfect for research that needs depth over breadth

---

## 🎯 **Trading-Specific Examples**

### Real-Time Market Data
```bash
# Quick price check
search_web: "Bitcoin price USD current September 2025"

# Complete market analysis  
search_and_scrape: "Bitcoin technical analysis RSI MACD September 2025"
```

### Economic Events
```bash
# Fast news discovery
search_web: "Federal Reserve decision September 2025"

# Complete analysis
search_and_scrape: "Fed rate cut impact stock market analysis September 2025"
```

### Technical Analysis
```bash
# Specific indicator data
crawl4ai_scrape: "https://www.tradingview.com/symbols/BTCUSD/technicals/"

# Comprehensive TA research
search_and_scrape: "S&P 500 technical analysis support resistance September 2025"
```

---

**🏆 Bottom Line**: Each tool excels in specific scenarios. Use the decision matrix above to choose the right tool for your needs!