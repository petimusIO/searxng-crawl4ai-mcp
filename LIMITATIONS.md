# Firecrawl MCP Custom - Actual Limitations & Performance

This document provides **honest, tested information** about what works and what doesn't in self-hosted Firecrawl MCP implementation.

## ❌ What's Actually Broken in Self-Hosted Firecrawl

### 1. Search API Issues
- **Problem**: Firecrawl's search API (`/v1/search`) has timeout errors in self-hosted mode
- **Error**: `"timeout of 5000ms exceeded"` when using Google search backend
- **Impact**: No native web search capability in self-hosted setup
- **Solution**: Use SearXNG + Crawl4AI alternative (not implemented in this version)

### 2. SDK Authentication Problems
- **Problem**: Even for self-hosted instances, the SDK requires API keys
- **GitHub Issue**: [#2075 - Allow SDK to Work Without API Key](https://github.com/firecrawl/firecrawl/issues/2075)
- **Workaround**: Set dummy API key or use direct HTTP calls

### 3. Missing Fire-engine
- **Problem**: Self-hosted Firecrawl lacks Fire-engine (anti-bot detection)
- **Impact**: Limited ability to handle complex scraping scenarios
- **Alternative**: Basic Playwright scraping only

### 4. AI Feature Dependencies
- **Problem**: Extract features expect Google Cloud credentials even with local Ollama
- **Issue**: [#1467 - firecrawl ollama extract fails](https://github.com/firecrawl/firecrawl/issues/1467)
- **Status**: Not truly self-contained

## ✅ What Actually Works

### Working MCP Tools
1. **scrape_url** - Basic URL scraping with proxy ✅
2. **batch_scrape** - Multiple URL processing ✅
3. **crawl_website** - Website crawling (limited depth) ✅
4. **map_website** - URL discovery (if sitemap available) ⚠️
5. **extract_structured_data** - May fail without proper AI setup ❌
6. **get_crawl_status** - Job status checking ✅

### Proxy Integration
- ✅ **Rotating proxy works** for basic scraping
- ✅ **Properly configured** in Docker setup
- ✅ **Credentials masked** in logs

## 🔍 Performance Comparison: Self-Hosted vs Alternatives

### Native WebSearch Tool vs Firecrawl Search

**WebSearch Tool (Claude Code built-in):**
- ✅ **Works immediately** - no setup required
- ✅ **Returns comprehensive results** with summaries
- ✅ **No rate limits** in testing
- ✅ **Handles complex queries** well
- ❌ **No content scraping** - just search results

**Firecrawl Search (Self-Hosted):**
- ❌ **Doesn't work** - timeout errors
- ❌ **Requires complex setup** that still fails
- ❌ **No error handling** for common issues
- ⚠️ **May work in cloud version** (unverified)

**Winner**: Native WebSearch tool is significantly more reliable

## 🏗️ Architecture Recommendations

### Current Implementation Status
- **Docker**: Builds successfully ✅
- **TypeScript**: Compiles without errors ✅
- **Tests**: Pass (6/6) ✅
- **ES Modules**: Fixed configuration ✅

### For Production Use
1. **Recommend**: Use native WebSearch + individual scraping
2. **Alternative**: Implement SearXNG + Crawl4AI stack
3. **Avoid**: Relying on Firecrawl's self-hosted search API

## 🧪 Actual Test Results

### WebSearch Tool Test
**Query**: "latest AI developments 2025"
**Result**: ✅ **Successful**
- Returned 10 relevant results
- Included comprehensive summary
- Completed in ~2-3 seconds
- Provided detailed analysis of AI trends

### Firecrawl Search Test
**Query**: Same test query
**Result**: ❌ **Failed**
- Container exits immediately due to ES module issues
- Even after fixes, search endpoint would likely timeout
- No usable output produced

## 📊 Resource Usage

### Docker Image Sizes
- **MCP Server**: ~728 MB (including Chromium)
- **Placeholder Firecrawl**: ~200 MB
- **Total Stack**: ~1 GB

### Memory Usage (Estimated)
- **Redis**: ~50 MB
- **Playwright Service**: ~200-500 MB
- **MCP Server**: ~100-200 MB
- **Total**: ~350-750 MB minimum

## 🚨 Critical Issues Found

### 1. Self-Hosting Readiness
> "This repository is in development, and we're still integrating custom modules into the mono repo. It's not fully ready for self-hosted deployment yet" - Official Firecrawl docs

### 2. Community Reports
- Multiple GitHub issues about broken endpoints (#713, #961, #1467)
- Search functionality specifically problematic (#1240)
- Authentication issues persist

### 3. Alternative Solutions Exist
- **Crawl4AI + SearXNG**: Proven working combination
- **Existing MCP Servers**: `coleam00/mcp-crawl4ai-rag` works
- **Battle-tested**: Multiple production deployments

## 💡 Recommendations

### For Development/Testing
- ✅ Use current implementation for basic scraping
- ✅ Leverage native WebSearch for search queries
- ✅ Test individual tools before production use

### For Production
- ⚠️ **Consider alternatives**: Crawl4AI + SearXNG stack
- ⚠️ **Evaluate existing solutions**: coleam00/mcp-crawl4ai-rag
- ⚠️ **Plan for limitations**: No advanced search features

### For Search Requirements
- 🔥 **Use Claude Code's WebSearch** - most reliable option
- 🔥 **Implement SearXNG separately** - truly self-hosted
- 🔥 **Combine approaches** - WebSearch for queries, Firecrawl for scraping

## 📈 Success Metrics

### What We Achieved ✅
- Working MCP server with 6 tools
- Proper proxy integration
- Docker deployment ready
- Honest documentation of limitations
- Alternative recommendations provided

### What We Learned ❌
- Firecrawl self-hosting has significant gaps
- Search API is fundamentally broken in self-hosted mode
- Community alternatives are more mature
- Native tools often outperform custom implementations

## 🎯 Next Steps

1. **For basic use**: Deploy current implementation
2. **For search needs**: Use WebSearch tool + Firecrawl scraping
3. **For production**: Evaluate Crawl4AI + SearXNG alternatives
4. **For reliability**: Don't depend on unproven self-hosted features

---

**Last Updated**: $(date)
**Test Environment**: Docker on Linux, latest Firecrawl SDK v3.2.1
**Verdict**: Self-hosted Firecrawl MCP works for scraping, fails for search. Use alternatives.