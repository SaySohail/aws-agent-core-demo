import type { ToolName } from './definitions.js';
import { customerSupportGatewayTargetNames } from '@agent-launchpad/schemas';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const gatewayTargetNames: Readonly<Record<ToolName, string>> =
  customerSupportGatewayTargetNames;

export function gatewayToolName(name: ToolName): string {
  return `${gatewayTargetNames[name]}___${name}`;
}

export function expectedGatewayToolNames(): Readonly<Record<ToolName, string>> {
  return {
    get_order: gatewayToolName('get_order'),
    search_orders: gatewayToolName('search_orders'),
    create_support_ticket: gatewayToolName('create_support_ticket'),
    process_refund: gatewayToolName('process_refund')
  };
}
