import { describe, expect, it } from "vitest";
import {
  createAuthAdapter,
  readAuthRedirectError,
  redirectErrorMessage,
  type AuthAdapter,
  type AuthClientLike,
} from "./adapter.js";
import { AuthUiError, SMS_PROVIDER_NOT_CONFIGURED } from "./errors.js";

/**
 * All Auth V1 behaviour is exercised against a fake Supabase Auth client.
 * No network call and no real SMS/e-mail is ever produced by this suite.
 */

const EMAIL_CODE = "123456";
const PHONE_CODE = "654321";
const EXPIRED_TOKEN = "000000";
const NOW = "2026-09-27T00:00:00.000Z";

interface FakeIdentity {
  provider: string;
  identity_id: string;
  email?: string | null;
  phone?: string | null;
  identity_data?: Record<string, unknown>;
}

interface FakeUser {
  id: string;
  email?: string | null;
  phone?: string | null;
  email_confirmed_at?: string | null;
  phone_confirmed_at?: string | null;
  password?: string | null;
  identities: FakeIdentity[];
}

interface FakeError {
  code: string;
  message: string;
  status?: number;
}

class FakeAuthClient {
  users: FakeUser[] = [];

  session: FakeUser | null = null;

  emailCodes = new Map<string, string>();

  phoneCodes = new Map<string, string>();

  pendingChange = new Map<string, string>();

  sentEmail = 0;

  sentPhone = 0;

  resets = 0;

  autoConfirmEmail = true;

  smsConfigured = true;

  manualLinkingEnabled = true;

  googleSub = "google-sub-1";

  googleSubOwners = new Map<string, string>();

  oauthUrls: string[] = [];
  oauthParams: Record<string, unknown>[] = [];
  linkParams: Record<string, unknown>[] = [];

  forced = new Map<string, FakeError>();

  seq = 0;

  private nextId(): string {
    this.seq += 1;
    return `user-${this.seq}`;
  }

  addIdentity(
    user: FakeUser,
    provider: string,
    value: string,
    verified: boolean,
  ) {
    const identity: FakeIdentity = {
      provider,
      identity_id: `${provider}:${provider === "google" ? this.googleSub : value}`,
      identity_data: {},
    };
    if (provider === "phone") {
      identity.phone = value;
      identity.identity_data = { phone: value, phone_verified: verified };
    } else {
      identity.email = value;
      identity.identity_data =
        provider === "google"
          ? { sub: this.googleSub, email: value, email_verified: verified }
          : { email: value, email_verified: verified };
    }
    user.identities.push(identity);
    return identity;
  }

  createUser(options: {
    provider: string;
    value: string;
    verified: boolean;
    password?: string | null;
  }): FakeUser {
    const user: FakeUser = {
      id: this.nextId(),
      identities: [],
      password: options.password ?? null,
    };
    if (options.provider === "phone") user.phone = options.value;
    else user.email = options.value;
    if (options.provider === "email" && options.verified)
      user.email_confirmed_at = NOW;
    if (options.provider === "phone" && options.verified)
      user.phone_confirmed_at = NOW;
    this.addIdentity(user, options.provider, options.value, options.verified);
    this.users.push(user);
    return user;
  }

  findUser(provider: string, value: string): FakeUser | null {
    return (
      this.users.find((user) =>
        user.identities.some((identity) =>
          provider === "google"
            ? identity.identity_id === `google:${value}`
            : provider === "email"
              ? identity.email === value
              : identity.phone === value,
        ),
      ) ?? null
    );
  }

  private startSession(user: FakeUser) {
    this.session = user;
    return { data: { session: { user }, user }, error: null };
  }

  private authError(method: string): FakeError | null {
    return this.forced.get(method) ?? null;
  }

  async getSession() {
    return {
      data: { session: this.session ? { user: this.session } : null },
    };
  }

  onAuthStateChange(
    callback: (event: string, session: { user: FakeUser } | null) => void,
  ) {
    callback(
      this.session ? "SIGNED_IN" : "SIGNED_OUT",
      this.session ? { user: this.session } : null,
    );
    return { data: { subscription: { unsubscribe() {} } } };
  }

