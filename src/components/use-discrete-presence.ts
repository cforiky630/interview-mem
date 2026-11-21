"use client";
import { useEffect, useRef, useState } from "react";
import { canTransitionDisplay } from "@/lib/motion";

export function useDiscretePresence<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  const [isHidden, setIsHidden] = useState(!open);
  const [isClosing, setIsClosing] = useState(false);
  const wasOpenRef = useRef(open);
  const tokenRef = useRef(0);

  useEffect(() => {
    const token = ++tokenRef.current;
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;

    if (open) {
      setIsClosing(false);
      setIsHidden(false);
      return;
    }
    if (!wasOpen) {
      setIsClosing(false);
      setIsHidden(true);
      return;
    }
    if (canTransitionDisplay()) {
      setIsClosing(false);
      setIsHidden(true);
      return;
    }

    const el = ref.current;
    if (!el) {
      setIsClosing(false);
      setIsHidden(true);
      return;
    }
    setIsHidden(false);
    setIsClosing(true);

    const finish = async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (tokenRef.current !== token) return;
      const animations = el.getAnimations();
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise((resolve) => setTimeout(resolve, 400)),
        ]);
      }
      if (tokenRef.current !== token) return;
      setIsClosing(false);
      setIsHidden(true);
    };
    void finish();
  }, [open]);

  return { ref, isHidden, isClosing };
}
