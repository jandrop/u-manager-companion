import { GraphQLError } from 'graphql';
import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  PermissionError,
  toHttpAuthError,
  toWsConnectionInitCloseReason,
  toWsOperationAuthError,
  WS_CONNECTION_INIT_UNAUTHORIZED_CODE,
} from '../../context.js';

describe('toHttpAuthError', () => {
  it('builds a GraphQLError with extensions.code UNAUTHENTICATED', () => {
    const error = toHttpAuthError(new AuthenticationError('no key'));
    expect(error).toBeInstanceOf(GraphQLError);
    expect(error.extensions['code']).toBe('UNAUTHENTICATED');
  });

  it('builds a GraphQLError with extensions.code UNAUTHENTICATED for a permission failure too', () => {
    // HTTP path treats "not authenticated" and "not authorized" the
    // same way -- a GraphQL-standard error either way.
    const error = toHttpAuthError(new PermissionError('insufficient permissions'));
    expect(error.extensions['code']).toBe('UNAUTHENTICATED');
  });
});

describe('toWsConnectionInitCloseReason', () => {
  it('returns close code 4401 for a failed/missing key at connection_init', () => {
    const reason = toWsConnectionInitCloseReason(new AuthenticationError('no key'));
    expect(reason.code).toBe(4401);
    expect(reason.code).toBe(WS_CONNECTION_INIT_UNAUTHORIZED_CODE);
    expect(typeof reason.reason).toBe('string');
  });
});

describe('toWsOperationAuthError', () => {
  it('returns a GraphQL error (not a close) for a per-operation permission failure on an open socket', () => {
    const error = toWsOperationAuthError(new PermissionError('insufficient permissions'));
    expect(error).toBeInstanceOf(GraphQLError);
    expect(error.extensions['code']).toBe('FORBIDDEN');
  });

  it('also handles an AuthenticationError raised mid-socket as a GraphQL error, not a close', () => {
    const error = toWsOperationAuthError(new AuthenticationError('key expired mid-session'));
    expect(error).toBeInstanceOf(GraphQLError);
    expect(error.extensions['code']).toBe('UNAUTHENTICATED');
  });
});
