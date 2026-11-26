// The only module that touches DOM globals. Every export is a no-op off web.
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

interface MinimalKeyboardEvent {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

interface MinimalWindow {
  addEventListener(type: string, listener: (event: MinimalKeyboardEvent) => void): void;
  removeEventListener(type: string, listener: (event: MinimalKeyboardEvent) => void): void;
  readonly navigator?: { readonly platform?: string; readonly userAgent?: string };
}

function domWindow(): MinimalWindow | null {
  if (Platform.OS !== "web") return null;
  return ((globalThis as { window?: MinimalWindow }).window ?? null) as MinimalWindow | null;
}

function isMac(win: MinimalWindow): boolean {
  const platform = win.navigator?.platform ?? win.navigator?.userAgent ?? "";
  return /mac|iphone|ipad/i.test(platform);
}

export interface SidebarShortcutHandlers {
  /** 1-based index from Mod+1..9. */
  jump(index: number): void;
  /** -1 for Mod+[, +1 for Mod+]. */
  step(delta: -1 | 1): void;
}

/**
 * Mod+1..9 and Mod+[ / Mod+] for this sidebar view. Paseo's own bindings for the same keys stop the
 * event first, so these only fire once "Jump to workspace" and "Previous/Next workspace" are
 * unbound under Settings > Shortcuts. Returns whether the modifier is held, for number badges.
 */
export function useSidebarShortcuts(handlers: SidebarShortcutHandlers): boolean {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [modifierHeld, setModifierHeld] = useState(false);

  useEffect(() => {
    const win = domWindow();
    if (!win) return;
    const mac = isMac(win);
    const isMod = (event: MinimalKeyboardEvent) => (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
    const modKey = mac ? "Meta" : "Control";

    const down = (event: MinimalKeyboardEvent) => {
      if (event.key === modKey) setModifierHeld(true);
      if (event.defaultPrevented || !isMod(event) || event.altKey || event.shiftKey) return;
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit) {
        event.preventDefault();
        latest.current.jump(Number(digit[1]));
      } else if (event.code === "BracketLeft" || event.code === "BracketRight") {
        if (event.repeat) return;
        event.preventDefault();
        latest.current.step(event.code === "BracketLeft" ? -1 : 1);
      }
    };
    const up = (event: MinimalKeyboardEvent) => {
      if (event.key === modKey) setModifierHeld(false);
    };
    const blur = () => setModifierHeld(false);
    win.addEventListener("keydown", down);
    win.addEventListener("keyup", up);
    win.addEventListener("blur", blur);
    return () => {
      win.removeEventListener("keydown", down);
      win.removeEventListener("keyup", up);
      win.removeEventListener("blur", blur);
    };
  }, []);

  return modifierHeld;
}

/** Label for the platform modifier in hints. */
export function modifierLabel(): string {
  const win = domWindow();
  return win && isMac(win) ? "⌘" : "Ctrl";
}
