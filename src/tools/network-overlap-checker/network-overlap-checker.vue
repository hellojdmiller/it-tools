<script setup lang="ts">
import { MAX_NETWORKS, analyzeNetworks, formatMarkdown } from './network-overlap-checker.service';
import { useCopy } from '@/composable/copy';
import { useAppTheme } from '@/ui/theme/themes';

const example = `10.42.0.0/16 # Primary VPC
10.42.8.0/24 # Branch VPN
10.42.8.19/24 # Proposed VLAN
2001:db8:42::/48 # IPv6 allocation
2001:db8:42:100::/56 # New IPv6 segment`;

// Keep network plans in memory only: no URL parameters or browser storage.
const input = ref(example);
const analysis = computed(() => analyzeNetworks(input.value));
const byLine = computed(() => new Map(analysis.value.networks.map(network => [network.line, network])));
const normalizedCount = computed(() => analysis.value.networks.filter(network => network.normalized).length);
const theme = useAppTheme();
const { copy } = useCopy();
const message = useMessage();
const hasReport = computed(() => analysis.value.networks.length > 0 || analysis.value.issues.length > 0);
const report = computed(() => formatMarkdown(analysis.value));
const summary = computed(() => {
  const { networks, totalOverlaps, issues, limitExceeded } = analysis.value;
  if (limitExceeded) {
    return 'Input limit reached. No ranges were compared.';
  }
  if (issues.length > 0) {
    return `Incomplete review: ${issues.length} invalid ${issues.length === 1 ? 'line' : 'lines'}.`;
  }
  if (networks.length < 2) {
    return 'Add at least two subnets to compare.';
  }
  return totalOverlaps > 0
    ? `${totalOverlaps} overlapping ${totalOverlaps === 1 ? 'pair' : 'pairs'} to review`
    : 'No overlaps found among these subnets.';
});

async function copyReport() {
  try {
    await copy(report.value);
  }
  catch {
    message.error('Could not copy the report. Download it instead.');
  }
}

