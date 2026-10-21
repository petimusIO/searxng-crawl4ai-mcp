import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SearXNGMCPServer } from './server.js';
export { SearXNGMCPServer } from './server.js';

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  new SearXNGMCPServer().run().catch(console.error);
}
