export type ToastType = 'success' | 'error' | 'info' | 'loading';

export interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
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

const show = (message: string, type: ToastType = 'info', duration: number = 3000) => {
  const id = Math.random().toString(36).substring(2, 9);
  toasts.push({ id, message, type });
  notify();

  if (duration > 0) {
    setTimeout(() => {
      remove(id);
    }, duration);
  }
  return id;
};

const remove = (id: string) => {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
};

export const toast = {
  success: (msg: string, duration?: number) => show(msg, 'success', duration),
  error: (msg: string, duration?: number) => show(msg, 'error', duration),
  info: (msg: string, duration?: number) => show(msg, 'info', duration),
  loading: (msg: string, duration?: number) => show(msg, 'loading', duration),
  remove,
};
