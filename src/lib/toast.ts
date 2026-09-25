export type ToastType = 'success' | 'error' | 'info' | 'loading';

export interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
  exiting?: boolean;
}

let toasts: ToastMessage[] = [];
let listeners: ((toasts: ToastMessage[]) => void)[] = [];

const notify = () => {
  listeners.forEach((l) => l([...toasts]));
};

export const subscribeToasts = (listener: (toasts: ToastMessage[]) => void) => {
  listeners.push(listener);
  listener([...toasts]);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
};

const show = (message: string, type: ToastType = 'info', duration?: number) => {
  const id = Math.random().toString(36).substring(2, 9);
  const ms = duration !== undefined ? duration : type === 'error' ? 6000 : type === 'loading' ? 0 : 3000;
  // Non-loading toasts (success/error/info) dismiss any active loading toasts,
  // so duration=0 loaders never hang forever. Manual toast.remove(id) still works.
  if (type !== 'loading') {
    const loadingIds = toasts.filter((t) => t.type === 'loading' && !t.exiting).map((t) => t.id);
    loadingIds.forEach((lid) => remove(lid));
  }
  toasts.push({ id, message, type });
  notify();

  if (ms > 0) {
    setTimeout(() => {
      remove(id);
    }, ms);
  }
  return id;
};

const remove = (id: string) => {
  const t = toasts.find(x => x.id === id);
  if (t) t.exiting = true;
  notify();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== id);
    notify();
  }, 220);
};

export const toast = {
  success: (msg: string, duration?: number) => show(msg, 'success', duration),
  error: (msg: string, duration?: number) => show(msg, 'error', duration),
  info: (msg: string, duration?: number) => show(msg, 'info', duration),
  loading: (msg: string, duration?: number) => show(msg, 'loading', duration),
  remove,
};
