import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
  },
  utilityProcess: {},
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@electron/utils/config', () => ({
  PORTS: { OPENCLAW_GATEWAY: 18789 },
}));

vi.mock('@electron/gateway/startup-orchestrator', () => ({
  runGatewayStartupSequence: vi.fn(async () => {
    throw new Error('startup unavailable in unit test');
  }),
}));

describe('GatewayManager gatewayReady fallback', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('sets gatewayReady=false when entering starting state', async () => {
    const { GatewayStateController } = await import('@electron/gateway/state');
    const controller = new GatewayStateController({ emitStatus: () => undefined });

    controller.setStatus({ state: 'running', connectedAt: Date.now(), gatewayReady: true });
    controller.setStatus({ state: 'starting' });

    expect(controller.getStatus().gatewayReady).toBe(false);
  });

  it('preserves gatewayReady=true when a running status update is merged', async () => {
    const { GatewayStateController } = await import('@electron/gateway/state');
    const controller = new GatewayStateController({ emitStatus: () => undefined });

    controller.setStatus({ state: 'running', connectedAt: Date.now() });
    controller.setStatus({ state: 'running', gatewayReady: true });

    expect(controller.getStatus().gatewayReady).toBe(true);
  });

  it('auto-sets gatewayReady=true after fallback RPC router probe succeeds', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const { GatewayManager } = await import('@electron/gateway/manager');
      const manager = new GatewayManager();
      const rpcSpy = vi.spyOn(manager as unknown as { rpc: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown> }, 'rpc')
        .mockResolvedValue({ ok: true });

      (manager as unknown as { setStatus: (u: Record<string, unknown>) => void }).setStatus({ state: 'running', connectedAt: Date.now() });

      const statusUpdates: Array<{ gatewayReady?: boolean }> = [];
      manager.on('status', (status: { gatewayReady?: boolean }) => {
        statusUpdates.push({ gatewayReady: status.gatewayReady });
      });

      (manager as unknown as { scheduleGatewayReadyFallback: () => void }).scheduleGatewayReadyFallback();
      await vi.advanceTimersByTimeAsync(1_500 + 5_000);

      expect(statusUpdates.find((u) => u.gatewayReady === true)).toBeDefined();
      expect(rpcSpy).toHaveBeenCalledWith('system-presence', {}, 5_000);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps gatewayReady=false when fallback RPC router probe fails', async () => {
    vi.resetModules();
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    vi.spyOn(manager as unknown as { rpc: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown> }, 'rpc')
      .mockRejectedValue(new Error('RPC timeout: system-presence'));

    (manager as unknown as { setStatus: (u: Record<string, unknown>) => void }).setStatus({ state: 'running', connectedAt: Date.now() });

    const statusUpdates: Array<{ gatewayReady?: boolean }> = [];
    manager.on('status', (status: { gatewayReady?: boolean }) => {
      statusUpdates.push({ gatewayReady: status.gatewayReady });
    });

    await (manager as unknown as { probeGatewayReadyFallback: () => Promise<void> }).probeGatewayReadyFallback();

    expect(statusUpdates.find((u) => u.gatewayReady === true)).toBeUndefined();
  });

  it('cancels fallback timer when gateway:ready event arrives first', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const { GatewayManager } = await import('@electron/gateway/manager');
      const manager = new GatewayManager();

      (manager as unknown as { setStatus: (u: Record<string, unknown>) => void }).setStatus({ state: 'running', connectedAt: Date.now() });

      const statusUpdates: Array<{ gatewayReady?: boolean }> = [];
      manager.on('status', (status: { gatewayReady?: boolean }) => {
        statusUpdates.push({ gatewayReady: status.gatewayReady });
      });

      (manager as unknown as { scheduleGatewayReadyFallback: () => void }).scheduleGatewayReadyFallback();

      await vi.advanceTimersByTimeAsync(5_000);
      manager.emit('gateway:ready', {});
      expect(statusUpdates.filter((u) => u.gatewayReady === true)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusUpdates.filter((u) => u.gatewayReady === true)).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
