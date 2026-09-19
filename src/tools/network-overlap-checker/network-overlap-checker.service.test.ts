import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { analyzeNetworks, formatMarkdown } from './network-overlap-checker.service';

describe('network overlap checker', () => {
  it('ignores blank lines and comments while preserving source line numbers and labels', () => {
    const result = analyzeNetworks('\n# Inventory\r\n 192.0.2.0/24 # Office VLAN \r\n\n192.0.2.17/32 # Printer');

    expect(result.issues).toEqual([]);
    expect(result.networks.map(({ line, label, input }) => ({ line, label, input }))).toEqual([
      { line: 3, label: 'Office VLAN', input: '192.0.2.0/24' },
      { line: 5, label: 'Printer', input: '192.0.2.17/32' },
    ]);
    expect(result.overlaps).toEqual([
      { leftLine: 3, rightLine: 5, kind: 'contains', sharedCidr: '192.0.2.17/32' },
    ]);
  });

  it('returns an empty analysis for an empty or comment-only document', () => {
    expect(analyzeNetworks(' \n# Nothing supplied\n')).toMatchObject({
      networks: [], issues: [], overlaps: [], totalOverlaps: 0, truncated: false, limitExceeded: false,
    });
  });

  it.each([
    ['192.0.2.129/24', '192.0.2.0/24', '192.0.2.0', '192.0.2.255', '256', true],
    ['0.0.0.0/0', '0.0.0.0/0', '0.0.0.0', '255.255.255.255', '4294967296', false],
    ['255.255.255.255/0', '0.0.0.0/0', '0.0.0.0', '255.255.255.255', '4294967296', true],
    ['255.255.255.255/32', '255.255.255.255/32', '255.255.255.255', '255.255.255.255', '1', false],
    ['192.0.2.11/31', '192.0.2.10/31', '192.0.2.10', '192.0.2.11', '2', true],
  ])('calculates exact IPv4 boundaries for %s', (input, cidr, start, end, addressCount, normalized) => {
    const result = analyzeNetworks(input);
    expect(result.issues).toEqual([]);
    expect(result.networks).toHaveLength(1);
    expect(result.networks[0]).toMatchObject({ cidr, start, end, addressCount, normalized, family: 4 });
  });

  it.each([
    ['2001:db8::1234/64', '2001:db8::/64', '2001:db8::', '2001:db8::ffff:ffff:ffff:ffff', '18446744073709551616', true],
    ['::/0', '::/0', '::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '340282366920938463463374607431768211456', false],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/0', '::/0', '::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '340282366920938463463374607431768211456', true],
    ['::1/128', '::1/128', '::1', '::1', '1', false],
    ['2001:db8::3/127', '2001:db8::2/127', '2001:db8::2', '2001:db8::3', '2', true],
  ])('calculates exact IPv6 boundaries for %s', (input, cidr, start, end, addressCount, normalized) => {
    const result = analyzeNetworks(input);
    expect(result.issues).toEqual([]);
    expect(result.networks[0]).toMatchObject({ cidr, start, end, addressCount, normalized, family: 6 });
  });

  it('canonicalizes IPv6 without labelling textual changes as cleared host bits', () => {
    const result = analyzeNetworks('2001:0DB8:0000:0000:0001:0000:0000:0001/128\n2001:db8:0:1:2:3:4:5/128');
    expect(result.issues).toEqual([]);
    expect(result.networks.map(({ cidr, normalized }) => ({ cidr, normalized }))).toEqual([
      { cidr: '2001:db8::1:0:0:1/128', normalized: false },
      { cidr: '2001:db8:0:1:2:3:4:5/128', normalized: false },
    ]);
  });

  it('treats IPv4 embedded in IPv6 as IPv6 and recognizes its hexadecimal equivalent', () => {
    const result = analyzeNetworks('::ffff:192.0.2.1/128\n::ffff:c000:201/128\n192.0.2.1/32');
    expect(result.issues).toEqual([]);
    expect(result.networks[0]).toMatchObject({ family: 6, cidr: '::ffff:c000:201/128', addressCount: '1' });
    expect(result.overlaps).toEqual([
      { leftLine: 1, rightLine: 2, kind: 'duplicate', sharedCidr: '::ffff:c000:201/128' },
    ]);
  });

  it.each([
    '192.0.2.1', '::1', '192.0.2.1/', '::1/',
    '192.0.2.1/33', '::1/129', '192.0.2.1/-1', '::1/+64',
    '192.0.2.1/24.0', '::1/1e2', '192.0.2.1/024', '::1/064',
    '192.0.2.1/ 24', '192.0.2.1/24/32',
    '192.0.2', '192.0.2.1.4/24', '256.0.0.0/8', '192.00.2.1/24',
    '+192.0.2.1/24', '0xc0.0.2.1/24',
    'fe80::1%en0/64', '[2001:db8::1]/64',
    '2001::db8::1/64', '2001:db8:0:0:0:0:0:0:1/64', '2001:db8:0:0:0:0:1/64',
    '2001:db8::g/64', '2001:db8:::1/64', '2001:db8:00000::1/64',
    '::ffff:192.00.2.1/128', '::ffff:192.0.2.999/128', '192.0.2.1::/64',
    '192.0.2.0/24 extra-data',
  ])('rejects ambiguous or invalid network syntax: %s', (input) => {
    const result = analyzeNetworks(input);
    expect(result.networks).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 1, input });
    expect(result.issues[0].message.trim()).not.toBe('');
    expect(result.totalOverlaps).toBe(0);
  });

  it('retains valid analysis alongside invalid lines without renumbering evidence', () => {
    const result = analyzeNetworks('192.0.2.0/24\nnot-a-network # check me\n192.0.2.17/32');
    expect(result.networks.map(network => network.line)).toEqual([1, 3]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 2, input: 'not-a-network # check me' });
    expect(result.overlaps).toEqual([
      { leftLine: 1, rightLine: 3, kind: 'contains', sharedCidr: '192.0.2.17/32' },
    ]);
    expect(result.limitExceeded).toBe(false);
  });

  it('classifies containment relative to the first line and detects normalized duplicates', () => {
    const result = analyzeNetworks('192.0.2.128/25\n192.0.2.0/24\n192.0.2.17/24');
    expect(result.overlaps).toEqual([
      { leftLine: 1, rightLine: 2, kind: 'contained-by', sharedCidr: '192.0.2.128/25' },
      { leftLine: 1, rightLine: 3, kind: 'contained-by', sharedCidr: '192.0.2.128/25' },
      { leftLine: 2, rightLine: 3, kind: 'duplicate', sharedCidr: '192.0.2.0/24' },
    ]);
    expect(result.totalOverlaps).toBe(3);
  });

  it('keeps adjacent subnets and different address families disjoint', () => {
    const result = analyzeNetworks('192.0.2.0/25\n192.0.2.128/25\n2001:db8::/127\n2001:db8::2/127');
    expect(result.overlaps).toEqual([]);
    expect(result.totalOverlaps).toBe(0);
    expect(analyzeNetworks('0.0.0.0/0\n::/0').totalOverlaps).toBe(0);
  });

  it('handles containment at the highest IPv6 address without number precision loss', () => {
    const result = analyzeNetworks('::/0\nffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128');
    expect(result.overlaps).toEqual([
      { leftLine: 1, rightLine: 2, kind: 'contains', sharedCidr: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128' },
    ]);
  });

  it('matches an independent address-set oracle for every pair of a varied IPv4 corpus', () => {
    const inputs = Array.from({ length: 18 }, (_, index) => ({ host: (index * 37 + 17) % 256, prefix: 24 + index % 9 }));
    const memberships = inputs.map(({ host, prefix }) => {
      const blockSize = 2 ** (32 - prefix);
      return new Set(Array.from({ length: 256 }, (_, address) => address).filter(address => Math.floor(address / blockSize) === Math.floor(host / blockSize)));
    });
    const result = analyzeNetworks(inputs.map(({ host, prefix }) => `192.0.2.${host}/${prefix}`).join('\n'));
    expect(result.issues).toEqual([]);
    const expected = [];
    for (let left = 0; left < inputs.length; left++) {
      expect(result.networks[left].addressCount).toBe(String(memberships[left].size));
      for (let right = left + 1; right < inputs.length; right++) {
        const shared = [...memberships[left]].filter(address => memberships[right].has(address));
        if (shared.length === 0) {
          continue;
        }
        const smaller = memberships[left].size <= memberships[right].size ? left : right;
        expected.push({
          leftLine: left + 1,
          rightLine: right + 1,
          kind: memberships[left].size === memberships[right].size ? 'duplicate' : memberships[left].size > memberships[right].size ? 'contains' : 'contained-by',
          sharedCidr: `192.0.2.${Math.min(...shared)}/${inputs[smaller].prefix}`,
        });
      }
    }
    expect(result.overlaps).toEqual(expected);
    expect(result.totalOverlaps).toBe(expected.length);
    expect(result.truncated).toBe(false);
  });

  it('counts every overlap at the network limit while bounding displayed results', () => {
    const result = analyzeNetworks(Array.from({ length: 256 }, () => '192.0.2.1/32').join('\n'));
    expect(result.networks).toHaveLength(256);
    expect(result.totalOverlaps).toBe(256 * 255 / 2);
    expect(result.overlaps).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.limitExceeded).toBe(false);
    expect(new Set(result.overlaps.map(({ leftLine, rightLine }) => `${leftLine}:${rightLine}`)).size).toBe(200);
  });

  it('does not claim truncation when all overlapping pairs fit in the output limit', () => {
    const result = analyzeNetworks(Array.from({ length: 20 }, () => '::1/128').join('\n'));
    expect(result.totalOverlaps).toBe(190);
    expect(result.overlaps).toHaveLength(190);
    expect(result.truncated).toBe(false);
  });

  it('does not mark exactly 200 displayed overlaps as truncated', () => {
    const inputs = [...Array.from({ length: 20 }, () => '192.0.2.0/24'), ...Array.from({ length: 5 }, () => '198.51.100.0/24')];
    const result = analyzeNetworks(inputs.join('\n'));
    expect(result.totalOverlaps).toBe(200);
    expect(result.overlaps).toHaveLength(200);
    expect(result.truncated).toBe(false);
  });

  it('refuses calculation after 256 meaningful lines, including invalid entries', () => {
    const result = analyzeNetworks(['192.0.2.0/24', ...Array.from({ length: 256 }, () => 'invalid')].join('\n'));
    expect(result).toMatchObject({ limitExceeded: true, networks: [], overlaps: [], totalOverlaps: 0 });
    expect(result.issues).toHaveLength(1);
  });

  it('does not count comment and blank lines against the network limit', () => {
    const result = analyzeNetworks(`${'# comment\n\n'.repeat(300)}192.0.2.1/32`);
    expect(result.limitExceeded).toBe(false);
    expect(result.networks).toHaveLength(1);
    expect(result.networks[0].line).toBe(601);
  });

  it('enforces the character limit before attempting calculation', () => {
    expect(analyzeNetworks(`#${'x'.repeat(249999)}`).limitExceeded).toBe(false);
    const result = analyzeNetworks(`#${'x'.repeat(250000)}`);
    expect(result).toMatchObject({ limitExceeded: true, networks: [], overlaps: [], totalOverlaps: 0 });
    expect(result.issues).toHaveLength(1);
  });
});

