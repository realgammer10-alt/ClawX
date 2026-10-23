import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, AlertCircle, CheckCircle2, CircleDashed, Clock3, RefreshCw, Server, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { hostApi, type ChannelGroupItem } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';

type CheckState = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
type EndpointCheck = {
  state: CheckState;
  checkedAt: number;
  durationMs: number;
  detail?: string;
};

const REFRESH_INTERVAL_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusClasses(state: CheckState): string {
  switch (state) {
    case 'healthy':
      return 'text-green-700 dark:text-green-400';
    case 'degraded':
      return 'text-amber-700 dark:text-amber-400';
    case 'unavailable':
      return 'text-red-700 dark:text-red-400';
    case 'unknown':
      return 'text-foreground/60';
  }
}

function StatusIcon({ state }: { state: CheckState }) {
  if (state === 'healthy') return <CheckCircle2 className="h-4 w-4" />;
  if (state === 'unknown') return <CircleDashed className="h-4 w-4" />;
  return <AlertCircle className="h-4 w-4" />;
}

function channelState(status: ChannelGroupItem['status']): CheckState {
  if (status === 'connected') return 'healthy';
  if (status === 'connecting' || status === 'degraded') return 'degraded';
  return 'unavailable';
}

export function Dashboard() {
  const { t } = useTranslation('dashboard');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [gatewayCheck, setGatewayCheck] = useState<EndpointCheck>({ state: 'unknown', checkedAt: 0, durationMs: 0 });
  const [channelsCheck, setChannelsCheck] = useState<EndpointCheck>({ state: 'unknown', checkedAt: 0, durationMs: 0 });
  const [channels, setChannels] = useState<ChannelGroupItem[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const mountedRef = useRef(false);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (mountedRef.current) setIsRefreshing(true);

    const [gatewayResult, channelsResult] = await Promise.all([
      (async (): Promise<EndpointCheck> => {
        const startedAt = performance.now();
        try {
          const health = await hostApi.gateway.health(true);
          const capabilities = health.capabilities;
          const hasDegradedCapability = Boolean(capabilities && (
            capabilities.core.rpcRouter === 'blocked'
            || Object.values({
              health: capabilities.openclawHealth,
              status: capabilities.openclawStatus,
              presence: capabilities.presence,
              channels: capabilities.channels,
              memory: capabilities.memory,
            }).some((capability) => capability.state === 'degraded')
          ));
          return {
            state: health.ok !== true ? 'unavailable' : hasDegradedCapability ? 'degraded' : 'healthy',
            checkedAt: Date.now(),
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            detail: health.ok === true ? health.version : health.error || t('monitoring.endpointRequestFailed'),
          };
        } catch (error) {
          return {
            state: 'unavailable',
            checkedAt: Date.now(),
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            detail: errorMessage(error),
          };
        }
      })(),
      (async (): Promise<{ check: EndpointCheck; channels: ChannelGroupItem[] }> => {
        const startedAt = performance.now();
        try {
          const response = await hostApi.channels.accounts({ mode: 'runtime', probe: true });
          if (response.success !== true || !Array.isArray(response.channels)) {
            return {
              check: {
                state: 'unavailable',
                checkedAt: Date.now(),
                durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
                detail: response.error || t('monitoring.endpointRequestFailed'),
              },
              channels: [],
            };
          }

          const accounts = response.channels.flatMap((channel) => channel.accounts);
          const connected = accounts.filter((account) => account.status === 'connected').length;
          const configured = accounts.filter((account) => account.configured).length;
          const gatewayDegraded = response.gatewayHealth?.state === 'degraded'
            || response.gatewayHealth?.state === 'unresponsive';
          return {
            check: {
              state: gatewayDegraded ? 'degraded' : 'healthy',
              checkedAt: Date.now(),
              durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
              detail: t('monitoring.connectedOf', { connected, total: configured }),
            },
            channels: response.channels,
          };
        } catch (error) {
          return {
            check: {
              state: 'unavailable',
              checkedAt: Date.now(),
              durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
              detail: errorMessage(error),
            },
            channels: [],
          };
        }
      })(),
    ]);

    if (mountedRef.current) {
      setGatewayCheck(gatewayResult);
      setChannelsCheck(channelsResult.check);
      if (channelsResult.check.state === 'healthy') setChannels(channelsResult.channels);
      setLastUpdatedAt(Date.now());
      setIsRefreshing(false);
    }
    inFlightRef.current = false;
  }, [t]);

  useEffect(() => {
    mountedRef.current = true;
    const initialTimer = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const gatewayEndpointState = gatewayCheck.state;
  const accounts = channels.flatMap((channel) =>
    channel.accounts.map((account) => ({
      channelType: channel.channelType,
      account,
    })),
  );
  const hasChannelIssues = accounts.some(({ account }) =>
    account.configured && account.status !== 'connected',
  );
  const overallState: CheckState = gatewayStatus.state !== 'running'
    || gatewayEndpointState === 'unavailable'
    || channelsCheck.state === 'unavailable'
    ? 'unavailable'
    : gatewayEndpointState === 'degraded' || channelsCheck.state === 'degraded' || hasChannelIssues
      ? 'degraded'
      : gatewayEndpointState === 'healthy' && channelsCheck.state === 'healthy'
        ? 'healthy'
        : 'unknown';

  const gatewayStateLabel = gatewayStatus.state === 'running'
    ? t('monitoring.gatewayRunning')
    : gatewayStatus.state === 'starting' || gatewayStatus.state === 'reconnecting'
      ? t('monitoring.gatewayStarting')
      : gatewayStatus.state === 'error'
        ? t('monitoring.gatewayError')
        : t('monitoring.gatewayStopped');

  const overallLabel = overallState === 'healthy'
    ? t('monitoring.overallHealthy')
    : overallState === 'unknown'
      ? t('monitoring.waitingForChecks')
      : t('monitoring.attentionNeeded');

  const renderEndpoint = (id: string, title: string, check: EndpointCheck, icon: ReactNode) => (
    <Card data-testid={id} className="border-black/10 bg-surface-modal shadow-none dark:border-white/10">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          {icon}
          {title}
        </CardTitle>
        <CardDescription className={cn('flex items-center gap-2', statusClasses(check.state))}>
          <StatusIcon state={check.state} />
          {t(`monitoring.${check.state}`)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-foreground/70">
        {check.detail && <p className="break-words">{check.detail}</p>}
        <p>{t('monitoring.responseTime', { duration: check.durationMs })}</p>
        <p>
          {t('monitoring.lastChecked')}:{' '}
          {check.checkedAt ? new Date(check.checkedAt).toLocaleTimeString() : t('monitoring.neverChecked')}
        </p>
      </CardContent>
    </Card>
  );

  return (
    <div data-testid="monitoring-page" className="flex h-[calc(100vh-2.5rem)] flex-col overflow-hidden -m-6 dark:bg-background">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col p-8 pt-12 md:p-10 md:pt-16">
        <header className="mb-8 flex shrink-0 flex-col justify-between gap-4 md:flex-row md:items-start">
          <div>
            <h1 className="mb-3 font-serif text-5xl font-normal tracking-tight text-foreground md:text-6xl">
              {t('monitoring.title')}
            </h1>
            <p className="text-subtitle font-medium text-foreground/70">{t('monitoring.subtitle')}</p>
          </div>
          <Button
            data-testid="monitoring-refresh"
            variant="outline"
            disabled={isRefreshing}
            onClick={() => void refresh()}
            className="h-9 self-start rounded-full border-black/10 bg-transparent px-4 text-meta font-medium text-foreground/80 shadow-none transition-colors hover:bg-black/5 hover:text-foreground dark:border-white/10 dark:hover:bg-white/5 md:mt-2"
          >
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
            {isRefreshing ? t('monitoring.refreshing') : t('monitoring.refresh')}
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-8 pr-1">
          <Card className="border-black/10 bg-surface-modal shadow-none dark:border-white/10">
            <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className={cn('flex h-10 w-10 items-center justify-center rounded-full bg-black/5 dark:bg-white/10', statusClasses(overallState))}>
                  <Activity className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm text-foreground/60">{t('monitoring.overview')}</p>
                  <p data-testid="monitoring-overall-status" className={cn('font-medium', statusClasses(overallState))}>
                    {overallLabel}
                  </p>
                </div>
              </div>
              <p data-testid="monitoring-last-updated" className="text-sm text-foreground/60">
                {t('monitoring.lastUpdated', {
                  time: lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString() : t('monitoring.neverChecked'),
                })}
              </p>
            </CardContent>
          </Card>

          <section aria-labelledby="monitoring-gateway-heading">
            <h2 id="monitoring-gateway-heading" className="mb-3 font-serif text-2xl font-normal tracking-tight">
              {t('monitoring.gateway')}
            </h2>
            <Card className="border-black/10 bg-surface-modal shadow-none dark:border-white/10">
              <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
                <div className={cn('flex items-center gap-2 font-medium', statusClasses(gatewayStatus.state === 'running' ? 'healthy' : 'unavailable'))}>
                  <StatusIcon state={gatewayStatus.state === 'running' ? 'healthy' : 'unavailable'} />
                  <span data-testid="monitoring-gateway-state">{gatewayStateLabel}</span>
                </div>
                <span className="flex items-center gap-2 text-sm text-foreground/70">
                  <Server className="h-4 w-4" />
                  {t('monitoring.port', { port: gatewayStatus.port })}
                </span>
                {gatewayStatus.pid !== undefined && (
                  <span className="flex items-center gap-2 text-sm text-foreground/70">
                    <Wifi className="h-4 w-4" />
                    {t('monitoring.pid', { pid: gatewayStatus.pid })}
                  </span>
                )}
                {gatewayStatus.state === 'running' && (
                  <Badge variant={gatewayStatus.gatewayReady ? 'default' : 'secondary'}>
                    {gatewayStatus.gatewayReady ? t('monitoring.gatewayReady') : t('monitoring.gatewayNotReady')}
                  </Badge>
                )}
                {gatewayStatus.error && <p className="w-full break-words text-sm text-red-700 dark:text-red-400">{gatewayStatus.error}</p>}
              </CardContent>
            </Card>
          </section>

          <section aria-labelledby="monitoring-endpoints-heading">
            <h2 id="monitoring-endpoints-heading" className="mb-3 font-serif text-2xl font-normal tracking-tight">
              {t('monitoring.endpointsTitle')}
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              {renderEndpoint(
                'monitoring-gateway-endpoint',
                t('monitoring.gatewayHealthEndpoint'),
                gatewayCheck,
                <Activity className="h-4 w-4 text-foreground/60" />,
              )}
              {renderEndpoint(
                'monitoring-channels-endpoint',
                t('monitoring.channelStatusEndpoint'),
                channelsCheck,
                <Clock3 className="h-4 w-4 text-foreground/60" />,
              )}
            </div>
          </section>

          <section aria-labelledby="monitoring-channels-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="monitoring-channels-heading" className="font-serif text-2xl font-normal tracking-tight">
                {t('monitoring.channelsTitle')}
              </h2>
              <span className="text-sm text-foreground/60">
                {t('monitoring.connectedOf', {
                  connected: accounts.filter(({ account }) => account.status === 'connected').length,
                  total: accounts.filter(({ account }) => account.configured).length,
                })}
              </span>
            </div>
            {channelsCheck.state === 'unavailable' && accounts.length > 0 && (
              <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">{t('monitoring.staleChannels')}</p>
            )}
            <Card className="border-black/10 bg-surface-modal shadow-none dark:border-white/10">
              <CardContent className="p-0">
                {accounts.length === 0 ? (
                  <p className="p-5 text-sm text-foreground/60">{t('monitoring.noChannels')}</p>
                ) : (
                  <ul className="divide-y divide-black/5 dark:divide-white/10">
                    {accounts.map(({ channelType, account }) => {
                      const state = channelState(account.status);
                      return (
                        <li key={`${channelType}:${account.accountId}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                          <div>
                            <p className="font-medium">{account.name || channelType}</p>
                            <p className="text-xs text-foreground/60">{channelType} · {account.accountId}</p>
                            {account.lastError && <p className="mt-1 break-words text-xs text-red-700 dark:text-red-400">{account.lastError}</p>}
                          </div>
                          <span className={cn('flex items-center gap-2 text-sm', statusClasses(state))}>
                            <StatusIcon state={state} />
                            {t(`monitoring.channelStates.${account.status}`)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
