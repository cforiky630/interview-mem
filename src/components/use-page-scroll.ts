"use client";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** 在新页面提交后一次恢复位置，避免先把旧页滚到顶部再切换。 */
export function usePageScroll(key: string, ready: boolean) {
  const positions = useRef(new Map<string, number>());
  const active = useRef("");
  const remember = useCallback(() => {
    if (active.current) positions.current.set(active.current, window.scrollY);
  }, []);
  useLayoutEffect(() => {
    if (!ready) return;
    active.current = key;
    window.scrollTo({
      top: positions.current.get(key) ?? 0,
      behavior: "instant",
    });
  }, [key, ready]);
  useEffect(() => {
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, [remember]);
  return remember;
}