describe('network overlap Markdown report', () => {
  it('marks partial validation as incomplete and includes its error evidence', () => {
    const analysis = analyzeNetworks('192.0.2.0/24\nnot-a-network\n192.0.2.128/25');
    const report = formatMarkdown(analysis);
    expect(report).toMatch(/incomplete/i);
    expect(report).toContain('not-a-network');
    expect(report).toContain(analysis.issues[0].message);
    expect(report).toContain('192.0.2.128/25');
  });

  it('distinguishes a limit refusal from a clean no-overlap result', () => {
    const report = formatMarkdown(analyzeNetworks(Array.from({ length: 257 }, () => '192.0.2.1/32').join('\n')));
    expect(report).toMatch(/not run|incomplete/i);
    expect(report).toMatch(/no overlap conclusion/i);
    expect(report).not.toContain('No overlaps were found');
    expect(report).toMatch(/limit|256/i);
  });

  it('reports the full pair count and the limited number displayed', () => {
    const report = formatMarkdown(analyzeNetworks(Array.from({ length: 22 }, () => '192.0.2.1/32').join('\n')));
    expect(report).toContain('231');
    expect(report).toContain('200');
    expect(report).toMatch(/truncat|show|display/i);
  });

  it('renders hostile labels and invalid inputs as text, not active Markdown or HTML', () => {
    const input = '192.0.2.0/24 # ![beacon](https://example.invalid/pixel) <img src=x onerror=alert(1)> | [owner](https://example.invalid)\n<script>alert(1)</script>';
    const report = formatMarkdown(analyzeNetworks(input));
    const html = new MarkdownIt({ html: true }).render(report);
    expect(html).not.toMatch(/<(?:img|script|a)\b/i);
    expect(html).toContain('beacon');
    expect(html).toContain('owner');
    expect(report).toMatch(/incomplete/i);
  });
});
