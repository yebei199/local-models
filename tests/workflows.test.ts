// Drift: the graphs the commands submit must still be the UI-format workflows they were exported from.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

interface UiWorkflow {
  nodes: { id: number; type: string; widgets_values?: unknown[] | null }[];
  links: [number, number, number, number, number, string][];
}
type ApiGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

const commands = JSON.parse(readFileSync('src/workflows.json', 'utf8')) as Record<string, ApiGraph>;
const ui = (name: string) =>
  JSON.parse(readFileSync(`comfyui/workflows/${name}.json`, 'utf8')) as UiWorkflow;

/** Each command graph, its UI source, the inputs scene.ts fills per request (plus output naming),
 * and the nodes it adds per request instead of carrying them. */
const pairs = [
  {
    kind: 'image',
    source: 'klein_t2i',
    filled: {
      '4': ['text'],
      '6': ['width', 'height'],
      '7': ['width', 'height'],
      '10': ['noise_seed'],
      '13': ['filename_prefix'],
    },
    injected: [] as string[],
  },
  {
    kind: 'video',
    source: 'h3_i2v',
    filled: { '6': ['prompt', 'width', 'height'], '10': ['noise_seed'], '15': ['filename_prefix'] },
    injected: ['5'],
  },
];

/** The UI stores widget values unnamed and integers as floats, so values compare as a bag. */
const scalar = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value);

describe.each(pairs)(
  '$kind command graph against $source',
  ({ kind, source, filled, injected }) => {
    const api = commands[kind] as ApiGraph;
    const workflow = ui(source);
    const kept = workflow.nodes.filter((node) => !injected.includes(String(node.id)));

    test('has the same nodes under the same ids', () => {
      const types = (pairs: [string, string][]) => Object.fromEntries(pairs);
      expect(types(Object.entries(api).map(([id, node]) => [id, node.class_type]))).toEqual(
        types(kept.map((node) => [String(node.id), node.type])),
      );
    });

    test('wires them the same way', () => {
      const edges = Object.entries(api).flatMap(([id, node]) =>
        Object.values(node.inputs)
          .filter(Array.isArray)
          .map(([from, slot]) => `${from}:${slot}->${id}`),
      );
      const links = workflow.links
        .filter(([, from, , to]) => ![from, to].some((id) => injected.includes(String(id))))
        .map(([, from, slot, to]) => `${from}:${slot}->${to}`);
      expect(edges.sort()).toEqual(links.sort());
    });

    test('keeps every fixed parameter the UI shows', () => {
      const fixed = Object.entries(api).flatMap(([id, node]) =>
        Object.entries(node.inputs)
          .filter(
            ([name, value]) => scalar(value) && !filled[id as keyof typeof filled]?.includes(name),
          )
          .map(([name, value]) => ({ id, name, value })),
      );
      const missing = fixed.filter(({ id, value }) => {
        const widgets = kept.find((node) => String(node.id) === id)?.widgets_values ?? [];
        return !widgets.some((widget) => widget === value);
      });
      expect(missing).toEqual([]);
    });
  },
);
