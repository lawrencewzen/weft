export type ToastState = {
  message: string;
  action?: {
    label: string;
    run: () => void;
  };
};

export type ToastInput = string | ToastState;

export function normalizeToast(input: ToastInput): ToastState {
  return typeof input === 'string' ? { message: input } : input;
}
