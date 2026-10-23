import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('Dashboard monitoring', () => {
  test('shows live endpoint and channel health and supports manual refresh', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);
      await app.evaluate(({ ipcMain }) => {
        const calls = { gatewayHealth: 0, channelStatus: 0 };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__clawxDashboardMonitoring = calls;
        const originalHostInvoke = (ipcMain as unknown as {
          _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
        })._invokeHandlers?.get('host:invoke');
        const respond = (id: unknown, data: unknown) => ({
          id: typeof id === 'string' ? id : undefined,
          ok: true,
          data,
        });

        ipcMain.removeHandler('host:invoke');
        ipcMain.handle('host:invoke', async (event, request: { id?: string; module?: string; action?: string }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const current = (globalThis as any).__clawxDashboardMonitoring as typeof calls;
          if (request.module === 'gateway' && request.action === 'health') {
            current.gatewayHealth += 1;
            return respond(request.id, { ok: true, version: 'test-gateway' });
          }
          if (request.module === 'channels' && request.action === 'accounts') {
            current.channelStatus += 1;
            return respond(request.id, {
              success: true,
              channels: [
                {
                  channelType: 'telegram',
                  defaultAccountId: 'primary',
                  status: 'connected',
                  accounts: [
                    {
                      accountId: 'primary',
                      name: 'Primary account',
                      configured: true,
                      status: 'connected',
                      isDefault: true,
                    },
                    {
                      accountId: 'backup',
                      name: 'Backup account',
                      configured: true,
                      status: 'disconnected',
                      isDefault: false,
                    },
                  ],
                },
              ],
            });
          }
          return originalHostInvoke?.(event, request) ?? respond(request.id, {});
        });
      });

      await page.getByTestId('sidebar-nav-dashboard').click();
      await expect(page.getByTestId('monitoring-page')).toBeVisible();
      await expect(page.getByTestId('monitoring-gateway-endpoint').getByText('Healthy')).toBeVisible();
      await expect(page.getByTestId('monitoring-channels-endpoint').getByText('1 of 2 connected')).toBeVisible();
      await expect(page.getByText('Primary account')).toBeVisible();
      await expect(page.getByText('Backup account')).toBeVisible();
      await expect(page.getByTestId('monitoring-overall-status')).toHaveText('Service attention needed');
      await expect(page.getByTestId('monitoring-last-updated')).toContainText('Last updated');

      await page.getByTestId('monitoring-refresh').click();
      await expect.poll(async () => app.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const calls = (globalThis as any).__clawxDashboardMonitoring as { gatewayHealth: number; channelStatus: number };
        return calls.gatewayHealth;
      })).toBeGreaterThan(1);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('surfaces failed health probes instead of treating them as healthy', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);
      await app.evaluate(({ ipcMain }) => {
        const originalHostInvoke = (ipcMain as unknown as {
          _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
        })._invokeHandlers?.get('host:invoke');
        const respond = (id: unknown, data: unknown) => ({
          id: typeof id === 'string' ? id : undefined,
          ok: true,
          data,
        });

        ipcMain.removeHandler('host:invoke');
        ipcMain.handle('host:invoke', async (event, request: { id?: string; module?: string; action?: string }) => {
          if (request.module === 'gateway' && request.action === 'health') {
            return respond(request.id, { ok: false, error: 'Gateway probe failed' });
          }
          if (request.module === 'channels' && request.action === 'accounts') {
            return respond(request.id, { success: false, error: 'Channel status unavailable' });
          }
          return originalHostInvoke?.(event, request) ?? respond(request.id, {});
        });
      });

      await page.getByTestId('sidebar-nav-dashboard').click();
      await expect(page.getByTestId('monitoring-page')).toBeVisible();
      await expect(page.getByTestId('monitoring-gateway-endpoint').getByText('Unavailable')).toBeVisible();
      await expect(page.getByTestId('monitoring-gateway-endpoint').getByText('Gateway probe failed')).toBeVisible();
      await expect(page.getByTestId('monitoring-channels-endpoint').getByText('Unavailable')).toBeVisible();
      await expect(page.getByTestId('monitoring-channels-endpoint').getByText('Channel status unavailable')).toBeVisible();
      await expect(page.getByTestId('monitoring-overall-status').getByText('Service attention needed')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
