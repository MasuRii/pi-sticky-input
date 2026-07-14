import { matchesKey, type TUI } from "@earendil-works/pi-tui";

import { isRecord } from "../shared/index.js";

export type StickyTerminalDiagnostic = (event: string, fields: Record<string, unknown>) => void;

export interface StickyTerminalSessionOptions {
  alternateScreen: boolean;
  alternateScroll: boolean;
  mouseScroll: boolean;
  diagnostic?: StickyTerminalDiagnostic;
}

export type MouseWheelDirection = "up" | "down";

interface ActiveTerminalModes {
  tui: TUI;
  alternateScreen: boolean;
  alternateScroll: boolean;
  mouseScroll: boolean;
}

interface TuiStopPatch {
  originalStop: TUI["stop"];
}

type TuiWithStopPatch = TUI & {
  __piStickyInputStopPatch?: TuiStopPatch;
};

const ENTER_ALTERNATE_SCREEN_SEQUENCE = "\x1b[?1049h\x1b[H\x1b[2J";
const EXIT_ALTERNATE_SCREEN_SEQUENCE = "\x1b[?1049l";
const ENABLE_ALTERNATE_SCROLL_SEQUENCE = "\x1b[?1007h";
const DISABLE_ALTERNATE_SCROLL_SEQUENCE = "\x1b[?1007l";
const ENABLE_SGR_MOUSE_SEQUENCE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_SGR_MOUSE_SEQUENCE = "\x1b[?1006l\x1b[?1000l";
const SGR_MOUSE_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
const X10_MOUSE_PATTERN = /\x1b\[M([\s\S])([\s\S])([\s\S])/g;
const PAGE_UP_ANY_MODIFIER_PATTERN = /^\x1b\[5(?:;[2-8])?~$/;
const PAGE_DOWN_ANY_MODIFIER_PATTERN = /^\x1b\[6(?:;[2-8])?~$/;
const MOUSE_MODIFIER_MASK = 4 | 8 | 16;
const WHEEL_UP_BUTTON = 64;
const WHEEL_DOWN_BUTTON = 65;

let activeTerminalModes: ActiveTerminalModes | undefined;

function getTerminalWrite(tui: TUI): ((data: string) => void) | undefined {
  const write = tui.terminal?.write;
  return typeof write === "function" ? write.bind(tui.terminal) : undefined;
}

/** Resolve the terminal write function, emitting a skipped diagnostic when unavailable. */
function requireTerminalWrite(
  tui: TUI,
  diagnostic: StickyTerminalDiagnostic | undefined,
): ((data: string) => void) | undefined {
  const write = getTerminalWrite(tui);
  if (!write) {
    diagnostic?.("terminal_modes_skipped", { reason: "missing-terminal-write" });
  }
  return write;
}

/** Apply the effective terminal modes, emit the activation/update diagnostic, and request a render. */
function applyTerminalModes(
  tui: TUI,
  event: string,
  diagnostic: StickyTerminalDiagnostic | undefined,
  modes: Omit<ActiveTerminalModes, "tui">,
): void {
  activeTerminalModes = {
    tui,
    ...modes,
  };
  diagnostic?.(event, {
    alternateScreen: modes.alternateScreen,
    alternateScroll: modes.alternateScroll,
    mouseScroll: modes.mouseScroll,
  });
  tui.requestRender(true);
}

function getEffectiveTerminalModes(options: StickyTerminalSessionOptions): Omit<ActiveTerminalModes, "tui"> {
  return {
    alternateScreen: options.alternateScreen,
    alternateScroll: options.alternateScreen && options.alternateScroll && !options.mouseScroll,
    mouseScroll: options.mouseScroll,
  };
}

function sameActiveModes(tui: TUI, options: StickyTerminalSessionOptions): boolean {
  const effectiveModes = getEffectiveTerminalModes(options);
  return activeTerminalModes?.tui === tui
    && activeTerminalModes.alternateScreen === effectiveModes.alternateScreen
    && activeTerminalModes.alternateScroll === effectiveModes.alternateScroll
    && activeTerminalModes.mouseScroll === effectiveModes.mouseScroll;
}

function buildTerminalModeTransitionSequence(
  currentModes: Omit<ActiveTerminalModes, "tui">,
  nextModes: Omit<ActiveTerminalModes, "tui">,
): string {
  let sequence = "";

  if (currentModes.mouseScroll && !nextModes.mouseScroll) {
    sequence += DISABLE_SGR_MOUSE_SEQUENCE;
  }
  if (currentModes.alternateScroll && !nextModes.alternateScroll) {
    sequence += DISABLE_ALTERNATE_SCROLL_SEQUENCE;
  }
  if (!currentModes.alternateScroll && nextModes.alternateScroll) {
    sequence += ENABLE_ALTERNATE_SCROLL_SEQUENCE;
  }
  if (!currentModes.mouseScroll && nextModes.mouseScroll) {
    sequence += ENABLE_SGR_MOUSE_SEQUENCE;
  }

  return sequence;
}

function installStopPatch(tui: TUI): void {
  const patchedTui = tui as TuiWithStopPatch;
  if (patchedTui.__piStickyInputStopPatch || typeof patchedTui.stop !== "function") {
    return;
  }

  const originalStop = patchedTui.stop;
  patchedTui.__piStickyInputStopPatch = { originalStop };
  patchedTui.stop = function piStickyInputStopPatch(this: TUI): void {
    try {
      originalStop.call(this);
    } finally {
      deactivateStickyTerminalSession();
    }
  };
}

function restoreStopPatch(tui: TUI): void {
  const patchedTui = tui as TuiWithStopPatch;
  const patch = patchedTui.__piStickyInputStopPatch;
  if (!patch) {
    return;
  }

  patchedTui.stop = patch.originalStop;
  delete patchedTui.__piStickyInputStopPatch;
}

export function activateStickyTerminalSession(tui: TUI, options: StickyTerminalSessionOptions): void {
  if (sameActiveModes(tui, options)) {
    return;
  }

  const effectiveModes = getEffectiveTerminalModes(options);
  const activeModes = activeTerminalModes;
  if (activeModes?.tui === tui && activeModes.alternateScreen && effectiveModes.alternateScreen) {
    const write = requireTerminalWrite(tui, options.diagnostic);
    if (!write) {
      return;
    }

    const sequence = buildTerminalModeTransitionSequence(activeModes, effectiveModes);
    if (sequence.length > 0) {
      write(sequence);
    }

    applyTerminalModes(tui, "terminal_modes_updated", options.diagnostic, effectiveModes);
    return;
  }

  deactivateStickyTerminalSession();

  const write = requireTerminalWrite(tui, options.diagnostic);
  if (!write) {
    return;
  }

  let sequence = "";
  if (effectiveModes.alternateScreen) {
    sequence += ENTER_ALTERNATE_SCREEN_SEQUENCE;
  }
  if (effectiveModes.alternateScroll) {
    sequence += ENABLE_ALTERNATE_SCROLL_SEQUENCE;
  } else if (effectiveModes.alternateScreen && effectiveModes.mouseScroll) {
    sequence += DISABLE_ALTERNATE_SCROLL_SEQUENCE;
  }
  if (effectiveModes.mouseScroll) {
    sequence += ENABLE_SGR_MOUSE_SEQUENCE;
  }

  if (sequence.length > 0) {
    write(sequence);
  }

  installStopPatch(tui);
  applyTerminalModes(tui, "terminal_modes_activated", options.diagnostic, effectiveModes);
}

export function deactivateStickyTerminalSession(diagnostic?: StickyTerminalDiagnostic): void {
  if (!activeTerminalModes) {
    return;
  }

  const { tui, alternateScreen, alternateScroll, mouseScroll } = activeTerminalModes;
  activeTerminalModes = undefined;
  restoreStopPatch(tui);

  const write = getTerminalWrite(tui);
  if (!write) {
    diagnostic?.("terminal_modes_deactivate_skipped", { reason: "missing-terminal-write" });
    return;
  }

  let sequence = "";
  if (mouseScroll) {
    sequence += DISABLE_SGR_MOUSE_SEQUENCE;
  }
  if (alternateScroll) {
    sequence += DISABLE_ALTERNATE_SCROLL_SEQUENCE;
  }
  if (alternateScreen) {
    sequence += EXIT_ALTERNATE_SCREEN_SEQUENCE;
  }

  if (sequence.length > 0) {
    write(sequence);
  }

  diagnostic?.("terminal_modes_deactivated", { alternateScreen, alternateScroll, mouseScroll });
}

export function getActiveStickyTerminalTui(): TUI | undefined {
  return activeTerminalModes?.tui;
}

export function hasVisibleOverlay(tui: unknown): boolean {
  if (!isRecord(tui)) {
    return false;
  }

  const hasOverlay = tui.hasOverlay;
  if (typeof hasOverlay === "function") {
    return hasOverlay.call(tui) === true;
  }

  return Array.isArray(tui.overlayStack) && tui.overlayStack.length > 0;
}

function isEditorLikeFocus(component: unknown): boolean {
  if (!isRecord(component)) {
    return false;
  }

  const constructorName = isRecord(component.constructor) && typeof component.constructor.name === "string"
    ? component.constructor.name
    : undefined;
  if (constructorName === "Editor" || constructorName === "CustomEditor") {
    return true;
  }

  return typeof component.getText === "function"
    && typeof component.setText === "function"
    && typeof component.handleInput === "function"
    && "onSubmit" in component;
}

export function shouldHandleStickyTerminalInput(tui: unknown): boolean {
  if (hasVisibleOverlay(tui)) {
    return false;
  }

  if (!isRecord(tui)) {
    return true;
  }

  if (!("focusedComponent" in tui) || tui.focusedComponent === undefined || tui.focusedComponent === null) {
    return true;
  }

  return isEditorLikeFocus(tui.focusedComponent);
}

function getMouseWheelDirection(rawButton: number): MouseWheelDirection | undefined {
  const button = rawButton & ~MOUSE_MODIFIER_MASK;
  if (button === WHEEL_UP_BUTTON) {
    return "up";
  }

  if (button === WHEEL_DOWN_BUTTON) {
    return "down";
  }

  return undefined;
}

export function parseAlternateScrollInput(
  data: string,
  options: { allowCursorKeys?: boolean } = {},
): MouseWheelDirection | undefined {
  if (!options.allowCursorKeys) return undefined;
  if (matchesKey(data, "up")) return "up";
  if (matchesKey(data, "down")) return "down";
  return undefined;
}

export function getKeyboardScrollRows(
  data: string,
  pageRows: number,
  options: { allowPlainHomeEnd?: boolean } = {},
): number | undefined {
  const rows = Math.max(1, Math.floor(pageRows));

  if (matchesKey(data, "pageUp") || PAGE_UP_ANY_MODIFIER_PATTERN.test(data)) {
    return -rows;
  }

  if (matchesKey(data, "pageDown") || PAGE_DOWN_ANY_MODIFIER_PATTERN.test(data)) {
    return rows;
  }

  if (matchesKey(data, "ctrl+home") || (options.allowPlainHomeEnd === true && matchesKey(data, "home"))) {
    return -Number.MAX_SAFE_INTEGER;
  }

  if (matchesKey(data, "ctrl+end") || (options.allowPlainHomeEnd === true && matchesKey(data, "end"))) {
    return Number.MAX_SAFE_INTEGER;
  }

  return undefined;
}

export function parseMouseWheelInput(data: string): MouseWheelDirection | undefined {
  SGR_MOUSE_PATTERN.lastIndex = 0;
  X10_MOUSE_PATTERN.lastIndex = 0;

  let direction: MouseWheelDirection | undefined;
  for (const match of data.matchAll(SGR_MOUSE_PATTERN)) {
    const rawButton = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(rawButton)) {
      direction = getMouseWheelDirection(rawButton) ?? direction;
    }
  }

  for (const match of data.matchAll(X10_MOUSE_PATTERN)) {
    const buttonByte = match[1]?.charCodeAt(0);
    if (buttonByte !== undefined) {
      direction = getMouseWheelDirection(buttonByte - 32) ?? direction;
    }
  }

  return direction;
}

export function isMouseInput(data: string): boolean {
  SGR_MOUSE_PATTERN.lastIndex = 0;
  X10_MOUSE_PATTERN.lastIndex = 0;
  return SGR_MOUSE_PATTERN.test(data) || X10_MOUSE_PATTERN.test(data);
}