  async signInWithOtp(params: Record<string, unknown>) {
    const forced = this.authError("signInWithOtp");
    if (forced) return { data: {}, error: forced };
    const email = typeof params.email === "string" ? params.email : null;
    const phone = typeof params.phone === "string" ? params.phone : null;
    if (email) {
      this.sentEmail += 1;
      this.emailCodes.set(email, EMAIL_CODE);
      return { data: {}, error: null };
    }
    if (phone) {
      if (!this.smsConfigured)
        return {
          data: {},
          error: {
            code: "500",
            message: "Error sending SMS message: provider not configured",
            status: 500,
          },
        };
      this.sentPhone += 1;
      this.phoneCodes.set(phone, PHONE_CODE);
      return { data: {}, error: null };
    }
    return {
      data: {},
      error: {
        code: "validation_failed",
        message: "email or phone required",
        status: 400,
      },
    };
  }

  async verifyOtp(params: Record<string, unknown>) {
    const forced = this.authError("verifyOtp");
    if (forced) return { data: {}, error: forced };
    const type = String(params.type ?? "");
    const token = String(params.token ?? "");
    if (token === EXPIRED_TOKEN)
      return {
        data: {},
        error: { code: "otp_expired", message: "OTP has expired", status: 400 },
      };

    if (type === "email" || type === "sms") {
      const target = String(
        type === "email" ? params.email : (params.phone ?? ""),
      );
      const codes = type === "email" ? this.emailCodes : this.phoneCodes;
      const expected = codes.get(target);
      if (!expected || token !== expected)
        return {
          data: {},
          error: {
            code: "invalid_credentials",
            message: "Token has expired or is invalid",
            status: 400,
          },
        };
      let user = this.findUser(type === "email" ? "email" : "phone", target);
      if (!user) {
        user = this.createUser({
          provider: type === "email" ? "email" : "phone",
          value: target,
          verified: true,
        });
      } else if (type === "email" && !user.email_confirmed_at) {
        user.email_confirmed_at = NOW;
        for (const identity of user.identities)
          if (identity.provider === "email")
            identity.identity_data = {
              ...identity.identity_data,
              email_verified: true,
            };
      }
      codes.delete(target);
      return this.startSession(user);
    }

    if (
      type === "email_change" ||
      type === "phone_change" ||
      type === "recovery"
    ) {
      const target = String(
        type === "phone_change" ? params.phone : (params.email ?? ""),
      );
      const key = `${type}:${target}`;
      const expected = this.pendingChange.get(key);
      if (!expected || token !== expected)
        return {
          data: {},
          error: {
            code: "invalid_credentials",
            message: "Token has expired or is invalid",
            status: 400,
          },
        };
      this.pendingChange.delete(key);
      if (type === "recovery") {
        const owner = this.findUser("email", target);
        if (!owner)
          return {
            data: {},
            error: {
              code: "user_not_found",
              message: "User not found",
              status: 404,
            },
          };
        return this.startSession(owner);
      }
      const session = this.session;
      if (!session)
        return {
          data: {},
          error: {
            code: "not_authenticated",
            message: "Requires authentication",
            status: 401,
          },
        };
      if (type === "email_change") {
        session.email = target;
        session.email_confirmed_at = NOW;
        if (
          !session.identities.some((identity) => identity.provider === "email")
        )
          this.addIdentity(session, "email", target, true);
      } else {
        session.phone = target;
        session.phone_confirmed_at = NOW;
        if (
          !session.identities.some((identity) => identity.provider === "phone")
        )
          this.addIdentity(session, "phone", target, true);
      }
      return {
        data: { session: { user: session }, user: session },
        error: null,
      };
    }

    return {
      data: {},
      error: { code: "validation_failed", message: "unsupported", status: 400 },
    };
  }

  async signInWithPassword(params: Record<string, unknown>) {
    const forced = this.authError("signInWithPassword");
    if (forced) return { data: {}, error: forced };
    const email = typeof params.email === "string" ? params.email : null;
    const phone = typeof params.phone === "string" ? params.phone : null;
    const password = String(params.password ?? "");
    const user = this.findUser(email ? "email" : "phone", email ?? phone ?? "");
    if (!user || user.password !== password)
      return {
        data: {},
        error: {
          code: "invalid_credentials",
          message: "Invalid login credentials",
          status: 400,
        },
      };
    return this.startSession(user);
  }

