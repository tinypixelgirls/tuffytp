import { useStudio } from '../store/project';

export function Toasts() {
  const toasts = useStudio((state) => state.toasts);
  const dismissToast = useStudio((state) => state.dismissToast);

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span>{toast.text}</span>
          <button className="icon-button" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
