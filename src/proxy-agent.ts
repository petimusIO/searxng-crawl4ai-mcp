import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { logger } from './logger.js';

export function createProxyAgent(proxyUrl?: string) {
  if (!proxyUrl) {
    logger.info('No proxy URL provided, using direct connection');
    return null;
  }

  try {
    logger.info(`Creating proxy agent with URL: ${proxyUrl.replace(/\/\/.*@/, '//***@')}`);
    
    // Create both HTTP and HTTPS proxy agents
    const httpAgent = new HttpProxyAgent(proxyUrl);
    const httpsAgent = new HttpsProxyAgent(proxyUrl);

    return {
      http: httpAgent,
      https: httpsAgent,
    };
  } catch (error) {
    logger.error('Failed to create proxy agent:', error);
    throw new Error('Invalid proxy configuration');
  }
}

export function getAxiosProxyConfig(proxyUrl?: string) {
  if (!proxyUrl) {
    return {};
  }

  try {
    const url = new URL(proxyUrl);
    return {
      proxy: {
        protocol: url.protocol.replace(':', ''),
        host: url.hostname,
        port: parseInt(url.port),
        auth: url.username && url.password ? {
          username: url.username,
          password: url.password
        } : undefined
      }
    };
  } catch (error) {
    logger.error('Failed to parse proxy URL:', error);
    return {};
  }
}