  async signUp(params: Record<string, unknown>) {
    const forced = this.authError("signUp");
    if (forced) return { data: {}, error: forced };
    const email = typeof params.email === "string" ? params.email : null;
    const phone = typeof params.phone === "string" ? params.phone : null;
    const password = String(params.password ?? "");
    const provider = email ? "email" : "phone";
    const value = email ?? phone ?? "";
    if (this.findUser(provider, value))
      return {
        data: {},
        error: {
          code: "user_already_exists",
          message: "User already registered",
          status: 422,
        },
      };
    if (email && !this.autoConfirmEmail) {
      this.createUser({ provider, value, verified: false, password });
      this.emailCodes.set(value, EMAIL_CODE);
      return { data: {}, error: null };
    }
    if (!email) {
      // Phone sign-up asks the user to confirm the number over SMS first.
      this.createUser({ provider, value, verified: false, password });
      if (this.smsConfigured) this.phoneCodes.set(value, PHONE_CODE);
      return { data: {}, error: null };
    }
    return this.startSession(
      this.createUser({ provider, value, verified: true, password }),
    );
  }

  async signInWithOAuth(params: Record<string, unknown>) {
    const forced = this.authError("signInWithOAuth");
    if (forced) return { data: {}, error: forced };
    this.oauthParams.push(params);
    this.oauthUrls.push(
      `https://accounts.example/oauth/${String(params.provider)}`,
    );
    return {
      data: { url: this.oauthUrls[this.oauthUrls.length - 1] },
      error: null,
    };
  }

  /** Simulates the browser returning from the Google consent screen. */
  finishGoogleOAuth(options: { email?: string } = {}): FakeUser {
    const sub = this.googleSub;
    const owner = this.googleSubOwners.get(sub);
    let user: FakeUser | null = null;
    if (owner) user = this.users.find((value) => value.id === owner) ?? null;
    if (!user && options.email) {
      // Supabase automatic linking: verified e-mail address matches.
      user = this.findUser("email", options.email);
      if (user) {
        user.identities = user.identities.filter(
          (identity) => identity.provider !== "google",
        );
        this.addIdentity(user, "google", sub, true);
      }
    }
    if (!user) {
      user = this.createUser({
        provider: "google",
        value: options.email ?? `${sub}@accounts.example`,
        verified: true,
      });
      this.googleSubOwners.set(sub, user.id);
    }
    return this.startSession(user).data.user as FakeUser;
  }

  async linkIdentity(params: Record<string, unknown>) {
    const forced = this.authError("linkIdentity");
    if (forced) return { data: {}, error: forced };
    this.linkParams.push(params);
    if (!this.session)
      return {
        data: {},
        error: {
          code: "not_authenticated",
          message: "Requires authentication",
          status: 401,
        },
      };
    if (!this.manualLinkingEnabled)
      return {
        data: {},
        error: {
          code: "manual_linking_disabled",
          message: "Manual linking is disabled",
          status: 422,
        },
      };
    const provider = String(params.provider);
    const sub = this.googleSub;
    const ownerId = this.googleSubOwners.get(sub);
    if (ownerId && ownerId !== this.session.id)
      return {
        data: {},
        error: {
          code: "identity_already_exists",
          message: "Identity already linked to a user",
          status: 422,
        },
      };
    const session = this.session;
    session.identities = session.identities.filter(
      (identity) => identity.provider !== provider,
    );
    this.addIdentity(
      session,
      provider,
      session.email ?? `${sub}@accounts.example`,
      true,
    );
    this.googleSubOwners.set(sub, session.id);
    return { data: { user: session }, error: null };
  }

  async getUserIdentities() {
    if (!this.session)
      return {
        data: null,
        error: {
          code: "not_authenticated",
          message: "Requires authentication",
          status: 401,
        },
      };
    return { data: { identities: this.session.identities }, error: null };
  }

  async unlinkIdentity(identity: FakeIdentity) {
    if (!this.session)
      return {
        data: {},
        error: {
          code: "not_authenticated",
          message: "Requires authentication",
          status: 401,
        },
      };
    if (this.session.identities.length < 2)
      return {
        data: {},
        error: {
          code: "validation_failed",
          message: "A user must have at least two identities to unlink",
          status: 422,
        },
      };
    this.session.identities = this.session.identities.filter(
      (value) => value.identity_id !== identity.identity_id,
    );
    return { data: { user: this.session }, error: null };
  }

