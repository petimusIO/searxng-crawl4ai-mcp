import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function serviceBlock(path: string, name: string): string {
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex(line => line === `  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^  [\w-]+:/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

describe('CRW network boundary', () => {
  it('does not publish a host port in the production compose file', () => {
    const crw = serviceBlock('docker-compose.yml', 'crw');
    expect(crw).not.toMatch(/^    ports:/m);
    expect(crw).toContain('      - search-net');
    expect(serviceBlock('docker-compose.yml', 'mcp-server')).toContain('CRW_URL=http://crw:3000');
  });

  it('provides only a loopback CRW port in the explicit local debug override', () => {
    const local = readFileSync('docker-compose.local.yml', 'utf8');
    expect(local.match(/^  [\w-]+:/gm)).toEqual(['  crw:']);
    expect(serviceBlock('docker-compose.local.yml', 'crw')).toContain('      - "127.0.0.1:8001:3000"');
    expect(local).not.toContain('0.0.0.0');
  });
});
