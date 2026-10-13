/**
 * Auth error translation: Supabase Auth error codes -> product copy.
 *
 * Raw provider messages never reach the UI (no internal implementation
 * leakage). Unknown codes fall back to a per-operation message so a new
 * provider error cannot break the surface.
 *
 * Engineering codes stay stable; product copy is resolved from `auth.err.*`
 * message keys at access time using the active UI locale (works outside
 * React via `readStoredLocale`).
 */

import { getMessage } from "../i18n/messages/index.js";
import { readStoredLocale } from "../i18n/locale.js";

export const SMS_PROVIDER_NOT_CONFIGURED = "SMS_PROVIDER_NOT_CONFIGURED";

export type AuthOperation =
  | "SEND_EMAIL_OTP"
  | "SEND_PHONE_OTP"
  | "VERIFY_OTP"
  | "SIGN_IN"
  | "SIGN_UP"
  | "LINK_IDENTITY"
  | "UNLINK_IDENTITY"
  | "PASSWORD"
  | "SIGN_OUT"
  | "SESSION";

function resolveMessage(messageKey: string): string {
  return getMessage(readStoredLocale(), messageKey);
}

export class AuthUiError extends Error {
  readonly code: string;

  readonly operation: AuthOperation;

  /** Catalog key under `auth.*` — resolved to product copy on access. */
  readonly messageKey: string;

  constructor(code: string, operation: AuthOperation, messageKey: string) {
    // No own `message` own-property: the getter below must win so the
    // copy tracks a language switch instead of freezing at throw time.
    super();
    this.name = "AuthUiError";
    this.code = code;
    this.operation = operation;
    this.messageKey = messageKey;
  }

  /** Product copy in the active UI locale. */
  get message(): string {
    return resolveMessage(this.messageKey);
  }
}

interface AuthErrorLike {
  readonly code?: string;
  readonly message?: string;
  readonly status?: number;
}

/** Fallbacks when the provider returns an error code we do not know yet. */
const FALLBACKS: Record<AuthOperation, string> = {
  SEND_EMAIL_OTP: "auth.err.sendEmailOtp",
  SEND_PHONE_OTP: "auth.err.sendPhoneOtp",
  VERIFY_OTP: "auth.err.invalidOtp",
  SIGN_IN: "auth.err.signIn",
  SIGN_UP: "auth.err.signUp",
  LINK_IDENTITY: "auth.err.linkIdentity",
  UNLINK_IDENTITY: "auth.err.unlinkIdentity",
  PASSWORD: "auth.err.password",
  SIGN_OUT: "auth.err.signOut",
  SESSION: "auth.err.session",
};

const BY_CODE: Record<string, (operation: AuthOperation) => string> = {
  OTP_EXPIRED: () => "auth.err.otpExpired",
  OTP_ALREADY_USED: () => "auth.err.otpAlreadyUsed",
  INVALID_CREDENTIALS: (operation) =>
    operation === "VERIFY_OTP"
      ? "auth.err.invalidOtp"
      : "auth.err.invalidCredentials",
  EMAIL_NOT_CONFIRMED: () => "auth.err.emailNotConfirmed",
  USER_ALREADY_EXISTS: () => "auth.err.userAlreadyExists",
  USER_NOT_FOUND: () => "auth.err.userNotFound",
  WEAK_PASSWORD: () => "auth.err.weakPassword",
  IDENTITY_ALREADY_EXISTS: () => "auth.err.identityAlreadyExists",
  PROVIDER_ALREADY_EXISTS: () => "auth.err.identityAlreadyExists",
  NOT_AUTHENTICATED: () => "auth.err.notAuthenticated",
  SESSION_NOT_FOUND: () => "auth.err.sessionExpired",
  REFRESH_TOKEN_NOT_FOUND: () => "auth.err.sessionExpired",
  SESSION_EXPIRED: () => "auth.err.sessionExpired",
  VALIDATION_FAILED: (operation) =>
    operation === "UNLINK_IDENTITY"
      ? "auth.err.keepLastIdentity"
      : "auth.err.validation",
  RATE_LIMIT: () => "auth.err.rateLimit",
  OVERDUE_SMS_SEND_RATE_LIMIT: () => "auth.err.smsRateLimit",
  SMS_SEND_RATE_LIMIT: () => "auth.err.smsRateLimit",
  EMAIL_RATE_LIMIT_EXCEEDED: () => "auth.err.emailRateLimit",
  OVERDUE_EMAIL_SEND_RATE_LIMIT: () => "auth.err.emailRateLimit",
  // Current GoTrue codes (the `overdue_*` variants above are kept for
  // older deployments; the live project returns the `over_*` family).
  OVER_EMAIL_SEND_RATE_LIMIT: () => "auth.err.emailRateLimit",
  OVER_SMS_SEND_RATE_LIMIT: () => "auth.err.smsRateLimit",
  OVER_REQUEST_RATE_LIMIT: () => "auth.err.rateLimit",
  SIGNUP_DISABLED: () => "auth.err.signupDisabled",
  PROVIDER_DISABLED: () => "auth.err.providerDisabled",
  MANUAL_LINKING_DISABLED: () => "auth.err.manualLinkingDisabled",
  SMS_PROVIDER_NOT_CONFIGURED: () => "auth.err.smsProviderNotConfigured",
};

function codeOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as AuthErrorLike;
  if (typeof candidate.code === "string" && candidate.code.trim())
    return candidate.code.trim().toUpperCase();
  return null;
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as AuthErrorLike).message;
    if (typeof message === "string") return message;
  }
  if (error instanceof Error) return error.message;
  return "";
}

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as AuthErrorLike).status;
  return typeof status === "number" ? status : null;
}

/**
 * SMS provider failures surface as provider-side 500s with an SMS message.
 * They are an external configuration state, not an application bug.
 */
function isSmsProviderMissing(error: unknown): boolean {
  const message = messageOf(error);
  return (
    /sms/i.test(message) &&
    (statusOf(error) === 500 || /not configured|provider error/i.test(message))
  );
}

/** Convert any Supabase Auth error into a user-readable product error. */
export function toAuthUiError(
  error: unknown,
  operation: AuthOperation,
): AuthUiError {
  if (error instanceof AuthUiError) return error;
  const rawCode = codeOf(error);
  const smsMissing = BY_CODE[SMS_PROVIDER_NOT_CONFIGURED];
  if (isSmsProviderMissing(error) && smsMissing)
    return new AuthUiError(
      SMS_PROVIDER_NOT_CONFIGURED,
      operation,
      smsMissing(operation),
    );
  const mapped = rawCode ? BY_CODE[rawCode] : undefined;
  if (rawCode && mapped)
    return new AuthUiError(rawCode, operation, mapped(operation));
  // Some provider failures only carry a status (e.g. plain HTTP 429).
  const status = statusOf(error);
  const rateLimited = BY_CODE.RATE_LIMIT;
  if (status === 429 && rateLimited)
    return new AuthUiError("RATE_LIMIT", operation, rateLimited(operation));
  return new AuthUiError(
    rawCode ?? "AUTH_ERROR",
    operation,
    FALLBACKS[operation],
  );
}

export function isAuthConfiguredError(error: unknown): boolean {
  return error instanceof Error && error.message === "Auth is not configured";
}
