"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, KeyRound, Loader2, MailCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "./ui/button";
import { NotebookSketch } from "./sketch";

type AuthMode = "signin" | "signup" | "verify-email" | "reset";
type SignInMethod = "password" | "otp";

type AuthConfig = {
  turnstileSiteKey: string | null;
  emailOtpEnabled: boolean;
};

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScriptPromise: Promise<TurnstileApi | null> | null = null;
function loadTurnstileScript(): Promise<TurnstileApi | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile ?? null);
    script.onerror = () => {
      turnstileScriptPromise = null;
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

function formatAuthError(error: {
  status?: number;
  code?: string;
  message?: string;
}): string {
  if (error.status === 429) {
    return error.code === "ACCOUNT_TEMPORARILY_LOCKED"
      ? "该账号登录失败次数过多，请 15 分钟后再试。"
      : "操作太频繁，请稍后再试。";
  }
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "邮箱或密码不正确。";
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "邮箱已经注册，可以直接登录。";
    case "EMAIL_NOT_VERIFIED":
      return "邮箱尚未验证，已为你发送 6 位验证码。";
    case "INVALID_OTP":
      return "验证码不正确，请检查后重试。";
    case "OTP_EXPIRED":
      return "验证码已过期，请重新发送。";
    case "TOO_MANY_ATTEMPTS":
      return "验证码尝试次数过多，请重新获取。";
    case "PASSWORD_TOO_WEAK":
      return "密码过于简单，请避免使用常见弱密码或与邮箱相同的密码。";
    case "MISSING_RESPONSE":
    case "VERIFICATION_FAILED":
      return "请先完成人机验证后再试。";
    default:
      return error.message ?? "暂时无法完成操作，请重试。";
  }
}

