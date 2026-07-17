/**
 * Pet Extension
 *
 * Displays a small ASCII tamagotchi-style pet in a widget above the editor.
 * The pet reacts to agent lifecycle events with different expressions:
 *   - Idle: sleeping/resting face
 *   - Thinking: active working face with spinning animation
 *   - Happy: happy face when task completes
 *   - Sad: sad face on errors
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

type PetState = 'idle' | 'thinking' | 'happy' | 'sad';

const IDLE_FRAMES = ['  .--.  ', ' ( -.- )', '  > ~ < ', "  '--'  "];

const THINKING_FRAMES = [
  ['  .--.  ', ' ( o.o )', '  > @ < ', "  '--'  "],
  ['  .--.  ', ' ( O.o )', '  > @ < ', "  '--'  "],
  ['  .--.  ', ' ( o.O )', '  > @ < ', "  '--'  "],
  ['  .--.  ', ' ( O.O )', '  > @ < ', "  '--'  "]
];

const HAPPY_FRAMES = ['  .--.  ', ' ( ^.^ )', '  > ^ < ', "  '--'  "];

const SAD_FRAMES = ['  .--.  ', ' ( ;.; )', '  > ~ < ', "  '--'  "];

const THINKING_INTERVAL_MS = 200;
const EMOTION_CLEAR_MS = 3000;

export default function (pi: ExtensionAPI) {
  let currentState: PetState = 'idle';
  let thinkingFrame = 0;
  let emotionTimer: ReturnType<typeof setTimeout> | null = null;
  let animationTimer: ReturnType<typeof setInterval> | null = null;

  const renderPet = (ctx: ExtensionContext) => {
    let frames: string[];

    switch (currentState) {
      case 'thinking':
        frames = THINKING_FRAMES[thinkingFrame % THINKING_FRAMES.length] ?? THINKING_FRAMES[0];
        break;
      case 'happy':
        frames = HAPPY_FRAMES;
        break;
      case 'sad':
        frames = SAD_FRAMES;
        break;
      default:
        frames = IDLE_FRAMES;
    }

    ctx.ui.setWidget('pet', (_tui, theme) => {
      const colors: Record<PetState, (s: string) => string> = {
        idle: s => theme.fg('dim', s),
        thinking: s => theme.fg('accent', s),
        happy: s => theme.fg('success', s),
        sad: s => theme.fg('error', s)
      };

      const colorFn = colors[currentState];
      const lines = frames.map(line => colorFn(line));

      return {
        render: () => lines,
        invalidate: () => {}
      };
    });
  };

  const clearEmotionTimer = () => {
    if (emotionTimer) {
      clearTimeout(emotionTimer);
      emotionTimer = null;
    }
  };

  const stopAnimation = () => {
    if (animationTimer) {
      clearInterval(animationTimer);
      animationTimer = null;
    }
  };

  const setState = (state: PetState, ctx: ExtensionContext) => {
    currentState = state;

    stopAnimation();
    clearEmotionTimer();

    if (state === 'thinking') {
      animationTimer = setInterval(() => {
        thinkingFrame++;
        renderPet(ctx);
      }, THINKING_INTERVAL_MS);
    } else if (state === 'happy' || state === 'sad') {
      emotionTimer = setTimeout(() => {
        currentState = 'idle';
        clearEmotionTimer();
        renderPet(ctx);
      }, EMOTION_CLEAR_MS);
    }

    renderPet(ctx);
  };

  pi.on('session_start', async (_event, ctx) => {
    currentState = 'idle';
    renderPet(ctx);
  });

  pi.on('session_shutdown', async () => {
    stopAnimation();
    clearEmotionTimer();
  });

  pi.on('agent_start', async (_event, ctx) => {
    setState('thinking', ctx);
  });

  pi.on('agent_end', async (event, ctx) => {
    stopAnimation();
    clearEmotionTimer();

    const hasError = event.messages?.some(m => m.role === 'toolResult' && m.isError);

    setState(hasError ? 'sad' : 'happy', ctx);
  });
}
