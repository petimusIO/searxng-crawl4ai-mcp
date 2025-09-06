# Firecrawl MCP Custom - Self-Hosted with Rotating Proxy

A self-hosted Firecrawl MCP (Model Context Protocol) server with rotating IP proxy support for enhanced web scraping capabilities.

## Features

- 🔥 **Self-hosted Firecrawl**: Complete control over your web scraping infrastructure
- 🔄 **Rotating IP Proxy**: Built-in support for rotating IP addresses to avoid blocks
- 🐳 **Docker Ready**: Easy deployment with Docker Compose
- 📊 **Redis Integration**: Caching and rate limiting support
- 🎭 **Playwright Support**: JavaScript rendering for dynamic content
- 📝 **Comprehensive Logging**: Winston-based logging with file rotation
- 🛠️ **TypeScript**: Full TypeScript support for better development experience

## Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for development)
- A rotating IP proxy service

## Quick Start

### 1. Clone and Setup

```bash
git clone <your-repo-url>
cd firecrawl-mcp-custom
```

### 2. Configure Environment

Copy the provided `.env` file and update with your settings:

```bash
# Your rotating proxy is already configured
PROXY_URL=http://sp1w0pmdkq:SF6so4rdDj3vSq=r3l@dc.decodo.com:10000

# Optional: Add your Firecrawl API key if using cloud features
FIRECRAWL_API_KEY=your-api-key-here
```

### 3. Start Services

```bash
# Build and start all services
docker-compose up --build

# Or run in background
docker-compose up -d --build
```

### 4. Test Installation

```bash
# Test the scraping endpoint
curl -X POST http://localhost:3002/v1/scrape \\
  -H 'Content-Type: application/json' \\
  -d '{
    "url": "https://example.com",
    "formats": ["markdown"]
  }'
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PROXY_URL` | Your rotating IP proxy URL | Required |
| `NUM_WORKERS_PER_QUEUE` | Number of workers per queue | 8 |
| `PORT` | Server port | 3002 |
| `REDIS_URL` | Redis connection URL | redis://redis:6379 |
| `PLAYWRIGHT_MICROSERVICE_URL` | Playwright service URL | http://playwright-service:3000/html |

### Proxy Configuration

Your rotating IP proxy is already configured:
```
http://sp1w0pmdkq:SF6so4rdDj3vSq=r3l@dc.decodo.com:10000
```

This proxy will be used for all web requests to help avoid IP blocks and rate limits.

## Available Tools

### 1. Scrape URL
Scrape content from a single URL:
```json
{
  "tool": "scrape_url",
  "arguments": {
    "url": "https://example.com",
    "options": {
      "formats": ["markdown", "html"],
      "waitFor": 1000,
      "timeout": 30000
    }
  }
}
```

### 2. Batch Scrape
Scrape multiple URLs in batch:
```json
{
  "tool": "batch_scrape",
  "arguments": {
    "urls": ["https://example.com", "https://another-site.com"],
    "options": {
      "formats": ["markdown"],
      "concurrency": 3
    }
  }
}
```

### 3. Crawl Website
Crawl an entire website:
```json
{
  "tool": "crawl_website",
  "arguments": {
    "url": "https://example.com",
    "options": {
      "limit": 10,
      "maxDepth": 2,
      "includePaths": ["/blog/*"],
      "excludePaths": ["/admin/*"]
    }
  }
}
```

### 4. Map Website
Generate a complete list of URLs from a website (sitemap discovery):
```json
{
  "tool": "map_website",
  "arguments": {
    "url": "https://example.com",
    "options": {
      "search": "blog",
      "limit": 1000,
      "ignoreSitemap": false
    }
  }
}
```

### 5. Extract Structured Data
Extract specific data using AI prompts:
```json
{
  "tool": "extract_structured_data",
  "arguments": {
    "url": "https://news-article.com",
    "prompt": "Extract the article title, author, publication date, and main points",
    "schema": {
      "type": "object",
      "properties": {
        "title": {"type": "string"},
        "author": {"type": "string"},
        "date": {"type": "string"},
        "points": {"type": "array", "items": {"type": "string"}}
      }
    }
  }
}
```

### 6. Get Crawl Status
Check the status of a long-running crawl job:
```json
{
  "tool": "get_crawl_status",
  "arguments": {
    "jobId": "your-crawl-job-id"
  }
}
```

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build the project
npm run build

# Run tests
npm test

# Type checking
npm run typecheck

# Lint code
npm run lint
```

### Project Structure

```
firecrawl-mcp-custom/
├── src/
│   ├── index.ts          # Main MCP server
│   ├── proxy-agent.ts    # Proxy configuration
│   └── logger.ts         # Logging setup
├── tests/                # Test files
├── logs/                 # Log files
├── docker-compose.yml    # Docker services
├── Dockerfile           # Application container
└── .env                 # Environment configuration
```

## Monitoring and Logs

Logs are written to the `logs/` directory:
- `combined.log` - All log levels
- `error.log` - Error logs only
- `exceptions.log` - Uncaught exceptions

View logs in real-time:
```bash
# Follow all logs
docker-compose logs -f

# Follow specific service
docker-compose logs -f firecrawl-api
```

## Troubleshooting

### Common Issues

1. **Proxy Connection Errors**
   - Verify your proxy credentials and URL
   - Check if the proxy service is accessible

2. **Redis Connection Issues**
   - Ensure Redis container is running
   - Check Redis URL configuration

3. **Playwright Service Errors**
   - Verify Playwright service is healthy
   - Check browser dependencies

### Health Checks

```bash
# Check service status
docker-compose ps

# Test Redis connection
docker-compose exec redis redis-cli ping

# Test Playwright service
curl http://localhost:3001/health
```

## Security Considerations

- Never commit your `.env` file with real credentials
- Use strong authentication for production deployments
- Keep your proxy credentials secure
- Regularly update dependencies

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review logs for error details
3. Open an issue with detailed information