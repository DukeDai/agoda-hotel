import { AlertTriangle, ServerCrash, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

export interface ErrorPanelProps {
  title?: string;
  message: string;
  code?: string;
  action?: ReactNode;
  className?: string;
  variant?: 'error' | 'warning' | 'offline';
}

/** Generic inline error card used instead of a stack trace. */
export function ErrorPanel({
  title = '出错了',
  message,
  code,
  action,
  className,
  variant = 'error',
}: ErrorPanelProps) {
  const Icon = variant === 'offline' ? WifiOff : variant === 'warning' ? AlertTriangle : ServerCrash;
  const tone =
    variant === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : variant === 'offline'
        ? 'border-slate-200 bg-slate-50 text-slate-700'
        : 'border-rose-200 bg-rose-50 text-rose-800';

  return (
    <div className={cn('rounded-xl border p-5', tone, className)} role="alert">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-sm opacity-90">{message}</p>
          {code ? <p className="mt-2 font-mono text-xs opacity-70">{code}</p> : null}
          {action ? <div className="mt-4">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** The API is unreachable — the backend is not running. */
export function BackendDownPanel({ className }: { className?: string }) {
  return (
    <ErrorPanel
      variant="offline"
      title="后端未启动"
      message="无法连接到酒店预订服务（API）。请确认后端已在 3001 端口运行后重试。"
      className={className}
    />
  );
}

/** Friendly copy for the supplier errors the customer can act on. */
export function friendlyApiMessage(error: unknown): { title: string; message: string; code?: string } {
  if (isApiError(error)) {
    const apiError = error as ApiError;
    switch (apiError.code) {
      case 'PRICE_CHANGED':
        return {
          title: '价格已变动',
          message: withRaw(
            '供应商刚刚调整了价格，请确认最新价格后继续下单。',
            apiError.message,
          ),
          code: apiError.code,
        };
      case 'ROOM_UNAVAILABLE':
        return {
          title: '房型已售罄',
          message: withRaw(
            '很抱歉，所选房型在当前日期已订满，请返回选择其它房型或日期。',
            apiError.message,
          ),
          code: apiError.code,
        };
      case 'HOTEL_NOT_FOUND':
        return {
          title: '酒店暂不可用',
          message: withRaw(
            '该酒店尚未同步到我们的库存库，请稍后再试或更换酒店。',
            apiError.message,
          ),
          code: apiError.code,
        };
      case 'IDEMPOTENCY_CONFLICT':
        return {
          title: '请求重复',
          message: withRaw('相同的请求内容与不同的幂等键冲突，请稍后重试。', apiError.message),
          code: apiError.code,
        };
      default:
        break;
    }
    if (apiError.isBackendDown) {
      return {
        title: '后端未启动',
        message: '无法连接到酒店预订服务（API），请确认后端已启动后重试。',
        code: apiError.code,
      };
    }
    return {
      title: '请求失败',
      message: apiError.message,
      code: apiError.code,
    };
  }

  return {
    title: '请求失败',
    message: error instanceof Error ? error.message : '发生未知错误，请稍后重试。',
  };
}

/** Keep the API's own message next to our friendlier copy. */
function withRaw(friendly: string, raw: string): string {
  if (!raw || raw === friendly) return friendly;
  return `${friendly}（${raw}）`;
}
