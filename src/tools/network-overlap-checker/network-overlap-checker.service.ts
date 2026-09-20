export interface Network {
  line: number
  label: string
  input: string
  cidr: string
  family: 4 | 6
  start: string
  end: string
  addressCount: string
  normalized: boolean
}

export interface InputIssue {
  line: number
  input: string
  message: string
}

export interface Overlap {
  leftLine: number
  rightLine: number
  kind: 'duplicate' | 'contains' | 'contained-by'
  sharedCidr: string
}

export interface Analysis {
  networks: Network[]
  issues: InputIssue[]
  overlaps: Overlap[]
  totalOverlaps: number
  truncated: boolean
  limitExceeded: boolean
}

interface ParsedNetwork {
  network: Network
  start: bigint
  end: bigint
  prefix: number
}

export const MAX_NETWORKS = 256;
export const MAX_DISPLAY_OVERLAPS = 200;
const MAX_INPUT_CHARACTERS = 250000;

function parseIpv4(address: string): bigint {
  const octets = address.split('.');
  if (octets.length !== 4 || octets.some(part => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error('Use four IPv4 octets from 0 to 255, without leading zeros.');
  }
  return octets.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

function parseIpv6(address: string): bigint {
  let expanded = address;
  if (expanded.includes('.')) {
    const separator = expanded.lastIndexOf(':');
    if (separator < 0) {
      throw new Error('An embedded IPv4 address must occupy the final 32 bits of IPv6.');
    }
    const tail = parseIpv4(expanded.slice(separator + 1));
    expanded = `${expanded.slice(0, separator + 1)}${(tail >> 16n).toString(16)}:${(tail & 65535n).toString(16)}`;
  }

  const compressed = expanded.split('::');
  if (compressed.length > 2) {
    throw new Error('An IPv6 address can contain only one :: compression.');
  }
  const left = compressed[0] === '' ? [] : compressed[0].split(':');
  const right = compressed.length === 2 && compressed[1] !== '' ? compressed[1].split(':') : [];
  const groups = [...left, ...right];
  if (groups.some(group => !/^[\da-f]{1,4}$/i.test(group))) {
    throw new Error('Use IPv6 hexadecimal groups of one to four digits.');
  }
  if ((compressed.length === 1 && left.length !== 8) || (compressed.length === 2 && groups.length >= 8)) {
    throw new Error('IPv6 requires eight groups; :: must replace at least one missing group.');
  }
  const filled = compressed.length === 2 ? [...left, ...Array<string>(8 - groups.length).fill('0'), ...right] : left;
  return filled.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function formatAddress(value: bigint, family: 4 | 6): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map(shift => ((value >> shift) & 255n).toString()).join('.');
  }
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 65535n));
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < groups.length; index++) {
    if (groups[index] !== 0) {
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) {
      end++;
    }
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end - 1;
  }
  const hex = groups.map(group => group.toString(16));
  if (bestStart === -1) {
    return hex.join(':');
  }
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

function parseNetwork(raw: string, line: number): ParsedNetwork {
  const comment = raw.indexOf('#');
  const input = (comment === -1 ? raw : raw.slice(0, comment)).trim();
  const label = comment === -1 ? '' : raw.slice(comment + 1).trim();
  const parts = input.split('/');
  if (parts.length !== 2 || !/^(?:0|[1-9]\d*)$/.test(parts[1])) {
    throw new Error('Provide an explicit decimal CIDR prefix, such as 192.0.2.0/24 or 2001:db8::/32.');
  }
  const address = parts[0];
  if (/[\s%\[\]]/.test(address)) {
    throw new Error('Use an IP address without spaces, zone identifiers, or brackets.');
  }
  const family = address.includes(':') ? 6 : 4;
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix > bits) {
    throw new Error(`IPv${family} prefixes must be between 0 and ${bits}.`);
  }
  const value = family === 4 ? parseIpv4(address) : parseIpv6(address);
  const hostBits = BigInt(bits - prefix);
  const start = (value >> hostBits) << hostBits;
  const count = 1n << hostBits;
  const end = start + count - 1n;
  const first = formatAddress(start, family);
  return {
    start,
    end,
    prefix,
    network: {
      line,
      label,
      input,
      family,
      cidr: `${first}/${prefix}`,
      start: first,
      end: formatAddress(end, family),
      addressCount: count.toString(),
      normalized: value !== start,
    },
  };
}

