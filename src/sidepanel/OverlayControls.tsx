// ============================================================
// Disclora — shared side-panel controls
// ============================================================

export function Switch({
  checked,
  onChange,
  label,
  on,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  on: string; // active colour class
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={`${label} ${checked ? 'on' : 'off'}`}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 ${
        checked ? on : 'bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
