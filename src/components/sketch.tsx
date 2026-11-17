export function NotebookSketch({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`notebook-sketch ${className}`}
      viewBox="0 0 220 190"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m50 40 112-9 15 130-117 8z"
        fill="var(--accent-soft)"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m39 33 111 3-2 128-113-1z"
        fill="var(--surface)"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M52 35q-5 60-1 128M64 59q29-4 66 1M65 80q28-2 62 0M65 100q30-3 44 0M64 122q23-2 51 1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="m91 104 11 8 21-25"
        stroke="var(--accent)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m151 111 34-59 8 5-35 58-11 9z"
        fill="var(--accent-soft)"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m186 51 4-6q3-3 7 1l2 2q2 2 0 5l-4 5"
        fill="var(--surface)"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="m176 25 2-10m-8 9-7-4m22 7 8-4M22 126l-10-1m9 8-7 5M184 149q17-5 21 6-13 6-21-6Zm0 0q7 13 2 24"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M69 176q55 7 106-1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="2 5"
      />
    </svg>
  );
}