export function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [signInMethod, setSignInMethod] = useState<SignInMethod>("password");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [config, setConfig] = useState<AuthConfig>({
    turnstileSiteKey: null,
    emailOtpEnabled: false,
  });
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReady, setCaptchaReady] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth-config", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: AuthConfig | null) => {
        if (!active || !data) return;
        setConfig({
          turnstileSiteKey: data.turnstileSiteKey ?? null,
          emailOtpEnabled: Boolean(data.emailOtpEnabled),
        });
      })
      .catch(() => {
        /* Fail open to password-only client config when config endpoint unavailable */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => {
      setCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const needsTurnstile = Boolean(
    config.turnstileSiteKey &&
      (mode === "signup" ||
        (mode === "signin" && signInMethod === "password") ||
        (mode === "signin" && signInMethod === "otp" && !otpSent) ||
        mode === "verify-email" ||
        (mode === "reset" && !otpSent)),
  );

  useEffect(() => {
    const siteKey = config.turnstileSiteKey;
    const container = turnstileRef.current;
    if (!siteKey || !needsTurnstile || !container) {
      setCaptchaToken("");
      setCaptchaReady(false);
      return;
    }
    let cancelled = false;
    setCaptchaReady(false);
    setCaptchaToken("");

    void loadTurnstileScript().then((api) => {
      if (cancelled || !api || !turnstileRef.current) return;
      if (widgetIdRef.current) {
        try {
          api.remove(widgetIdRef.current);
        } catch {
          /* ignore */
        }
        widgetIdRef.current = null;
      }
      const theme =
        document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      widgetIdRef.current = api.render(turnstileRef.current, {
        sitekey: siteKey,
        theme,
        callback: (token) => {
          if (!cancelled) setCaptchaToken(token);
        },
        "expired-callback": () => {
          if (!cancelled) setCaptchaToken("");
        },
        "error-callback": () => {
          if (!cancelled) setCaptchaToken("");
        },
      });
      if (!cancelled) setCaptchaReady(true);
    });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* ignore */
        }
        widgetIdRef.current = null;
      }
    };
  }, [config.turnstileSiteKey, needsTurnstile, mode, signInMethod, otpSent]);

  const resetCaptcha = useCallback(() => {
    setCaptchaToken("");
    if (widgetIdRef.current && window.turnstile) {
      try {
        window.turnstile.reset(widgetIdRef.current);
      } catch {
        /* ignore */
      }
    }
  }, []);

  function captchaFetchOptions() {
    return config.turnstileSiteKey && captchaToken
      ? { headers: { "x-captcha-response": captchaToken } }
      : undefined;
  }

  async function sendOtpCode(
    type: "sign-in" | "email-verification" | "forget-password",
  ) {
    if (!email.trim()) {
      setError("请先填写邮箱地址。");
      return;
    }
    if (config.turnstileSiteKey && !captchaToken) {
      setError("请先完成人机验证后再发送验证码。");
      return;
    }
    setSendingOtp(true);
    setError("");
    setNotice("");
    try {
      const fetchOptions = captchaFetchOptions();
      const result =
        type === "forget-password"
          ? await authClient.emailOtp.requestPasswordReset({
              email,
              fetchOptions,
            })
          : await authClient.emailOtp.sendVerificationOtp({
              email,
              type,
              fetchOptions,
            });
      if (result.error) {
        setError(formatAuthError(result.error));
        return;
      }
      setOtpSent(true);
      setCooldown(60);
      setNotice("验证码已发送至你的邮箱，5 分钟内有效。");
    } catch {
      setError("连接失败，请检查网络后重试。");
    } finally {
      setSendingOtp(false);
      resetCaptcha();
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");

    if (mode === "signin" && signInMethod === "otp" && !otpSent) {
      await sendOtpCode("sign-in");
      return;
    }
    if (mode === "reset" && !otpSent) {
      await sendOtpCode("forget-password");
      return;
    }
    if (
      config.turnstileSiteKey &&
      (mode === "signup" || (mode === "signin" && signInMethod === "password")) &&
      !captchaToken
    ) {
      setError("请先完成人机验证。");
      return;
    }

    setBusy(true);
    try {
      if (mode === "signup") {
        const result = await authClient.signUp.email({
          email,
          password,
          name,
          fetchOptions: captchaFetchOptions(),
        });
        if (result.error) {
          setError(formatAuthError(result.error));
          return;
        }
        if (config.emailOtpEnabled && !result.data?.token) {
          setOtp("");
          setOtpSent(true);
          setCooldown(60);
          setMode("verify-email");
          setNotice("注册请求已受理。若邮箱未注册，验证码已发送至你的邮箱。");
        }
        return;
      }

      if (mode === "verify-email") {
        const result = await authClient.emailOtp.verifyEmail({
          email,
          otp: otp.trim(),
        });
        if (result.error) {
          setError(formatAuthError(result.error));
          return;
        }
        return;
      }

      if (mode === "reset") {
        const result = await authClient.emailOtp.resetPassword({
          email,
          otp: otp.trim(),
          password,
        });
        if (result.error) {
          setError(formatAuthError(result.error));
          return;
        }
        setOtp("");
        setOtpSent(false);
        setPassword("");
        setMode("signin");
        setSignInMethod("password");
        setNotice("密码已重置，请使用新密码登录。");
        return;
      }

      if (signInMethod === "otp") {
        const result = await authClient.signIn.emailOtp({
          email,
          otp: otp.trim(),
        });
        if (result.error) {
          setError(formatAuthError(result.error));
        }
        return;
      }

      const result = await authClient.signIn.email({
        email,
        password,
        fetchOptions: captchaFetchOptions(),
      });
      if (result.error) {
        if (result.error.code === "EMAIL_NOT_VERIFIED" && config.emailOtpEnabled) {
          setOtp("");
          setOtpSent(true);
          setCooldown(60);
          setMode("verify-email");
          setNotice("邮箱尚未验证，已向你的邮箱发送新的 6 位验证码。");
        } else {
          setError(formatAuthError(result.error));
        }
      }
    } catch {
      setError("连接失败，请检查网络后重试。");
    } finally {
      setBusy(false);
      if (
        mode === "signup" ||
        (mode === "signin" && signInMethod === "password")
      ) {
        resetCaptcha();
      }
    }
  }

  function switchMode(next: AuthMode) {
    setMode(next);
    setOtp("");
    setOtpSent(false);
    setError("");
    setNotice("");
  }

  const heading =
    mode === "signup"
      ? "开始你的积累"
      : mode === "verify-email"
        ? "验证你的邮箱"
        : mode === "reset"
          ? "重置登录密码"
          : "欢迎回来";

  const submitDisabled =
    busy ||
    sendingOtp ||
    (Boolean(config.turnstileSiteKey) &&
      (mode === "signup" ||
        (mode === "signin" && signInMethod === "password") ||
        (mode === "signin" && signInMethod === "otp" && !otpSent) ||
        (mode === "reset" && !otpSent)) &&
      (!captchaReady || !captchaToken));

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="brand auth-brand">
          <span className="brand-mark">
            <BookOpen size={19} />
          </span>
          <span className="brand-wordmark">Shiyi</span>
        </div>
        <div className="auth-story-content">
          <h1>
            每一道题，
            <br />
            <span>都能说清楚。</span>
          </h1>
          <p className="auth-intro">
            整理属于自己的面试答案库，先合上原文默写一遍，再跟着记忆曲线把每个知识点稳稳内化成自己的表达。
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <NotebookSketch />
          </div>
        </div>
      </section>
      <section className="auth-form-side">
        <div className="auth-form-wrap">
          <div className="auth-mobile-brand">
            <span className="brand-mark">
              <BookOpen size={17} />
            </span>
            <div>
              <span className="brand-wordmark">Shiyi</span>
              <span className="auth-mobile-tagline">
                把每一道题内化成自己的表达
              </span>
            </div>
          </div>
          <div className="auth-small-mark">
            {mode === "verify-email" ? (
              <MailCheck size={24} />
            ) : mode === "reset" ? (
              <KeyRound size={24} />
            ) : (
              <BookOpen size={24} />
            )}
          </div>
          <h2>{heading}</h2>

          {mode === "signin" && config.emailOtpEnabled && (
            <div className="auth-method-tabs" role="tablist" aria-label="登录方式">
              <button
                type="button"
                role="tab"
                aria-selected={signInMethod === "password"}
                className={signInMethod === "password" ? "is-active" : ""}
                onClick={() => {
                  setSignInMethod("password");
                  setOtpSent(false);
                  setOtp("");
                  setError("");
                  setNotice("");
                }}
              >
                密码登录
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={signInMethod === "otp"}
                className={signInMethod === "otp" ? "is-active" : ""}
                onClick={() => {
                  setSignInMethod("otp");
                  setOtpSent(false);
                  setOtp("");
                  setError("");
                  setNotice("");
                }}
              >
                验证码登录
              </button>
            </div>
          )}

          <form onSubmit={submit} className="auth-form">
            {mode === "signup" && (
              <label className="field">
                怎么称呼你
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="nickname"
                  placeholder="希望怎么称呼你"
                  required
                  minLength={1}
                  maxLength={50}
                />
              </label>
            )}

            <label className="field">
              邮箱
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                required
                readOnly={mode === "verify-email"}
                maxLength={254}
              />
            </label>

            {(mode === "signup" ||
              (mode === "signin" && signInMethod === "password") ||
              (mode === "reset" && otpSent)) && (
              <label className="field">
                {mode === "reset" ? "新密码" : "密码"}
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    mode === "signup" || mode === "reset"
                      ? "new-password"
                      : "current-password"
                  }
                  placeholder={
                    mode === "signup" || mode === "reset"
                      ? "设置至少 8 位登录密码"
                      : "输入你的密码"
                  }
                  required
                  minLength={8}
                  maxLength={128}
                />
              </label>
            )}

            {(mode === "verify-email" ||
              (mode === "signin" && signInMethod === "otp" && otpSent) ||
              (mode === "reset" && otpSent)) && (
              <label className="field">
                邮箱验证码
                <div className="auth-otp-row">
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={otp}
                    onChange={(e) =>
                      setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder="输入 6 位数字验证码"
                    required
                  />
                  <button
                    type="button"
                    className="auth-resend-btn"
                    disabled={
                      sendingOtp ||
                      cooldown > 0 ||
                      (Boolean(config.turnstileSiteKey) && !captchaToken)
                    }
                    onClick={() =>
                      void sendOtpCode(
                        mode === "verify-email"
                          ? "email-verification"
                          : mode === "reset"
                            ? "forget-password"
                            : "sign-in",
                      )
                    }
                  >
                    {sendingOtp
                      ? "发送中…"
                      : cooldown > 0
                        ? `${cooldown}s`
                        : "重新发送"}
                  </button>
                </div>
              </label>
            )}

            {needsTurnstile && config.turnstileSiteKey && (
              <div className="auth-turnstile-wrap">
                <div ref={turnstileRef} />
                {!captchaReady && (
                  <p className="auth-turnstile-hint">正在加载人机验证…</p>
                )}
              </div>
            )}

            {notice && (
              <p className="auth-notice" role="status">
                {notice}
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" size="lg" disabled={submitDisabled}>
              {busy || sendingOtp ? (
                <Loader2 size={18} className="spin" />
              ) : null}
              {mode === "signup"
                ? "创建账号"
                : mode === "verify-email"
                  ? "验证并进入拾忆"
                  : mode === "reset"
                    ? otpSent
                      ? "确认重置密码"
                      : "发送重置验证码"
                    : signInMethod === "otp" && !otpSent
                      ? "获取登录验证码"
                      : "登录拾忆"}
              <ArrowRight size={17} />
            </Button>
          </form>

          {mode === "signin" && config.emailOtpEnabled && (
            <p className="auth-aux-links">
              <button type="button" onClick={() => switchMode("reset")}>
                忘记密码？
              </button>
            </p>
          )}

          <p className="auth-switch">
            {mode === "signin" ? "还没有账号？" : "已经有账号？"}
            <button
              type="button"
              onClick={() =>
                switchMode(mode === "signin" ? "signup" : "signin")
              }
            >
              {mode === "signin" ? "创建一个" : "直接登录"}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}