export function analyzeNetworks(text: string): Analysis {
  const analysis: Analysis = {
    networks: [], issues: [], overlaps: [], totalOverlaps: 0, truncated: false, limitExceeded: false,
  };
  if (text.length > MAX_INPUT_CHARACTERS) {
    analysis.limitExceeded = true;
    analysis.issues.push({ line: 1, input: '', message: `Input exceeds ${MAX_INPUT_CHARACTERS.toLocaleString('en-US')} characters. No networks were analyzed.` });
    return analysis;
  }
  const entries = text.split(/\r\n?|\n/)
    .map((input, index) => ({ input, line: index + 1 }))
    .filter(({ input }) => input.trim() !== '' && !input.trimStart().startsWith('#'));
  if (entries.length > MAX_NETWORKS) {
    analysis.limitExceeded = true;
    analysis.issues.push({
      line: entries[MAX_NETWORKS].line,
      input: entries[MAX_NETWORKS].input,
      message: `Input contains more than ${MAX_NETWORKS} non-comment entries. No networks were analyzed.`,
    });
    return analysis;
  }
  const parsed: ParsedNetwork[] = [];
  for (const entry of entries) {
    try {
      parsed.push(parseNetwork(entry.input, entry.line));
    }
    catch (error) {
      analysis.issues.push({ ...entry, message: error instanceof Error ? error.message : 'Invalid CIDR notation.' });
    }
  }
  analysis.networks = parsed.map(item => item.network);
  for (let leftIndex = 0; leftIndex < parsed.length; leftIndex++) {
    const left = parsed[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < parsed.length; rightIndex++) {
      const right = parsed[rightIndex];
      if (left.network.family !== right.network.family || left.end < right.start || right.end < left.start) {
        continue;
      }
      analysis.totalOverlaps++;
      if (analysis.overlaps.length >= MAX_DISPLAY_OVERLAPS) {
        continue;
      }
      let kind: Overlap['kind'] = 'contained-by';
      if (left.start === right.start && left.end === right.end) {
        kind = 'duplicate';
      }
      else if (left.start <= right.start && left.end >= right.end) {
        kind = 'contains';
      }
      analysis.overlaps.push({
        leftLine: left.network.line,
        rightLine: right.network.line,
        kind,
        sharedCidr: left.prefix >= right.prefix ? left.network.cidr : right.network.cidr,
      });
    }
  }
  analysis.truncated = analysis.totalOverlaps > analysis.overlaps.length;
  return analysis;
}

function markdownCell(value: string): string {
  const plain = [...value].map(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('');
  return plain
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()|~#!])/g, '\\$1');
}

export function formatMarkdown(analysis: Analysis): string {
  const lines = ['# Network overlap review', ''];
  if (analysis.limitExceeded) {
    lines.push('Analysis was not run because an input limit was exceeded. No overlap conclusion can be drawn.');
  }
  else if (analysis.issues.length > 0) {
    lines.push(`Analysis is incomplete: ${analysis.issues.length} invalid input line(s) were excluded. Resolve these issues before drawing a conclusion.`);
    lines.push(`${analysis.networks.length} valid network(s) were analyzed; ${analysis.totalOverlaps} overlapping pair(s) were found among those entries only.`);
  }
  else if (analysis.networks.length === 0) {
    lines.push('No network entries were provided. No overlap conclusion can be drawn.');
  }
  else {
    lines.push(`${analysis.networks.length} valid network(s) were analyzed; ${analysis.totalOverlaps} overlapping pair(s) were found.`);
    if (analysis.totalOverlaps === 0) {
      lines.push('No overlaps were found among the submitted networks.');
    }
  }
  lines.push('', 'This is an address-range comparison only. It does not scan networks or verify routing, ownership, or reachability. IPv4 and IPv6 are compared separately.');
  if (analysis.issues.length > 0) {
    lines.push('', '## Input issues', '', '| Line | Input | Issue |', '| --- | --- | --- |');
    for (const issue of analysis.issues) {
      lines.push(`| ${issue.line} | ${markdownCell(issue.input)} | ${markdownCell(issue.message)} |`);
    }
  }
  if (analysis.networks.length > 0) {
    lines.push('', '## Networks', '', '| Line | Label | Input | Network | First address | Last address | Address count | Host bits cleared |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const network of analysis.networks) {
      lines.push(`| ${network.line} | ${markdownCell(network.label)} | ${markdownCell(network.input)} | ${network.cidr} | ${network.start} | ${network.end} | ${network.addressCount} | ${network.normalized ? 'Yes' : 'No'} |`);
    }
    lines.push('', 'Address counts include every address in each CIDR range; they are not counts of usable hosts.');
  }
  if (analysis.overlaps.length > 0) {
    lines.push('', '## Overlaps', '');
    if (analysis.truncated) {
      lines.push(`Showing ${analysis.overlaps.length} of ${analysis.totalOverlaps} overlapping pairs. The displayed list is truncated.`, '');
    }
    lines.push('| Left line | Relationship to right line | Right line | Shared network |', '| --- | --- | --- | --- |');
    for (const overlap of analysis.overlaps) {
      const relationship = { 'duplicate': 'duplicates', 'contains': 'contains', 'contained-by': 'is contained by' }[overlap.kind];
      lines.push(`| ${overlap.leftLine} | ${relationship} | ${overlap.rightLine} | ${overlap.sharedCidr} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
