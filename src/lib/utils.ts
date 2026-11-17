import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...values: ClassValue[]) {
  return twMerge(clsx(values));
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
