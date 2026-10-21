import { create } from 'zustand';

type Theme = 'system' | 'light' | 'dark';

interface UIState {
  blurred: boolean;
  theme: Theme;
  backgroundUri: string | null;
  toggleBlur: () => void;
  setTheme: (t: Theme) => void;
  setBackgroundUri: (uri: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  blurred: false,
  theme: 'system',
  backgroundUri: null,
  toggleBlur: () => set(s => ({ blurred: !s.blurred })),
  setTheme: (theme) => set({ theme }),
  setBackgroundUri: (backgroundUri) => set({ backgroundUri }),
}));
