"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export function ActionMenu({
  label = "更多操作",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // 原生 toggle 事件可能合并、延后；直接检查 DOM 状态，快速重开后 Escape 也能立即关闭。
    const outside = (event: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node))
        ref.current?.removeAttribute("open");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current?.open) {
        ref.current?.removeAttribute("open");
        ref.current?.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <details ref={ref} className="reader-more action-menu">
      <summary className="icon-button" aria-label={label}>
        <MoreHorizontal size={19} />
      </summary>
      <div
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button,a"))
            ref.current?.removeAttribute("open");
        }}
      >
        {children}
      </div>
    </details>
  );
}