  async updateUser(params: Record<string, unknown>) {
    const forced = this.authError("updateUser");
    if (forced) return { data: {}, error: forced };
    if (!this.session)
      return {
        data: {},
        error: {
          code: "not_authenticated",
          message: "Requires authentication",
          status: 401,
        },
      };
    const session = this.session;
    if (typeof params.password === "string") {
      session.password = params.password;
      return { data: { user: session }, error: null };
    }
    if (typeof params.email === "string") {
      const owner = this.findUser("email", params.email);
      if (owner && owner.id !== session.id)
        return {
          data: {},
          error: {
            code: "user_already_exists",
            message: "Email address already registered",
            status: 422,
          },
        };
      this.pendingChange.set(`email_change:${params.email}`, EMAIL_CODE);
      return { data: { user: session }, error: null };
    }
    if (typeof params.phone === "string") {
      if (!this.smsConfigured)
        return {
          data: {},
          error: {
            code: "500",
            message: "Error sending SMS message: provider not configured",
            status: 500,
          },
        };
      const owner = this.findUser("phone", params.phone);
      if (owner && owner.id !== session.id)
        return {
          data: {},
          error: {
            code: "user_already_exists",
            message: "Phone number already registered",
            status: 422,
          },
        };
      this.pendingChange.set(`phone_change:${params.phone}`, PHONE_CODE);
      return { data: { user: session }, error: null };
    }
    return {
      data: {},
      error: { code: "validation_failed", message: "no fields", status: 400 },
    };
  }

  async resetPasswordForEmail(email: string) {
    const forced = this.authError("resetPasswordForEmail");
    if (forced) return { data: {}, error: forced };
    this.resets += 1;
    this.pendingChange.set(`recovery:${email}`, EMAIL_CODE);
    return { data: {}, error: null };
  }

  async signOut() {
    this.session = null;
    return { error: null };
  }
}

function setup(): { fake: FakeAuthClient; adapter: AuthAdapter } {
  const fake = new FakeAuthClient();
  return {
    fake,
    adapter: createAuthAdapter(fake as unknown as AuthClientLike),
  };
}

const PHONE = "+8613800001111";
const EMAIL = "student@cufe.edu.cn";

