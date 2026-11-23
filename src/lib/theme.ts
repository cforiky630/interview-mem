export type Palette = "forest" | "lavender";

export function syncDocumentTheme(
  theme: "light" | "dark",
  palette: Palette,
) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.palette = palette;
  const color =
    palette === "lavender"
      ? theme === "dark"
        ? "#0D0C13"
        : "#F6F4F8"
      : theme === "dark"
        ? "#0C0F0E"
        : "#F5F7F6";
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute("content", color));
  document
    .querySelectorAll('meta[name="color-scheme"]')
    .forEach((meta) => meta.setAttribute("content", theme));
}