function downloadReport(format: 'md' | 'json') {
  const content = format === 'md'
    ? report.value
    : JSON.stringify({ schemaVersion: 1, ...analysis.value }, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `network-overlap-report.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <div class="overlap-checker">
    <div class="input-toolbar">
      <span>IPv4 + IPv6 · Up to {{ MAX_NETWORKS }} subnets</span>
      <div class="actions">
        <n-button size="small" @click="input = example">
          Load example
        </n-button>
        <n-button size="small" :disabled="!input" @click="input = ''">
          Clear
        </n-button>
      </div>
    </div>
    <c-input-text
      v-model:value="input"
      label="Subnets to compare"
      placeholder="10.42.0.0/16 # Primary VPC"

      raw-text multiline monospace
      :rows="7"
      test-id="network-input"
    />
    <p class="input-help">
      One CIDR per line. Add an optional name after #. Compared in your browser; input is not saved.
      <span v-if="input === example">These are example subnets.</span>
    </p>

    <section class="review-summary" aria-label="Review status">
      <h2 role="status" aria-live="polite">
        {{ summary }}
      </h2>
      <p v-if="analysis.networks.length">
        {{ analysis.networks.length }} valid subnets.
        <span v-if="analysis.issues.length">Results below cover valid lines only.</span>
        <span v-if="normalizedCount">{{ normalizedCount }} {{ normalizedCount === 1 ? 'entry was' : 'entries were' }} aligned to its network boundary; see range details.</span>
      </p>
      <p v-if="analysis.totalOverlaps">
        Containment may be intentional. Review each pair in the context of your routing plan.
      </p>
    </section>

    <ul v-if="analysis.issues.length" class="issues" aria-label="Input errors">
      <li v-for="issue in analysis.issues" :key="issue.line">
        <strong>{{ issue.line ? `Line ${issue.line}: ` : '' }}</strong>{{ issue.message }}
        <code v-if="issue.input">{{ issue.input }}</code>
      </li>
    </ul>

    <div v-if="analysis.overlaps.length" class="pairs" aria-label="Overlapping subnet pairs">
      <article v-for="pair in analysis.overlaps" :key="`${pair.leftLine}-${pair.rightLine}`" class="pair">
        <div class="pair-ranges">
          <div class="range">
            <span class="range-label">{{ byLine.get(pair.leftLine)?.label || `Subnet on line ${pair.leftLine}` }}</span>
            <code>{{ byLine.get(pair.leftLine)?.cidr }}</code>
            <small>Line {{ pair.leftLine }}</small>
          </div>
          <span class="relationship">{{ pair.kind === 'duplicate' ? 'same range' : pair.kind === 'contains' ? 'contains' : 'within' }}</span>
          <div class="range">
            <span class="range-label">{{ byLine.get(pair.rightLine)?.label || `Subnet on line ${pair.rightLine}` }}</span>
            <code>{{ byLine.get(pair.rightLine)?.cidr }}</code>
            <small>Line {{ pair.rightLine }}</small>
          </div>
        </div>
        <div class="shared-range">
          Shared address range <code>{{ pair.sharedCidr }}</code>
        </div>
      </article>
    </div>
    <n-alert v-if="analysis.truncated" type="warning" class="limit-note">
      Showing {{ analysis.overlaps.length }} of {{ analysis.totalOverlaps }} pairs. Downloads have the same limit.
      Split your input into smaller lists to inspect the remaining pairs.
    </n-alert>

    <details v-if="analysis.networks.length" class="network-details">
      <summary>Range details ({{ analysis.networks.length }})</summary>
      <article v-for="network in analysis.networks" :key="network.line" class="network-detail">
        <strong>Line {{ network.line }}{{ network.label ? ` · ${network.label}` : '' }}</strong>
        <code>{{ network.cidr }}</code>
        <p v-if="network.normalized" class="normalization">
          Input {{ network.input }} contained host bits. Compared as {{ network.cidr }}.
        </p>
        <dl>
          <dt>First address</dt><dd>{{ network.start }}</dd>
          <dt>Last address</dt><dd>{{ network.end }}</dd>
          <dt>Total addresses</dt><dd>{{ network.addressCount }}</dd>
        </dl>
      </article>
      <p class="input-help">
        Address counts include every address in the block, including IPv4 network and broadcast addresses.
        IPv4 and IPv6 are compared separately, including IPv4-mapped IPv6.
      </p>
    </details>

    <div class="export-actions">
      <n-button type="primary" :disabled="!hasReport" @click="copyReport">
        Copy report
      </n-button>
      <n-button :disabled="!hasReport" @click="downloadReport('md')">
        Download Markdown
      </n-button>
      <n-button :disabled="!hasReport" @click="downloadReport('json')">
        Download JSON
      </n-button>
    </div>
  </div>
</template>

<style lang="less" scoped>
.overlap-checker {
  min-width: 0;
  color: v-bind('theme.text.baseColor');
}
.input-toolbar, .actions, .export-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.input-toolbar {
  justify-content: space-between;
  margin-bottom: 16px;
  font-size: 13px;
}
.input-help, .review-summary p {
  font-size: 13px;
  line-height: 1.6;
  margin: 8px 0;
}
.input-help span {
  display: block;
}
.review-summary {
  margin: 26px 0 18px;
  h2 {
    font-size: 21px;
    font-weight: 600;
    line-height: 1.4;
    margin: 0 0 6px;
  }
}
.issues {
  border-left: 3px solid v-bind('theme.error.color');
  padding: 12px 12px 12px 28px;
  background: v-bind('theme.error.colorFaded');
  li + li { margin-top: 12px; }
  code { display: block; }
}
code, dd, .range-label {
  overflow-wrap: anywhere;
}
.pairs {
  display: grid;
  gap: 12px;
}
.pair {
  border: 1px solid v-bind('theme.default.colorPressed');
  border-left: 3px solid v-bind('theme.warning.color');
  border-radius: 4px;
  overflow: hidden;
}
.pair-ranges {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 16px;
  align-items: center;
  padding: 16px;
}
.range {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  small { opacity: 0.75; }
}
.range-label { font-weight: 600; }
.relationship {
  font-size: 12px;
  border-radius: 3px;
  padding: 3px 7px;
  background: v-bind('theme.warning.colorFaded');
}
.shared-range {
  padding: 8px 16px;
  font-size: 12px;
  background: v-bind('theme.default.color');
  code { margin-left: 6px; }
}
.network-details {
  margin: 24px 0;
  summary { cursor: pointer; padding: 8px 0; font-weight: 600; }
  summary:focus-visible { outline: 2px solid v-bind('theme.primary.color'); outline-offset: 4px; }
}
.network-detail {
  padding: 16px 0;
  border-top: 1px solid v-bind('theme.default.colorPressed');
  > code { display: block; margin-top: 4px; }
  dl { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 4px 12px; font-size: 12px; }
  dd { margin: 0; font-family: monospace; }
}
.normalization { font-size: 13px; }
.export-actions { margin-top: 24px; }
.limit-note { margin-top: 16px; }
@media (max-width: 540px) {
  .pair-ranges { grid-template-columns: 1fr; gap: 10px; }
  .relationship { justify-self: start; }
  .export-actions > * { flex: 1 1 auto; }
}
</style>
