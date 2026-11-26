"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Check,
  Download,
  Keyboard,
  LogOut,
  Moon,
  Palette as PaletteIcon,
  Plug,
  SlidersHorizontal,
  Sun,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { getDeviceProfile, useDeviceProfile } from "@/lib/device-profile";
import {
  setAppearancePalette,
  setAppearanceTheme,
  useAppearance,
} from "@/lib/theme";
import { userInitials } from "@/lib/user-display";
import type { Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AiConnectionForm } from "./ai-connection-form";
import type { Mutate } from "./dialogs";
import { Button } from "./ui/button";
import { useDiscretePresence } from "./use-discrete-presence";
import "./settings-card.css";

export type SettingsTab =
  | "study"
  | "appearance"
  | "ai"
  | "shortcuts"
  | "data";

const NAV_ITEMS: {
  id: SettingsTab;
  label: string;
  title: string;
  subtitle: string;
}[] = [
  {
    id: "study",
    label: "学习偏好",
    title: "学习偏好",
    subtitle: "设定每日学习节奏、新题上限与打卡时区。",
  },
  {
    id: "appearance",
    label: "外观主题",
    title: "外观主题",
    subtitle: "选择界面色系与明暗模式，修改立即生效。",
  },
  {
    id: "ai",
    label: "AI 模型",
    title: "AI 模型",
    subtitle: "配置 OpenAI 兼容模型地址、API Key 与默认模型。",
  },
  {
    id: "shortcuts",
    label: "快捷键",
    title: "快捷键",
    subtitle: "常用键盘操作一览，提升检索与复习效率。",
  },
  {
    id: "data",
    label: "数据与备份",
    title: "数据与备份",
    subtitle: "查看知识库概览并随时导出完整的本地 JSON 备份。",
  },
];

const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: "Asia/Shanghai", label: "中国标准时间 (Asia/Shanghai)" },
  { value: "Asia/Tokyo", label: "日本标准时间 (Asia/Tokyo)" },
  { value: "Asia/Singapore", label: "新加坡 (Asia/Singapore)" },
  { value: "Europe/London", label: "伦敦 (Europe/London)" },
  { value: "America/New_York", label: "美东时间 (America/New_York)" },
  { value: "America/Los_Angeles", label: "美西时间 (America/Los_Angeles)" },
  { value: "UTC", label: "协调世界时 (UTC)" },
];

function detectBrowserTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || /^[+-]\d/.test(tz) || tz.length > 60) return null;
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function AppearanceSettingsSection() {
  const { theme: activeTheme, palette } = useAppearance();
  return (
    <>
      <section className="settings-section-group">
        <h3>主题色系</h3>
        <div className="settings-option-grid">
          <button
            type="button"
            className={cn(
              "settings-option-card",
              palette === "forest" && "is-selected",
            )}
            aria-pressed={palette === "forest"}
            onClick={() => setAppearancePalette("forest")}
          >
            {palette === "forest" && (
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
            className={cn(
              "settings-option-card",
              palette === "lavender" && "is-selected",
            )}
            aria-pressed={palette === "lavender"}
            onClick={() => setAppearancePalette("lavender")}
          >
            {palette === "lavender" && (
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
      </section>

      <section className="settings-section-group">
        <h3>明暗模式</h3>
        <div className="settings-option-grid">
          <button
            type="button"
            className={cn(
              "settings-option-card is-theme",
              activeTheme === "light" && "is-selected",
            )}
            aria-pressed={activeTheme === "light"}
            onClick={() => setAppearanceTheme("light")}
          >
            {activeTheme === "light" && (
              <span className="option-check" aria-hidden="true">
                <Check size={12} />
              </span>
            )}
            <Sun size={20} />
            <span className="palette-card-text">
              <strong>清晨 · 浅色</strong>
              <small>柔和纸感，适合日间阅读</small>
            </span>
          </button>

          <button
            type="button"
            className={cn(
              "settings-option-card is-theme",
              activeTheme === "dark" && "is-selected",
            )}
            aria-pressed={activeTheme === "dark"}
            onClick={() => setAppearanceTheme("dark")}
          >
            {activeTheme === "dark" && (
              <span className="option-check" aria-hidden="true">
                <Check size={12} />
              </span>
            )}
            <Moon size={20} />
            <span className="palette-card-text">
              <strong>夜读 · 深色</strong>
              <small>低眩光暗面，适合夜间专注</small>
            </span>
          </button>
        </div>
        <p className="settings-group-desc">
          外观切换立即生效，并与页面右上角的快捷按钮实时同步。
        </p>
      </section>
    </>
  );
}

export function SettingsCard({
  open,
  tab,
  onTabChange,
  onClose,
  data,
  mutate,
  onRefreshWorkspace,
  onSignOut,
}: {
  open: boolean;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
  data: Workspace;
  mutate: Mutate;
  onRefreshWorkspace?: () => Promise<unknown>;
  onSignOut: () => void;
}) {
  const [goal, setGoal] = useState(data.settings.dailyGoal);
  const [newLimit, setNewLimit] = useState(data.settings.dailyNewLimit);
  const [timeZone, setTimeZone] = useState(data.settings.timeZone);
  const [busy, setBusy] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [aiSessionSeq, setAiSessionSeq] = useState(0);
  const [isMac, setIsMac] = useState(false);
  const [restorePreview, setRestorePreview] = useState<{
    fileName: string;
    exportedAt: string;
    decks: number;
    questions: number;
    reviews: number;
    payload: Record<string, unknown>;
  } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const { isMobileShell } = useDeviceProfile();

  const wasOpenRef = useRef(false);
  const prevTabRef = useRef<SettingsTab>(tab);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const sheetTouch = useRef<{
    x: number;
    y: number;
    time: number;
    locked: "v" | "h" | null;
  } | null>(null);

  const backdropPresence = useDiscretePresence<HTMLButtonElement>(open);
  const modalPresence = useDiscretePresence<HTMLElement>(open);

  useEffect(() => {
    setIsMac(
      /Mac|iPhone|iPad|iPod/i.test(
        navigator.platform || navigator.userAgent || "",
      ),
    );
  }, []);

  const timeZoneOptions = useMemo(() => {
    const browserTz = detectBrowserTimeZone();
    const list: { value: string; label: string }[] = [];
    const seen = new Set<string>();

    if (browserTz && !COMMON_TIMEZONES.some((z) => z.value === browserTz)) {
      list.push({ value: browserTz, label: `本机时区 (${browserTz})` });
      seen.add(browserTz);
    }

    for (const item of COMMON_TIMEZONES) {
      if (seen.has(item.value)) continue;
      seen.add(item.value);
      list.push({
        value: item.value,
        label:
          browserTz === item.value ? `${item.label} · 本机` : item.label,
      });
    }

    if (data.settings.timeZone && !seen.has(data.settings.timeZone)) {
      list.unshift({
        value: data.settings.timeZone,
        label: `当前设置 (${data.settings.timeZone})`,
      });
      seen.add(data.settings.timeZone);
    }

    return list;
  }, [data.settings.timeZone]);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    const enteredAi =
      open &&
      tab === "ai" &&
      (!wasOpenRef.current || prevTabRef.current !== "ai");

    if (justOpened) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setGoal(data.settings.dailyGoal);
      setNewLimit(data.settings.dailyNewLimit);
      setTimeZone(data.settings.timeZone);
      setDragY(0);
    } else if (open && tab !== "study") {
      setGoal(data.settings.dailyGoal);
      setNewLimit(data.settings.dailyNewLimit);
      setTimeZone(data.settings.timeZone);
    }

    if (enteredAi) {
      setAiSessionSeq((s) => s + 1);
    }

    wasOpenRef.current = open;
    prevTabRef.current = tab;
  }, [
    open,
    tab,
    data.settings.dailyGoal,
    data.settings.dailyNewLimit,
    data.settings.timeZone,
  ]);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
  }, [tab, open]);

  useEffect(() => {
    if (!open) return;
    const modal = modalPresence.ref.current;
    if (!modal) return;
    const raf = requestAnimationFrame(() => {
      if (!modal.contains(document.activeElement)) {
        modal.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, modalPresence.ref]);

  useEffect(() => {
    if (!open || !isMobileShell) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open, isMobileShell]);

  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    const prev = previousFocusRef.current;
    if (
      prev &&
      prev.isConnected &&
      getComputedStyle(prev).visibility !== "hidden" &&
      getComputedStyle(prev).display !== "none"
    ) {
      requestAnimationFrame(() => prev.focus({ preventScroll: true }));
    }
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const modal = modalPresence.ref.current;
      try {
        if (modal?.querySelector("select:open")) return;
      } catch {
        /* Ignore in browsers without :open pseudo-class support. */
      }
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, closeAndRestoreFocus, modalPresence.ref]);

  function handleNavKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const keys = [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
    ];
    if (!keys.includes(event.key)) return;
    const idx = NAV_ITEMS.findIndex((item) => item.id === tab);
    if (idx < 0) return;
    event.preventDefault();
    let nextIdx = idx;
    if (event.key === "Home") nextIdx = 0;
    else if (event.key === "End") nextIdx = NAV_ITEMS.length - 1;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      nextIdx = (idx - 1 + NAV_ITEMS.length) % NAV_ITEMS.length;
    else if (event.key === "ArrowDown" || event.key === "ArrowRight")
      nextIdx = (idx + 1) % NAV_ITEMS.length;
    const nextItem = NAV_ITEMS[nextIdx];
    if (!nextItem) return;
    onTabChange(nextItem.id);
    const buttons =
      navRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']");
    buttons?.[nextIdx]?.focus({ preventScroll: true });
  }

  const studyChanged =
    goal !== data.settings.dailyGoal ||
    newLimit !== data.settings.dailyNewLimit ||
    timeZone !== data.settings.timeZone;
  const studyInvalid =
    !Number.isInteger(goal) ||
    goal < 1 ||
    goal > 200 ||
    !Number.isInteger(newLimit) ||
    newLimit < 0 ||
    newLimit > 50 ||
    !timeZone;

  async function savePreferences() {
    if (busy || !studyChanged || studyInvalid) return;
    setBusy(true);
    try {
      const result = await mutate("/api/settings", {
        action: "preferences",
        dailyGoal: goal,
        dailyNewLimit: newLimit,
        timeZone,
      });
      if (result) {
        toast.success("学习偏好已保存。");
      }
    } finally {
      setBusy(false);
    }
  }

  async function exportData() {
    if (busy) return;
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
      toast.success("数据备份已开始下载。");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "导出失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectRestoreFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      toast.error("备份文件过大（最大支持 20 MB）。");
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        parsed.format !== "shiyi-backup" ||
        (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3)
      ) {
        toast.error("请选择有效的拾忆 JSON 备份文件。");
        return;
      }
      setRestorePreview({
        fileName: file.name,
        exportedAt:
          typeof parsed.exportedAt === "string" ? parsed.exportedAt : "",
        decks: Array.isArray(parsed.decks) ? parsed.decks.length : 0,
        questions: Array.isArray(parsed.questions) ? parsed.questions.length : 0,
        reviews: Array.isArray(parsed.reviews) ? parsed.reviews.length : 0,
        payload: parsed,
      });
    } catch {
      toast.error("备份文件无法解析，请确认文件完整且为 JSON 格式。");
    }
  }

  async function confirmRestoreBackup() {
    if (!restorePreview || restoreBusy) return;
    setRestoreBusy(true);
    try {
      const res = await api<{
        ok: boolean;
        restored: {
          decks: number;
          questions: number;
          studyCards: number;
          reviews: number;
          preferencesRestored?: boolean;
        };
        skipped: {
          decks: number;
          questions: number;
        };
      }>("/api/backup/restore", restorePreview.payload, {
        userId: data.user.id,
      });
      await onRefreshWorkspace?.();
      setRestorePreview(null);
      toast.success(
        `已合并恢复：新增 ${res.restored.decks} 个题库、${res.restored.questions} 道题、${res.restored.reviews} 条复习记录。`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "恢复备份失败，请重试。",
      );
    } finally {
      setRestoreBusy(false);
    }
  }

  const currentSection =
    NAV_ITEMS.find((item) => item.id === tab) ?? NAV_ITEMS[0];
  const modKey = isMac ? "⌘" : "Ctrl";
  const totalReviews =
    data.stats.totalReviews ||
    data.activity.reduce((sum, item) => sum + item.count, 0);

  const renderNavIcon = (id: SettingsTab) => {
    switch (id) {
      case "study":
        return <SlidersHorizontal size={15} />;
      case "appearance":
        return <PaletteIcon size={15} />;
      case "ai":
        return <Plug size={15} />;
      case "shortcuts":
        return <Keyboard size={15} />;
      case "data":
        return <Download size={15} />;
    }
  };

  return (
    <>
      <button
        ref={backdropPresence.ref}
        type="button"
        hidden={backdropPresence.isHidden}
        data-closing={backdropPresence.isClosing ? "" : undefined}
        aria-hidden="true"
        tabIndex={-1}
        inert={!open || backdropPresence.isClosing}
        className="settings-modal-backdrop"
        onClick={onClose}
      />
      <aside
        ref={modalPresence.ref}
        id="settings-modal"
        role={open ? "dialog" : undefined}
        aria-modal="true"
        aria-labelledby="settings-card-title"
        aria-describedby="settings-card-desc"
        aria-hidden={!open}
        inert={!open || modalPresence.isClosing}
        hidden={modalPresence.isHidden}
        data-closing={modalPresence.isClosing ? "" : undefined}
        tabIndex={-1}
        className="settings-modal"
        style={
          dragY > 0
            ? { translate: `0 ${dragY}px`, transition: "none" }
            : undefined
        }
      >
        <div
          className="settings-modal-handle"
          onTouchStart={(event) => {
            if (event.touches.length !== 1) return;
            if (!getDeviceProfile().isMobileShell) return;
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
            if (dy > 90 || velocity > 0.45) {
              onClose();
            } else {
              setDragY(0);
            }
          }}
          onTouchCancel={() => {
            sheetTouch.current = null;
            setDragY(0);
          }}
        >
          <div className="sheet-grabber" aria-hidden="true" />
        </div>

        <div className="settings-sidebar">
          <div className="settings-sidebar-heading">设置</div>
          <nav
            ref={navRef}
            className="settings-nav"
            role="tablist"
            aria-label="设置分类"
            onKeyDown={handleNavKeyDown}
          >
            {NAV_ITEMS.map((item) => {
              const active = tab === item.id;
              return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    className={cn("settings-nav-item", active && "is-active")}
                    onClick={() => onTabChange(item.id)}
                  >
                    {renderNavIcon(item.id)}
                    <span>{item.label}</span>
                    {item.id === "ai" && (
                      <span
                        className={cn(
                          "settings-nav-dot",
                          data.settings.hasKey && "is-connected",
                        )}
                        aria-label={data.settings.hasKey ? "已连接" : "未配置"}
                      />
                    )}
                  </button>
              );
            })}
          </nav>

          <div className="settings-sidebar-footer">
            <div className="settings-account-mini">
              <span className="settings-account-avatar" aria-hidden="true">
                {userInitials(data.user.name)}
              </span>
              <div className="settings-account-meta">
                <strong title={data.user.name}>{data.user.name}</strong>
                {data.user.email && (
                  <small title={data.user.email}>{data.user.email}</small>
                )}
              </div>
            </div>
            <button
              type="button"
              className="settings-signout-btn"
              onClick={onSignOut}
            >
              <LogOut size={14} />
              <span>退出登录</span>
            </button>
          </div>
        </div>

        <div className="settings-main">
          <header className="settings-main-header">
            <div>
              <h2 id="settings-card-title">{currentSection.title}</h2>
              <p id="settings-card-desc">{currentSection.subtitle}</p>
            </div>
            <button
              type="button"
              className="icon-button settings-close-btn"
              aria-label="关闭设置"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </header>

          <div ref={bodyRef} className="settings-main-body" role="tabpanel">
            {tab === "study" && (
              <>
                <section className="settings-section-group">
                  <h3>每日节奏</h3>
                  <div className="settings-card-group">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <label htmlFor="settings-daily-goal">
                          每日学习目标
                        </label>
                        <small>
                          同一道题当天只计一次；到期复习仍完整显示。
                        </small>
                      </div>
                      <div className="settings-row-control">
                        <div className="goal-input">
                          <input
                            id="settings-daily-goal"
                            type="number"
                            min={1}
                            max={200}
                            step={1}
                            value={Number.isNaN(goal) ? "" : goal}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setGoal(raw === "" ? Number.NaN : Number(raw));
                            }}
                          />
                          <span>道 / 天</span>
                        </div>
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-row-info">
                        <label htmlFor="settings-daily-new">
                          每日新题上限
                        </label>
                        <small>优先复习旧题；设为 0 可暂停新题。</small>
                      </div>
                      <div className="settings-row-control">
                        <div className="goal-input">
                          <input
                            id="settings-daily-new"
                            type="number"
                            min={0}
                            max={50}
                            step={1}
                            value={Number.isNaN(newLimit) ? "" : newLimit}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setNewLimit(
                                raw === "" ? Number.NaN : Number(raw),
                              );
                            }}
                          />
                          <span>道 / 天</span>
                        </div>
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-row-info">
                        <label htmlFor="settings-timezone">学习时区</label>
                        <small>决定每日进度与打卡日期的切换时刻。</small>
                      </div>
                      <div className="settings-row-control">
                        <select
                          id="settings-timezone"
                          value={timeZone}
                          onChange={(e) => setTimeZone(e.target.value)}
                        >
                          {timeZoneOptions.map((item) => (
                            <option key={item.value} value={item.value}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </section>

                <div className="settings-actions-row">
                  <Button
                    disabled={busy || !studyChanged || studyInvalid}
                    onClick={() => void savePreferences()}
                  >
                    保存更改
                  </Button>
                </div>
              </>
            )}

            {tab === "appearance" && <AppearanceSettingsSection />}

            {tab === "ai" && (
              <div className="settings-ai-wrap">
                <AiConnectionForm
                  key={aiSessionSeq}
                  userId={data.user.id}
                  settings={data.settings}
                  mutate={mutate}
                />
              </div>
            )}

            {tab === "shortcuts" && (
              <>
                <section className="settings-section-group">
                  <h3>全局导航</h3>
                  <div className="settings-card-group">
                    <div className="settings-shortcuts-list">
                      <div className="settings-shortcut-row">
                        <span>搜索题目</span>
                        <span className="settings-shortcut-keys">
                          <kbd>{modKey}</kbd>
                          <kbd>K</kbd>
                          <span className="settings-shortcut-sep">/</span>
                          <kbd>/</kbd>
                        </span>
                      </div>
                      <div className="settings-shortcut-row">
                        <span>展开 / 收起 AI 助手</span>
                        <span className="settings-shortcut-keys">
                          <kbd>{modKey}</kbd>
                          <kbd>J</kbd>
                        </span>
                      </div>
                      <div className="settings-shortcut-row">
                        <span>打开 / 关闭设置</span>
                        <span className="settings-shortcut-keys">
                          <kbd>{modKey}</kbd>
                          <kbd>,</kbd>
                        </span>
                      </div>
                      <div className="settings-shortcut-row">
                        <span>关闭弹层或面板</span>
                        <span className="settings-shortcut-keys">
                          <kbd>Esc</kbd>
                        </span>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="settings-section-group">
                  <h3>阅读与复习</h3>
                  <div className="settings-card-group">
                    <div className="settings-shortcuts-list">
                      <div className="settings-shortcut-row">
                        <span>上一题 / 下一题</span>
                        <span className="settings-shortcut-keys">
                          <kbd>[</kbd>
                          <kbd>]</kbd>
                        </span>
                      </div>
                      <div className="settings-shortcut-row">
                        <span>展开 / 收起侧边批注</span>
                        <span className="settings-shortcut-keys">
                          <kbd>N</kbd>
                        </span>
                      </div>
                      <div className="settings-shortcut-row">
                        <span>显示答案</span>
                        <span className="settings-shortcut-keys">
                          <kbd>Space</kbd>
                        </span>
                      </div>
                      <div className="settings-shortcut-row">
                        <span>复习评分（重来 / 困难 / 良好 / 轻松）</span>
                        <span className="settings-shortcut-keys">
                          <kbd>1</kbd>
                          <kbd>2</kbd>
                          <kbd>3</kbd>
                          <kbd>4</kbd>
                        </span>
                      </div>
                    </div>
                  </div>
                </section>
              </>
            )}

            {tab === "data" && (
              <>
                <section className="settings-section-group">
                  <h3>知识库概览</h3>
                  <div className="settings-backup-summary">
                    <div className="settings-backup-tile">
                      <strong>{data.decks.length}</strong>
                      <span>个题库</span>
                    </div>
                    <div className="settings-backup-tile">
                      <strong>{data.questions.length}</strong>
                      <span>道题目</span>
                    </div>
                    <div className="settings-backup-tile">
                      <strong>{totalReviews}</strong>
                      <span>次复习记录</span>
                    </div>
                  </div>
                </section>

                <section className="settings-section-group">
                  <h3>本地备份与恢复</h3>
                  <div className="settings-card-group">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <strong>导出完整备份 (JSON)</strong>
                        <small>
                          包含题库、分组、发布快照、题目、复习偏好、个人笔记、复习记录与
                          AI 对话，不含 API Key，可用于迁移或合并恢复。
                        </small>
                      </div>
                      <div className="settings-row-control">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || restoreBusy}
                          onClick={() => void exportData()}
                        >
                          <Download size={15} /> 导出备份
                        </Button>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <strong>从备份合并恢复 (JSON)</strong>
                        <small>
                          补全缺失的题库、题目、记忆进度与历史记录；当前账号已存在的数据会保留不被覆盖。
                        </small>
                      </div>
                      <div className="settings-row-control">
                        <input
                          ref={restoreInputRef}
                          type="file"
                          accept=".json,application/json"
                          className="sr-only"
                          aria-label="选择拾忆备份 JSON 文件"
                          onChange={(event) =>
                            void handleSelectRestoreFile(event)
                          }
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || restoreBusy}
                          onClick={() => restoreInputRef.current?.click()}
                        >
                          <Upload size={15} /> 选择备份文件
                        </Button>
                      </div>
                    </div>
                    {restorePreview && (
                      <div className="settings-restore-preview">
                        <div className="settings-restore-meta">
                          <strong>{restorePreview.fileName}</strong>
                          <small>
                            {restorePreview.decks} 个题库 ·{" "}
                            {restorePreview.questions} 道题 ·{" "}
                            {restorePreview.reviews} 条复习记录
                            {restorePreview.exportedAt
                              ? ` · 导出于 ${restorePreview.exportedAt.slice(0, 10)}`
                              : ""}
                          </small>
                        </div>
                        <div className="settings-restore-actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={restoreBusy}
                            onClick={() => setRestorePreview(null)}
                          >
                            取消
                          </Button>
                          <Button
                            size="sm"
                            disabled={restoreBusy}
                            onClick={() => void confirmRestoreBackup()}
                          >
                            {restoreBusy ? "正在恢复…" : "确认合并恢复"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
