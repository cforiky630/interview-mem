import { AppError } from "./errors";

export type OtpEmailType =
  | "sign-in"
  | "email-verification"
  | "forget-password"
  | "change-email";

export function isEmailOtpEnabled(env = process.env): boolean {
  if (env.RESEND_API_KEY?.trim() && env.EMAIL_FROM?.trim()) return true;
  return env.NODE_ENV !== "production" && env.EMAIL_DEV_LOG === "true";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function subjectFor(type: OtpEmailType): { subject: string; actionLabel: string } {
  switch (type) {
    case "email-verification":
      return { subject: "拾忆 · 注册邮箱验证码", actionLabel: "完成注册验证" };
    case "sign-in":
      return { subject: "拾忆 · 登录验证码", actionLabel: "登录你的拾忆账号" };
    case "forget-password":
      return { subject: "拾忆 · 重置密码验证码", actionLabel: "重置登录密码" };
    default:
      return { subject: "拾忆 · 邮箱验证码", actionLabel: "确认邮箱操作" };
  }
}

export async function sendOtpEmail({
  email,
  otp,
  type,
}: {
  email: string;
  otp: string;
  type: OtpEmailType;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();

  if (!apiKey || !from) {
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.EMAIL_DEV_LOG === "true"
    ) {
      console.info(`[EMAIL_DEV_LOG] type=${type} to=${email} otp=${otp}`);
      return;
    }
    throw new AppError(503, "邮箱验证码服务尚未配置。");
  }

  const { subject, actionLabel } = subjectFor(type);
  const safeOtp = escapeHtml(otp);
  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#17211d;background:#f8faf9;border-radius:12px;">`,
    `<h2 style="margin:0 0 12px;font-size:18px;">拾忆 · ${actionLabel}</h2>`,
    `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;">请使用下方 6 位验证码${actionLabel}，5 分钟内有效，最多可验证 3 次：</p>`,
    `<div style="font-size:28px;font-weight:700;letter-spacing:6px;padding:14px 18px;background:#ffffff;border:1px solid #d7e2dc;border-radius:10px;text-align:center;">${safeOtp}</div>`,
    `<p style="margin:16px 0 0;font-size:12px;color:#5a6b64;">如非本人操作，请忽略此邮件，切勿将验证码告知他人。</p>`,
    `</div>`,
  ].join("");
  const text = `拾忆验证码：${otp}（用于${actionLabel}，5 分钟内有效）。如非本人操作请忽略。`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject,
      html,
      text,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    console.error(`Resend email failed with status ${response.status}.`);
    throw new AppError(502, "验证码邮件发送失败，请稍后重试。");
  }
}
