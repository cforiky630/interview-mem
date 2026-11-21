"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Download, Moon, Sparkles, Sun, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import type { Workspace } from "@/lib/types";
import { AiConnectionForm } from "./ai-connection-form";
import type { Mutate } from "./dialogs";
import { Button } from "./ui/button";
import { useDiscretePresence } from "./use-discrete-presence";

export type SettingsTab = "ai" | "study" | "data";

export function SettingsCard({
  open,
  tab,
  onTabChange,
  anchor,
  onClose,
  data,
  mutate,
  palette = "forest",
  onPaletteChange,
}: {
  open: boolean;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  anchor: HTMLElement | null;
  onClose: () => void;
  data: Workspace;
  mutate: Mutate;
  palette?: "forest" | "lavender";
  onPaletteChange?: (palette: "forest" | "lavender") => void;
}) {
  const [goal, setGoal] = useState(data.settings.dailyGoal);
  const [newLimit, setNewLimit] = useState(data.settings.dailyNewLimit);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(data.settings.theme);
  const [draftPalette, setDraftPalette] = useState<"forest" | "lavender">(
    palette,
  );
  const [isMobile, setIsMobile] = useState(false);
  const [dragY, setDragY] = useState(0);

  const sheetTouch = useRef<{
    x: number;
    y: number;
    time: number;
    locked: "v" | "h" | null;
  } | null>(null);

  const backdropPresence = useDiscretePresence<HTMLButtonElement>(open);
  const cardPresence = useDiscretePresence<HTMLElement>(open);

  useEffect(() => {
    if (open) {
      setGoal(data.settings.dailyGoal);
      setNewLimit(data.settings.dailyNewLimit);
      setTheme(data.settings.theme);
      setDraftPalette(palette);
      setDragY(0);
    }
  }, [
    open,
    palette,
    data.settings.dailyGoal,
    data.settings.dailyNewLimit,
    data.settings.theme,
  ]);

  const closeWithRollback = useCallback(() => {
    document.documentElement.dataset.theme = data.settings.theme;
    document.documentElement.dataset.palette = palette;
    onClose();
  }, [data.settings.theme, palette, onClose]);

  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(max-width: 760px)");
    if (!mq.matches) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, [open]);

  useLayoutEffect(() => {
    const card = cardPresence.ref.current;
    if (!open || !card) return;

    const vv = window.visualViewport;
    let rafId = 0;

    const place = () => {
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      setIsMobile(mobile);
      if (mobile) {
        card.style.left = "";
        card.style.top = "";
        card.style.maxHeight = "";
        card.style.transformOrigin = "";
        card.dataset.placement = "sheet";
        return;
      }

      const vLeft = vv?.offsetLeft ?? 0;
      const vTop = vv?.offsetTop ?? 0;
      const vWidth = vv?.width ?? document.documentElement.clientWidth;
      const vHeight = vv?.height ?? window.innerHeight;
      const margin = 16;
      const gap = 10;
      const cardWidth = Math.min(436, Math.max(280, vWidth - margin * 2));
      const maxH = Math.min(660, Math.max(260, vHeight - 88));
      card.style.maxHeight = `${maxH}px`;
      const cardH = Math.min(maxH, Math.max(320, card.offsetHeight || maxH));

      const activeAnchor = anchor && anchor.isConnected ? anchor : null;
      const rect = activeAnchor ? activeAnchor.getBoundingClientRect() : null;
      const hasRect = !!rect && (rect.width > 0 || rect.height > 0);

      let left = vLeft + vWidth - 20 - cardWidth;
      let top = vTop + 68;
      let origin = "top right";
      let placement: "sidebar" | "ai-side" | "overlay" | "topbar" = "topbar";

      if (hasRect && activeAnchor?.closest(".sidebar")) {
        left = Math.min(rect.right + 12, vLeft + vWidth - margin - cardWidth);
        top = Math.max(
          vTop + margin,
          Math.min(rect.bottom - cardH, vTop + vHeight - margin - cardH),
        );
        origin = "bottom left";
        placement = "sidebar";
      } else if (hasRect && activeAnchor?.closest(".ai-island-panel")) {
        const aiPanel = activeAnchor.closest(
          ".ai-island-panel",
        ) as HTMLElement;
        const panelRect = aiPanel.getBoundingClientRect();
        if (panelRect.left - gap - cardWidth >= vLeft + margin) {
          left = panelRect.left - gap - cardWidth;
          top = Math.max(
            vTop + 68,
            Math.min(
              rect.top - Math.min(cardH * 0.55, 220),
              vTop + vHeight - margin - cardH,
            ),
          );
          origin =
            rect.top > vTop + vHeight * 0.55 ? "bottom right" : "top right";
          placement = "ai-side";
        } else {
          left = vLeft + vWidth - margin - cardWidth;
          top = Math.max(
            vTop + 68,
            Math.min(rect.top - cardH - gap, vTop + vHeight - margin - cardH),
          );
          origin = "bottom right";
          placement = "overlay";
        }
      } else if (hasRect && rect) {
        left = rect.right - cardWidth;
        top = rect.bottom + gap;
        origin = "top right";
        placement = "topbar";
      }

      left = Math.max(
        vLeft + margin,
        Math.min(left, vLeft + vWidth - margin - cardWidth),
      );
      if (top + cardH > vTop + vHeight - margin) {
        top = Math.max(vTop + margin, vTop + vHeight - margin - cardH);
      }

      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
      card.style.transformOrigin = origin;
      card.dataset.placement = placement;
    };

    const schedulePlace = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        place();
      });
    };

    const onScroll = (event: Event) => {
      if (event.target instanceof Node && card.contains(event.target)) return;
      schedulePlace();
    };

    place();
    window.addEventListener("resize", schedulePlace);
    window.addEventListener("scroll", onScroll, true);
    vv?.addEventListener("resize", schedulePlace);
    vv?.addEventListener("scroll", schedulePlace);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", schedulePlace);
      window.removeEventListener("scroll", onScroll, true);
      vv?.removeEventListener("resize", schedulePlace);
      vv?.removeEventListener("scroll", schedulePlace);
    };
  }, [open, anchor, tab, cardPresence.ref]);

  useEffect(() => {
    if (!open) return;
    const card = cardPresence.ref.current;
    if (!card) return;
    const raf = requestAnimationFrame(() => {
      if (!card.contains(document.activeElement)) {
        card.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, cardPresence.ref]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (window.matchMedia("(max-width: 760px)").matches) return;
      const card = cardPresence.ref.current;
      const target = event.target as Element | null;
      if (!card || !target) return;
      if (card.contains(target)) return;
      if (target.closest("[data-settings-trigger]")) return;
      if (target.closest("[data-sonner-toaster]")) return;
      closeWithRollback();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const card = cardPresence.ref.current;
      try {
        if (card?.querySelector("select:open")) return;
      } catch {
        /* Ignore in browsers without :open pseudo-class support. */
      }
      event.preventDefault();
      event.stopPropagation();
      closeWithRollback();
      if (anchor && anchor.isConnected) {
        requestAnimationFrame(() => anchor.focus({ preventScroll: true }));
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, anchor, closeWithRollback, cardPresence.ref]);

  async function savePreferences() {
    setBusy(true);
    try {
      onPaletteChange?.(draftPalette);
      const result = await mutate("/api/settings", {
        action: "preferences",
        dailyGoal: Number(goal),
        dailyNewLimit: Number(newLimit),
        theme,
        timeZone: data.settings.timeZone,
      });
      if (result) toast.success("学习偏好已保存。");
    } finally {
      setBusy(false);
    }
  }

  async function exportData() {
    setBusy(true);
    try {
      const result = await api("/api/export", undefined, {
        userId: data.user.id,
      });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `shiyi-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "导出失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={backdropPresence.ref}
        type="button"
        hidden={backdropPresence.isHidden}
        data-closing={backdropPresence.isClosing ? "" : undefined}
        aria-hidden={!open}
        inert={!open || backdropPresence.isClosing}
        className="settings-card-backdrop"
        aria-label="收起设置"
        onClick={closeWithRollback}
      />
      <aside
        ref={cardPresence.ref}
        id="settings-floating-card"
        role={open ? "dialog" : undefined}
        aria-modal={isMobile ? "true" : "false"}
        aria-labelledby="settings-card-title"
        aria-describedby="settings-card-desc"
        aria-hidden={!open}
        inert={!open || cardPresence.isClosing}
        hidden={cardPresence.isHidden}
        data-closing={cardPresence.isClosing ? "" : undefined}
        tabIndex={-1}
        className="settings-card"
        style={
          dragY > 0
            ? { translate: `0 ${dragY}px`, transition: "none" }
            : undefined
        }
      >
        <div
          className="settings-card-handle"
          onTouchStart={(event) => {
            if (event.touches.length !== 1) return;
            if (!window.matchMedia("(max-width: 760px)").matches) return;
            const touch = event.touches[0];
            sheetTouch.current = {
              x: touch.clientX,
              y: touch.clientY,
              time: Date.now(),
              locked: null,
            };
          }}
          onTouchMove={(event) => {
            const state = sheetTouch.current;
            if (!state || event.touches.length !== 1) return;
            const touch = event.touches[0];
            const dx = touch.clientX - state.x;
            const dy = touch.clientY - state.y;
            if (!state.locked) {
              if (Math.hypot(dx, dy) < 8) return;
              state.locked =
                dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.2 ? "v" : "h";
            }
            if (state.locked === "v") {
              setDragY(Math.max(0, dy));
            }
          }}
          onTouchEnd={(event) => {
            const state = sheetTouch.current;
            sheetTouch.current = null;
            if (!state || state.locked !== "v") {
              setDragY(0);
              return;
            }
            const endY = event.changedTouches[0]?.clientY ?? state.y;
            const dy = endY - state.y;
            const velocity = dy / Math.max(1, Date.now() - state.time);
            setDragY(0);
            if (dy > 90 || velocity > 0.45) {
              closeWithRollback();
            }
          }}
          onTouchCancel={() => {
            sheetTouch.current = null;
            setDragY(0);
          }}
        >
          <div className="sheet-grabber" aria-hidden="true" />
          <div className="settings-card-header">
            <div className="settings-card-title-row">
              <h2 id="settings-card-title">偏好与 AI 配置</h2>
              <span
                className={`settings-card-status ${data.settings.hasKey ? "is-connected" : ""}`}
              >
                <i aria-hidden="true" />
                {data.settings.hasKey
                  ? data.settings.model || "已连接"
                  : "未配置 AI"}
              </span>
            </div>
            <p id="settings-card-desc" className="sr-only">
              管理 AI 连接、学习偏好与数据备份。
            </p>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭设置"
              onClick={closeWithRollback}
            >
              <X size={17} />
            </button>
          </div>
        </div>
        <div
          className="settings-card-tabs"
          role="tablist"
          aria-label="配置分类"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "ai"}
            className={tab === "ai" ? "selected" : ""}
            onClick={() => onTabChange("ai")}
          >
            <Sparkles size={14} /> AI 连接
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "study"}
            className={tab === "study" ? "selected" : ""}
            onClick={() => onTabChange("study")}
          >
            学习偏好
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "data"}
            className={tab === "data" ? "selected" : ""}
            onClick={() => onTabChange("data")}
          >
            数据导出
          </button>
        </div>
        <div className="settings-card-body">
          {tab === "ai" ? (
            <AiConnectionForm
              userId={data.user.id}
              settings={data.settings}
              mutate={mutate}
            />
          ) : tab === "study" ? (
            <>
              <label className="field">
                每日学习目标
                <div className="goal-input">
                  <input
                    type="number"
                    aria-label="每日学习目标"
                    min={1}
                    max={200}
                    value={goal}
                    onChange={(e) => setGoal(Number(e.target.value))}
                  />
                  <span>道 / 天</span>
                </div>
                <small>同一道题当天只计一次；到期复习仍完整显示。</small>
              </label>
              <label className="field">
                每日新题上限
                <div className="goal-input">
                  <input
                    aria-label="每日新题上限"
                    type="number"
                    min={0}
                    max={50}
                    value={newLimit}
                    onChange={(e) => setNewLimit(Number(e.target.value))}
                  />
                  <span>道 / 天</span>
                </div>
                <small>优先复习旧题；设为 0 可暂停新题。</small>
              </label>
              <div className="field">
                主题色系
                <div className="palette-options">
                  <button
                    type="button"
                    className={draftPalette === "forest" ? "selected" : ""}
                    aria-pressed={draftPalette === "forest"}
                    onClick={() => {
                      setDraftPalette("forest");
                      document.documentElement.dataset.palette = "forest";
                    }}
                  >
                    {draftPalette === "forest" && (
                      <span className="option-check" aria-hidden="true">
                        <Check size={12} />
                      </span>
                    )}
                    <span className="palette-swatches" aria-hidden="true">
                      <i style={{ background: "#1A6347" }} />
                      <i style={{ background: "#4EC496" }} />
                      <i style={{ background: "#EFF3F1" }} />
                      <i style={{ background: "#0C0F0E" }} />
                    </span>
                    <span className="palette-card-text">
                      <strong>青瓷 · 松影</strong>
                      <small>晨光白与玄玉夜</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={draftPalette === "lavender" ? "selected" : ""}
                    aria-pressed={draftPalette === "lavender"}
                    onClick={() => {
                      setDraftPalette("lavender");
                      document.documentElement.dataset.palette = "lavender";
                    }}
                  >
                    {draftPalette === "lavender" && (
                      <span className="option-check" aria-hidden="true">
                        <Check size={12} />
                      </span>
                    )}
                    <span className="palette-swatches" aria-hidden="true">
                      <i style={{ background: "#5D4B99" }} />
                      <i style={{ background: "#A796F0" }} />
                      <i style={{ background: "#F0ECF5" }} />
                      <i style={{ background: "#0D0C13" }} />
                    </span>
                    <span className="palette-card-text">
                      <strong>雾紫 · 星鸢</strong>
                      <small>月霜白与星夜紫</small>
                    </span>
                  </button>
                </div>
              </div>
              <div className="field">
                明暗模式
                <div className="theme-options">
                  <button
                    type="button"
                    className={theme === "light" ? "selected" : ""}
                    aria-pressed={theme === "light"}
                    onClick={() => {
                      setTheme("light");
                      document.documentElement.dataset.theme = "light";
                    }}
                  >
                    {theme === "light" && (
                      <span className="option-check" aria-hidden="true">
                        <Check size={12} />
                      </span>
                    )}
                    <Sun size={22} /> 清晨 · 浅色
                  </button>
                  <button
                    type="button"
                    className={theme === "dark" ? "selected" : ""}
                    aria-pressed={theme === "dark"}
                    onClick={() => {
                      setTheme("dark");
                      document.documentElement.dataset.theme = "dark";
                    }}
                  >
                    {theme === "dark" && (
                      <span className="option-check" aria-hidden="true">
                        <Check size={12} />
                      </span>
                    )}
                    <Moon size={22} /> 夜读 · 深色
                  </button>
                </div>
              </div>
              <Button
                disabled={
                  busy || goal < 1 || goal > 200 || newLimit < 0 || newLimit > 50
                }
                onClick={() => void savePreferences()}
              >
                保存学习偏好
              </Button>
            </>
          ) : (
            <div className="settings-export-panel">
              <div className="export-illustration">
                <Download size={32} />
              </div>
              <h3>你的积累，随时带走。</h3>
              <p className="muted">
                导出题库、笔记、复习记录、原文与 AI 对话的 JSON 备份（不含 API
                Key）。
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void exportData()}
              >
                <Download size={16} /> 导出我的数据
              </Button>
              <p className="muted small">
                当前支持导出备份文件，暂不支持导入恢复。
              </p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