describe("Auth Identity", () => {
  it("1. phone OTP login", async () => {
    const { fake, adapter } = setup();
    await adapter.sendPhoneOtp(PHONE);
    expect(fake.sentPhone).toBe(1);
    const account = await adapter.verifyPhoneOtp(PHONE, PHONE_CODE);
    expect(account.userId).toBe("user-1");
    expect((await adapter.getAccount())?.userId).toBe("user-1");
  });

  it("2. email OTP login (OTP, not magic link)", async () => {
    const { fake, adapter } = setup();
    await adapter.sendEmailOtp(EMAIL);
    expect(fake.sentEmail).toBe(1);
    const account = await adapter.verifyEmailOtp(EMAIL, EMAIL_CODE);
    expect(account.userId).toBe("user-1");
    expect(fake.oauthUrls).toHaveLength(0);
  });

  it("3. email password login", async () => {
    const { fake, adapter } = setup();
    fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
      password: "correct-horse",
    });
    const account = await adapter.signInEmailPassword(EMAIL, "correct-horse");
    expect(account.userId).toBe("user-1");
    expect(adapter.passwordStatus(account.userId)).toBe("SET");
  });

  it("4. phone password login", async () => {
    const { fake, adapter } = setup();
    fake.createUser({
      provider: "phone",
      value: PHONE,
      verified: true,
      password: "correct-horse",
    });
    const account = await adapter.signInPhonePassword(PHONE, "correct-horse");
    expect(account.phone).toBe(PHONE);
    expect(fake.session?.phone).toBe(PHONE);
  });

  it("5. google oauth flow boundary", async () => {
    const { fake, adapter } = setup();
    await adapter.signInGoogle();
    expect(fake.oauthUrls).toEqual(["https://accounts.example/oauth/google"]);
    // The round trip must come back to THIS app, not the project Site URL.
    expect(fake.oauthParams.at(-1)).toMatchObject({
      provider: "google",
      options: {
        // Same degradation as appOrigin(): no window in this env.
        redirectTo: typeof window === "undefined" ? "" : window.location.origin,
      },
    });
    // The redirect itself never creates local state; returning from it does.
    expect(await adapter.getAccount()).toBeNull();
    const user = fake.finishGoogleOAuth({ email: EMAIL });
    expect((await adapter.getAccount())?.userId).toBe(user.id);
    expect(readAuthRedirectError("?error=identity_already_exists")).toBe(
      "auth.err.identityAlreadyExists",
    );
  });

  it("6. identity listing", async () => {
    const { fake, adapter } = setup();
    const user = fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
      password: "pw",
    });
    fake.addIdentity(user, "phone", PHONE, true);
    fake.addIdentity(user, "google", EMAIL, true);
    fake.session = user;
    const identities = await adapter.listIdentities();
    expect(identities.map((value) => value.provider).sort()).toEqual([
      "email",
      "google",
      "phone",
    ]);
    expect(identities.every((value) => value.verified)).toBe(true);
    expect(adapter.passwordStatus(user.id)).toBe("NOT_SET");
  });

  it("6b. verified falls back to the auth.users confirmation columns", async () => {
    const { fake, adapter } = setup();
    // Real GoTrue shape: `identity_data` is frozen at creation with
    // `*_verified: false` while the user-level `*_confirmed_at` column is set
    // (user 8138a7f3, phone confirmed 2026-09-28).
    const phoneUser = fake.createUser({
      provider: "phone",
      value: PHONE,
      verified: false,
    });
    phoneUser.phone_confirmed_at = NOW;
    fake.session = phoneUser;
    const phoneViews = await adapter.listIdentities();
    expect(
      phoneViews.find((value) => value.provider === "phone")?.verified,
    ).toBe(true);
    expect((await adapter.getAccount())!.phoneVerified).toBe(true);

    const emailUser = fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: false,
    });
    emailUser.email_confirmed_at = NOW;
    // A *different* contact must not borrow the account's confirmation.
    fake.addIdentity(emailUser, "email", "second@cufe.edu.cn", false);
    fake.session = emailUser;
    const emailViews = await adapter.listIdentities();
    expect(emailViews.find((value) => value.label === EMAIL)?.verified).toBe(
      true,
    );
    expect(
      emailViews.find((value) => value.label === "second@cufe.edu.cn")
        ?.verified,
    ).toBe(false);

    // Nothing confirmed anywhere -> still unverified.
    const fresh = fake.createUser({
      provider: "phone",
      value: PHONE,
      verified: false,
    });
    fake.session = fresh;
    expect(
      (await adapter.listIdentities()).find(
        (value) => value.provider === "phone",
      )?.verified,
    ).toBe(false);
  });

  it("7. google linking keeps the same user", async () => {
    const { fake, adapter } = setup();
    fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
      password: "pw",
    });
    await adapter.signInEmailPassword(EMAIL, "pw");
    const before = (await adapter.getAccount())!.userId;
    await adapter.linkGoogle();
    expect(fake.linkParams.at(-1)).toMatchObject({
      provider: "google",
      options: {
        // Same degradation as appOrigin(): no window in this env.
        redirectTo: typeof window === "undefined" ? "" : window.location.origin,
      },
    });
    expect((await adapter.getAccount())!.userId).toBe(before);
    expect(
      (await adapter.listIdentities()).map((value) => value.provider),
    ).toContain("google");
  });

  it("8. email verification binding", async () => {
    const { fake, adapter } = setup();
    fake.createUser({ provider: "phone", value: PHONE, verified: true });
    await adapter.sendPhoneOtp(PHONE);
    await adapter.verifyPhoneOtp(PHONE, PHONE_CODE);
    await adapter.linkEmail("other@cufe.edu.cn");
    expect(
      (await adapter.listIdentities()).some(
        (value) => value.provider === "email",
      ),
    ).toBe(false);
    await adapter.verifyLinkEmail("other@cufe.edu.cn", EMAIL_CODE);
    const email = (await adapter.listIdentities()).find(
      (value) => value.provider === "email",
    );
    expect(email?.verified).toBe(true);
    expect(email?.label).toBe("other@cufe.edu.cn");
  });

  it("9. phone verification binding", async () => {
    const { fake, adapter } = setup();
    fake.createUser({ provider: "email", value: EMAIL, verified: true });
    await adapter.sendEmailOtp(EMAIL);
    await adapter.verifyEmailOtp(EMAIL, EMAIL_CODE);
    await adapter.linkPhone("+8613900002222");
    await adapter.verifyLinkPhone("+8613900002222", PHONE_CODE);
    const phone = (await adapter.listIdentities()).find(
      (value) => value.provider === "phone",
    );
    expect(phone?.verified).toBe(true);
    expect(phone?.label).toBe("+8613900002222");
  });

  it("10. duplicate identity rejection", async () => {
    const { fake, adapter } = setup();
    const other = fake.createUser({
      provider: "email",
      value: "other@cufe.edu.cn",
      verified: true,
    });
    fake.googleSubOwners.set(fake.googleSub, other.id);
    fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
      password: "pw",
    });
    await adapter.signInEmailPassword(EMAIL, "pw");
    const userId = (await adapter.getAccount())!.userId;
    await expect(adapter.linkGoogle()).rejects.toThrow(
      "该登录方式已经关联其他账号。",
    );
    expect((await adapter.getAccount())!.userId).toBe(userId);
    expect(fake.users).toHaveLength(2);
    expect(fake.googleSubOwners.get(fake.googleSub)).toBe(other.id);
    expect(
      (await adapter.listIdentities()).some(
        (value) => value.provider === "google",
      ),
    ).toBe(false);
  });

  it("11. unlink safety", async () => {
    const { fake, adapter } = setup();
    const user = fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
    });
    fake.session = user;
    expect(adapter.canUnlink(await adapter.listIdentities())).toBe(false);
    await expect(adapter.unlink("email")).rejects.toThrow(
      "至少保留一种登录方式，无法解除最后的绑定。",
    );
    fake.addIdentity(user, "google", EMAIL, true);
    expect(adapter.canUnlink(await adapter.listIdentities())).toBe(true);
    await adapter.unlink("google");
    expect(
      (await adapter.listIdentities()).map((value) => value.provider),
    ).toEqual(["email"]);
  });

  it("12. password setup", async () => {
    const { fake, adapter } = setup();
    const user = fake.createUser({
      provider: "phone",
      value: PHONE,
      verified: true,
    });
    fake.session = user;
    expect(adapter.passwordStatus(user.id)).toBe("NOT_SET");
    await adapter.setPassword("a-strong-password");
    expect(adapter.passwordStatus(user.id)).toBe("SET");
    expect(user.password).toBe("a-strong-password");
  });

  it("13. password change", async () => {
    const { fake, adapter } = setup();
    const user = fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
      password: "old-password",
    });
    fake.session = user;
    await adapter.setPassword("new-password");
    await fake.signOut();
    const account = await adapter.signInEmailPassword(EMAIL, "new-password");
    expect(account.email).toBe(EMAIL);
  });

  it("14. password reset", async () => {
    const { fake, adapter } = setup();
    fake.createUser({ provider: "email", value: EMAIL, verified: true });
    await adapter.requestPasswordReset(EMAIL);
    expect(fake.resets).toBe(1);
    const account = await adapter.completePasswordRecovery(EMAIL, EMAIL_CODE);
    expect(account.email).toBe(EMAIL);
    await adapter.setPassword("reset-password");
    expect(adapter.passwordStatus(account.userId)).toBe("SET");
  });

  it("15. logout and session recovery", async () => {
    const { fake, adapter } = setup();
    fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
      password: "pw",
    });
    const first = await adapter.signInEmailPassword(EMAIL, "pw");
    await adapter.signOut();
    expect(await adapter.getAccount()).toBeNull();
    const second = await adapter.signInEmailPassword(EMAIL, "pw");
    expect(second.userId).toBe(first.userId);
  });
});

