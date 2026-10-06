import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { AUDIT_ACTIONS, type AuditOutcome } from '@faultline/auth';
import { catchError, from, mergeMap, type Observable } from 'rxjs';
import { AuditTrail } from './audit-trail';
import type { RequestWithUser } from './context';

type HttpResponse = { statusCode?: number };

/**
 * Records every authenticated HTTP request, including read-only activity.
 *
 * Controllers continue to write descriptive domain events such as `user.created` or
 * `incident.acknowledged`. This interceptor supplies the exhaustive request-level
 * trail around those events so reads and otherwise uneventful actions are not gaps.
 * Bodies, headers and query strings are deliberately excluded because they can contain
 * passwords, session credentials, reset tokens and customer data.
 */
@Injectable()
export class UserActivityAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditTrail) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();
    const response = http.getResponse<HttpResponse>();
    const user = request.user;
    if (!user) return next.handle();

    const startedAt = Date.now();
    return next.handle().pipe(
      // Handle controller failures before the success audit stage. This ordering keeps
      // an audit-storage failure from being mistaken for a denied user request.
      catchError((error: unknown) => {
        const statusCode = httpStatus(error, response.statusCode);
        return from(
          this.record(request, statusCode, 'denied', startedAt).then(() => {
            throw error;
          }),
        );
      }),
      mergeMap((value) =>
        from(
          this.record(
            request,
            response.statusCode ?? 200,
            'allowed',
            startedAt,
          ).then(() => value),
        ),
      ),
    );
  }

  private record(
    request: RequestWithUser,
    statusCode: number,
    outcome: AuditOutcome,
    startedAt: number,
  ): Promise<void> {
    const path = (request.originalUrl ?? request.url ?? '/').split('?')[0] || '/';
    return this.audit.record({
      user: request.user!,
      action: AUDIT_ACTIONS.USER_ACTIVITY,
      resourceType: 'api-request',
      resourceId: path,
      outcome,
      request,
      metadata: {
        method: (request.method ?? 'UNKNOWN').toUpperCase(),
        statusCode,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    });
  }
}

function httpStatus(error: unknown, fallback = 500): number {
  if (error && typeof error === 'object') {
    const candidate = error as { getStatus?: () => unknown; status?: unknown };
    const status = candidate.getStatus?.() ?? candidate.status;
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  return fallback >= 400 ? fallback : 500;
}
