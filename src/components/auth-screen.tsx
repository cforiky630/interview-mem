"use client";
import { useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "./ui/button";
import { NotebookSketch } from "./sketch";

export function AuthScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "signup"
          ? await authClient.signUp.email({ email, password, name })
          : await authClient.signIn.email({ email, password });
      if (result.error)
        setError(
          result.error.status === 429
            ? "操作太频繁，请稍后再试。"
            : result.error.code === "INVALID_EMAIL_OR_PASSWORD"
              ? "邮箱或密码不正确。"
              : result.error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
                ? "邮箱已经注册，可以直接登录。"
                : (result.error.message ?? "暂时无法登录，请重试。"),
        );
    } catch {
      setError("连接失败，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }
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
            <BookOpen size={24} />
          </div>
          <h2>{mode === "signin" ? "欢迎回来" : "开始你的积累"}</h2>
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
                maxLength={254}
              />
            </label>
            <label className="field">
              密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
                placeholder={
                  mode === "signup" ? "设置至少 8 位登录密码" : "输入你的密码"
                }
                required
                minLength={8}
                maxLength={128}
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" disabled={busy}>
              {busy ? <Loader2 size={18} className="spin" /> : null}
              {mode === "signin" ? "登录拾忆" : "创建账号"}
              <ArrowRight size={17} />
            </Button>
          </form>
          <p className="auth-switch">
            {mode === "signin" ? "还没有账号？" : "已经有账号？"}
            <button
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError("");
              }}
            >
              {mode === "signin" ? "创建一个" : "直接登录"}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}