describe("Owner continuity", () => {
  it("16-18. phone, email and google identities resolve to one account", async () => {
    const { fake, adapter } = setup();
    // 16. Phone OTP creates the human's only account.
    await adapter.sendPhoneOtp(PHONE);
    const byPhone = await adapter.verifyPhoneOtp(PHONE, PHONE_CODE);
    // The same human then binds an e-mail address (verified while signed in).
    await adapter.linkEmail(EMAIL);
    await adapter.verifyLinkEmail(EMAIL, EMAIL_CODE);
    await adapter.signOut();
    // 17. Email OTP for that verified address signs into the same account.
    await adapter.sendEmailOtp(EMAIL);
    const byEmail = await adapter.verifyEmailOtp(EMAIL, EMAIL_CODE);
    await adapter.signOut();
    // 18. Google with the same verified e-mail -> automatic linking -> same user.
    fake.finishGoogleOAuth({ email: EMAIL });
    const byGoogle = (await adapter.getAccount())!;
    expect(byEmail.userId).toBe(byPhone.userId);
    expect(byGoogle.userId).toBe(byPhone.userId);
    expect(fake.users).toHaveLength(1);
  });

  it("19. provider switch never changes the owner id", async () => {
    const { fake, adapter } = setup();
    const user = fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
      password: "pw",
    });
    fake.addIdentity(user, "phone", PHONE, true);
    const owners = new Set<string>();
    owners.add((await adapter.signInEmailPassword(EMAIL, "pw")).userId);
    owners.add((await adapter.signInPhonePassword(PHONE, "pw")).userId);
    await adapter.signInEmailPassword(EMAIL, "pw");
    fake.finishGoogleOAuth({ email: EMAIL });
    owners.add((await adapter.getAccount())!.userId);
    expect([...owners]).toEqual([user.id]);
    expect(fake.users).toHaveLength(1);
  });

  it("20-21. the only owner value the adapter exposes is auth.users.id", async () => {
    // Local binding itself is asserted against the Dexie repository in
    // packages/storage/src/owner-continuity.test.ts.
    const { fake, adapter } = setup();
    fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
      password: "pw",
    });
    const account = await adapter.signInEmailPassword(EMAIL, "pw");
    expect(account.userId).toBe(fake.session!.id);
    expect(account.userId).not.toBe(EMAIL);
    expect(account.userId).not.toBe(account.email);
    expect(account.userId).not.toBe(account.phone);
  });
});

