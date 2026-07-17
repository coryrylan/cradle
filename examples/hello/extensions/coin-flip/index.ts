// A full pi extension (see ARCHITECTURE.md "extensions/"): registers a tool
// AND a /flip command — the second half is what the tools/ convention can't express.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const flip = (): string => (Math.random() < 0.5 ? 'heads' : 'tails');

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'coin-flip',
    label: 'Coin flip',
    description: 'Flip a coin and return heads or tails',
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text' as const, text: flip() }], details: {} };
    }
  });

  pi.registerCommand('flip', {
    description: 'Flip a coin without asking the model',
    handler: async (_args, ctx) => {
      ctx.ui.notify(flip(), 'info');
    }
  });
}
