import { RouterOutlined } from '@vicons/material';
import { defineTool } from '../tool';
import { translate } from '@/plugins/i18n.plugin';

export const tool = defineTool({
  name: translate('tools.network-overlap-checker.title'),
  path: '/network-overlap-checker',
  description: translate('tools.network-overlap-checker.description'),
  keywords: ['network', 'subnet', 'overlap', 'conflict', 'cidr', 'ipv4', 'ipv6', 'vpn', 'vpc', 'vlan'],
  component: () => import('./network-overlap-checker.vue'),
  icon: RouterOutlined,
});