describe("Security", () => {
  it("22. candidate identity that already belongs to another user", async () => {
    const { fake, adapter } = setup();
    const other = fake.createUser({
      provider: "email",
      value: "taken@cufe.edu.cn",
      verified: true,
    });
    fake.addIdentity(other, "google", "taken@cufe.edu.cn", true);
    fake.googleSubOwners.set(fake.googleSub, other.id);
    fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
      password: "pw",
    });
    await adapter.signInEmailPassword(EMAIL, "pw");
    const errors: string[] = [];
    try {
      await adapter.linkGoogle();
    } catch (error) {
      errors.push((error as Error).message);
    }
    expect(errors[0]).toBe("该登录方式已经关联其他账号。");
    expect(fake.users).toHaveLength(2);
    expect(other.identities.some((value) => value.provider === "google")).toBe(
      true,
    );
    expect(fake.session?.id).not.toBe(other.id);
  });

  it("23. an existing identity cannot be hijacked", async () => {
    const { fake, adapter } = setup();
    const other = fake.createUser({
      provider: "email",
      value: "taken@cufe.edu.cn",
      verified: true,
    });
    const user = fake.createUser({
      provider: "email",
      value: EMAIL,
      verified: true,
    });
    fake.session = user;
    await expect(adapter.linkEmail("taken@cufe.edu.cn")).rejects.toThrow(
      "该邮箱已注册，请直接登录。",
    );
    expect(fake.session?.id).toBe(user.id);
    expect(other.email).toBe("taken@cufe.edu.cn");
    expect(fake.users).toHaveLength(2);
  });

  it("25. unauthenticated account linking is denied", async () => {
    const { fake, adapter } = setup();
    fake.createUser({ provider: "email", value: EMAIL, verified: true });
    await expect(adapter.linkGoogle()).rejects.toThrow(
      "请先登录账户后再操作。",
    );
    await expect(adapter.linkEmail(EMAIL)).rejects.toThrow(
      "请先登录账户后再操作。",
    );
    await expect(adapter.linkPhone(PHONE)).rejects.toThrow(
      "请先登录账户后再操作。",
    );
    await expect(adapter.unlink("email")).rejects.toThrow(
      "请先登录账户后再操作。",
    );
    expect(fake.session).toBeNull();
  });
});

