import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...values: ClassValue[]) {
  return twMerge(clsx(values));
}
export function createUuid(): string {
  const cryptoObj = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoObj?.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
export function dateKey(date: Date | string, timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(date));
}
export function relativeDue(due: string | Date | undefined) {
  if (!due) return "尚未学习";
  const minutes = (new Date(due).getTime() - Date.now()) / 60_000;
  if (minutes <= 0) return "现在复习";
  if (minutes < 60) return `${Math.ceil(minutes)} 分钟后`;
  if (minutes < 1440) return `${Math.ceil(minutes / 60)} 小时后`;
  return `${Math.ceil(minutes / 1440)} 天后`;
}
export function readableInterval(due: Date, now = new Date()) {
  const minutes = Math.max(
    1,
    Math.round((due.getTime() - now.getTime()) / 60_000),
  );
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / 1440)} 天`;
}
