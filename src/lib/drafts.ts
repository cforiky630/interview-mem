export function practiceDraftKey(
  userId: string,
  questionId: string,
  revision: number,
  part = "answer",
) {
  return `shiyi:practice:${userId}:${questionId}:v${revision}:${part}`;
}
export function readPracticeDraft(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
export function savePracticeDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
