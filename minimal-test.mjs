import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({
  name: 'test-server',
  version: '1.0.0',
}, {
  capabilities: { tools: {} },
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr so stdout stays clean
console.error('Server started, waiting for messages...');

// Keep alive check
const start = Date.now();
const iv = setInterval(() => {
  console.error(`Alive at ${Date.now() - start}ms`);
}, 1000);

// Auto-exit after 30 seconds
setTimeout(() => {
  clearInterval(iv);
  console.error('30s reached - exiting normally');
  process.exit(0);
}, 30000);
