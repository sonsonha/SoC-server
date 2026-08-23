/** Safe Google Calendar / OAuth errors — never include tokens or secrets. */

export type GoogleCalendarErrorCode =
  | 'GOOGLE_NOT_CONNECTED'
  | 'GOOGLE_RECONNECT_REQUIRED'
  | 'GOOGLE_FORBIDDEN'
  | 'GOOGLE_NOT_FOUND'
  | 'GOOGLE_CONFLICT'
  | 'GOOGLE_RATE_LIMITED'
  | 'GOOGLE_UPSTREAM'
  | 'GOOGLE_BAD_REQUEST'
  | 'GOOGLE_UNKNOWN';

export class GoogleCalendarError extends Error {
  readonly name = 'GoogleCalendarError';

  constructor(
    message: string,
    readonly code: GoogleCalendarErrorCode,
    readonly options: {
      statusCode: number;
      googleStatus?: number;
      reason?: string;
      operation?: string;
      timeBlockId?: string;
      hasGoogleEventId?: boolean;
    },
  ) {
    super(message);
  }

  get statusCode(): number {
    return this.options.statusCode;
  }

  get googleStatus(): number | undefined {
    return this.options.googleStatus;
  }

  get reason(): string | undefined {
    return this.options.reason;
  }

  get operation(): string | undefined {
    return this.options.operation;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      googleStatus: this.googleStatus ?? null,
      reason: this.reason ?? null,
      operation: this.operation ?? null,
    };
  }

  toLogFields() {
    return {
      code: this.code,
      googleStatus: this.googleStatus ?? null,
      reason: this.reason ?? null,
      operation: this.operation ?? null,
      timeBlockId: this.options.timeBlockId ?? null,
      hasGoogleEventId: this.options.hasGoogleEventId ?? null,
    };
  }
}

export function isGoogleCalendarError(err: unknown): err is GoogleCalendarError {
  return err instanceof GoogleCalendarError;
}

export function parseGoogleErrorBody(detail: string): { reason?: string; message?: string } {
  try {
    const parsed = JSON.parse(detail) as {
      error?: { status?: string; message?: string; errors?: Array<{ reason?: string; message?: string }> };
    };
    const reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.status;
    const message = parsed.error?.errors?.[0]?.message ?? parsed.error?.message;
    return {
      reason: typeof reason === 'string' ? reason : undefined,
      message: typeof message === 'string' ? message : undefined,
    };
  } catch {
    return {};
  }
}

export function googleErrorFromHttp(input: {
  operation: string;
  googleStatus: number;
  detail: string;
  timeBlockId?: string;
  hasGoogleEventId?: boolean;
}): GoogleCalendarError {
  const parsed = parseGoogleErrorBody(input.detail);
  const reason = parsed.reason;
  const detailMessage = parsed.message;
  const lowerReason = (reason ?? '').toLowerCase();
  const lowerDetail = input.detail.toLowerCase();

  if (
    input.googleStatus === 401 ||
    lowerReason === 'autherror' ||
    lowerReason === 'unauthorized' ||
    lowerDetail.includes('invalid_grant')
  ) {
    return new GoogleCalendarError(
      'Google Calendar access expired — reconnect required',
      'GOOGLE_RECONNECT_REQUIRED',
      {
        statusCode: 401,
        googleStatus: input.googleStatus,
        reason: reason ?? 'unauthorized',
        operation: input.operation,
        timeBlockId: input.timeBlockId,
        hasGoogleEventId: input.hasGoogleEventId,
      },
    );
  }

  if (input.googleStatus === 403) {
    return new GoogleCalendarError(
      detailMessage ?? 'Google Calendar permission denied — check scopes or API enablement',
      'GOOGLE_FORBIDDEN',
      {
        statusCode: 403,
        googleStatus: 403,
        reason: reason ?? 'forbidden',
        operation: input.operation,
        timeBlockId: input.timeBlockId,
        hasGoogleEventId: input.hasGoogleEventId,
      },
    );
  }

  if (input.googleStatus === 404 || input.googleStatus === 410) {
    return new GoogleCalendarError(
      detailMessage ?? 'Google Calendar resource not found',
      'GOOGLE_NOT_FOUND',
      {
        statusCode: 404,
        googleStatus: input.googleStatus,
        reason: reason ?? 'notFound',
        operation: input.operation,
        timeBlockId: input.timeBlockId,
        hasGoogleEventId: input.hasGoogleEventId,
      },
    );
  }

  if (input.googleStatus === 409) {
    return new GoogleCalendarError(
      detailMessage ?? 'Google Calendar conflict',
      'GOOGLE_CONFLICT',
      {
        statusCode: 409,
        googleStatus: 409,
        reason: reason ?? 'conflict',
        operation: input.operation,
        timeBlockId: input.timeBlockId,
        hasGoogleEventId: input.hasGoogleEventId,
      },
    );
  }

  if (input.googleStatus === 429) {
    return new GoogleCalendarError(
      'Google Calendar rate limited',
      'GOOGLE_RATE_LIMITED',
      {
        statusCode: 429,
        googleStatus: 429,
        reason: reason ?? 'rateLimitExceeded',
        operation: input.operation,
        timeBlockId: input.timeBlockId,
        hasGoogleEventId: input.hasGoogleEventId,
      },
    );
  }

  if (input.googleStatus >= 500) {
    return new GoogleCalendarError(
      'Google Calendar upstream failure',
      'GOOGLE_UPSTREAM',
      {
        statusCode: 502,
        googleStatus: input.googleStatus,
        reason: reason ?? 'upstream',
        operation: input.operation,
        timeBlockId: input.timeBlockId,
        hasGoogleEventId: input.hasGoogleEventId,
      },
    );
  }

  if (input.googleStatus >= 400) {
    return new GoogleCalendarError(
      detailMessage ?? 'Google Calendar request rejected',
      'GOOGLE_BAD_REQUEST',
      {
        statusCode: 400,
        googleStatus: input.googleStatus,
        reason: reason ?? 'badRequest',
        operation: input.operation,
        timeBlockId: input.timeBlockId,
        hasGoogleEventId: input.hasGoogleEventId,
      },
    );
  }

  return new GoogleCalendarError(
    detailMessage ?? 'Google Calendar request failed',
    'GOOGLE_UNKNOWN',
    {
      statusCode: 502,
      googleStatus: input.googleStatus,
      reason,
      operation: input.operation,
      timeBlockId: input.timeBlockId,
      hasGoogleEventId: input.hasGoogleEventId,
    },
  );
}