describe("OTP", () => {
  it("26. wrong otp", async () => {
    const { adapter } = setup();
    await adapter.sendEmailOtp(EMAIL);
    await expect(adapter.verifyEmailOtp(EMAIL, "000111")).rejects.toThrow(
      "验证码不正确或已过期，请重新获取。",
    );
    expect(await adapter.getAccount()).toBeNull();
  });

  it("27. expired otp", async () => {
    const { adapter } = setup();
    await adapter.sendEmailOtp(EMAIL);
    const error = await adapter
      .verifyEmailOtp(EMAIL, EXPIRED_TOKEN)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AuthUiError);
    expect((error as Error).message).toBe("验证码不正确或已过期，请重新获取。");
    expect((error as AuthUiError).code).toBe("OTP_EXPIRED");
  });

  it("28. resend", async () => {
    const { fake, adapter } = setup();
    await adapter.sendPhoneOtp(PHONE);
    await adapter.sendPhoneOtp(PHONE);
    expect(fake.sentPhone).toBe(2);
    await adapter.verifyPhoneOtp(PHONE, PHONE_CODE);
    expect((await adapter.getAccount())?.phone).toBe(PHONE);
  });

  it("29. rate limit", async () => {
    const { fake, adapter } = setup();
    fake.forced.set("signInWithOtp", {
      code: "overdue_sms_send_rate_limit",
      message: "rate",
      status: 429,
    });
    const error = await adapter
      .sendPhoneOtp(PHONE)
      .catch((value: unknown) => value);
    expect((error as Error).message).toBe("短信发送过于频繁，请稍后再试。");
    fake.forced.set("signInWithOtp", {
      code: "over_email_send_rate_limit",
      message: "rate",
      status: 429,
    });
    const emailLimited = await adapter
      .sendEmailOtp(EMAIL)
      .catch((value: unknown) => value);
    expect((emailLimited as Error).message).toBe(
      "邮件发送过于频繁，请稍后再试。",
    );
    fake.forced.set("signInWithOtp", {
      code: "500",
      message: "too many requests",
      status: 429,
    });
    const generic = await adapter
      .sendEmailOtp(EMAIL)
      .catch((value: unknown) => value);
    expect((generic as Error).message).toBe("操作过于频繁，请稍后再试。");
  });

  it("30. fake sms provider behaves as an external configuration state", async () => {
    const { fake, adapter } = setup();
    fake.smsConfigured = false;
    const error = await adapter
      .sendPhoneOtp(PHONE)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AuthUiError);
    expect((error as AuthUiError).code).toBe(SMS_PROVIDER_NOT_CONFIGURED);
    expect((error as Error).message).toContain("SMS_PROVIDER_NOT_CONFIGURED");
    expect(fake.sentPhone).toBe(0);
  });
});

describe("OAuth redirect failures", () => {
  it("reads identity_already_exists from the query string", () => {
    expect(readAuthRedirectError("?error=identity_already_exists")).toBe(
      "auth.err.identityAlreadyExists",
    );
    expect(readAuthRedirectError("?error_code=identity_already_exists")).toBe(
      "auth.err.identityAlreadyExists",
    );
  });

  it("reads failures from the hash fragment too", () => {
    expect(redirectErrorMessage("", "#error=identity_already_exists")).toBe(
      "auth.err.identityAlreadyExists",
    );
    expect(
      redirectErrorMessage(
        "?code=pkce-value",
        "#error_code=identity_already_exists",
      ),
    ).toBe("auth.err.identityAlreadyExists");
    expect(redirectErrorMessage("", "#error=access_denied")).toBe(
      "auth.err.signInIncomplete",
    );
  });

  it("stays silent when the redirect carries no failure", () => {
    expect(redirectErrorMessage("", "")).toBeNull();
    expect(redirectErrorMessage("?code=pkce-value", "")).toBeNull();
    expect(redirectErrorMessage("", "#access_token=abc")).toBeNull();
  });
});
