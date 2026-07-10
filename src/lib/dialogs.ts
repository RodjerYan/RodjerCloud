type DialogType = 'alert' | 'confirm';

interface DialogState {
  id: number;
  type: DialogType;
  message: string;
  resolve: (value: boolean) => void;
}

let currentId = 0;
let dialogs: DialogState[] = [];
let listeners: ((dialogs: DialogState[]) => void)[] = [];

const notify = () => {
  listeners.forEach(l => l([...dialogs]));
};

export const subscribeDialogs = (listener: (dialogs: DialogState[]) => void) => {
  listeners.push(listener);
  listener([...dialogs]);
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
};

export const appConfirm = (message: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const id = ++currentId;
    dialogs.push({
      id,
      type: 'confirm',
      message,
      resolve: (val) => {
        dialogs = dialogs.filter(d => d.id !== id);
        notify();
        resolve(val);
      }
    });
    notify();
  });
};

export const appAlert = (message: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const id = ++currentId;
    dialogs.push({
      id,
      type: 'alert',
      message,
      resolve: () => {
        dialogs = dialogs.filter(d => d.id !== id);
        notify();
        resolve(true);
      }
    });
    notify();
  });
};
