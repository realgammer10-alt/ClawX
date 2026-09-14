import { describe, expect, it } from 'vitest';
import {
  classifyHistoryStartupRetryError,
  shouldRetryStartupHistoryLoad,
} from '@/stores/chat/history-startup-retry';

describe('history startup retry classification', () => {
  it('treats dotted and colon chat history timeout names as retryable timeouts', () => {
    expect(classifyHistoryStartupRetryError(new Error('RPC timeout: chat.history'))).toBe('timeout');
    expect(classifyHistoryStartupRetryError(new Error('RPC timeout: chat:history'))).toBe('timeout');
    expect(classifyHistoryStartupRetryError(new Error('Gateway RPC timeout: chat:history'))).toBe('timeout');
    expect(classifyHistoryStartupRetryError(new Error('Gateway WS timeout: chat:history'))).toBe('timeout');
  });

  it('retries while the gateway is running but still not ready for RPCs', () => {
    expect(shouldRetryStartupHistoryLoad({ state: 'running', port: 18789, connectedAt: Date.now(), gatewayReady: false }, 'timeout')).toBe(true);
    expect(shouldRetryStartupHistoryLoad({ state: 'running', port: 18789, connectedAt: Date.now(), gatewayReady: true }, 'timeout')).toBe(true);
    expect(shouldRetryStartupHistoryLoad({ state: 'running', port: 18789, connectedAt: Date.now() - 120_000, gatewayReady: true }, 'gateway_unavailable')).toBe(false);
  });
});
