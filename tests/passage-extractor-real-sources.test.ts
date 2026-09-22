import { describe, expect, it } from 'vitest';
import { extractRelevantPassages } from '../src/passage-extractor.js';

// Focused excerpts from parent CRW snapshots in
// /home/triiq/.hermes/profiles/axiom/cache/scratch/search-diagnosis/a2/source-snapshots.json.
// Malformed fences are preserved as captured; this patch does not repair upstream markdown.

const NASA_TILT_EXCERPT = `## It's all about Earth's tilt!

Many people believe that Earth is closer to the Sun in the summer and that is why it is hotter. And, likewise, they think Earth is farthest from the Sun in the winter.

Although this idea makes sense, it is **incorrect.**

It is true that Earth's orbit is not a perfect circle. It is a bit lop-sided. During part of the year, Earth is closer to the Sun than at other times. However, in the Northern Hemisphere, we are having winter when Earth is closest to the Sun and summer when it is farthest away! Compared with how far away the Sun is, this change in Earth's distance throughout the year does not make much difference to our weather.

There is a different reason for Earth's seasons.

Earth's axis is an imaginary pole going right through the center of Earth from "top" to "bottom." Earth spins around this pole, making one complete turn each day. That is why we have day and night, and why every part of Earth's surface gets some of each.

Earth has seasons because its axis doesn't stand up straight.
`;

const TS_SATISFIES_EXCERPT = `# Documentation

# TypeScript 4.9

## The \`satisfies\` Operator

The new \`satisfies\` operator lets us validate that the type of an expression matches some type, without changing the resulting type of that expression. As an example, we could use \`satisfies\` to validate that all the properties of \`palette\` are compatible with \`string | number[]\`:

ts

\`type Colors = "red" | "green" | "blue";

type RGB = [red: number, green: number, blue: number];

const palette = {

\`\`\`
red: [255, 0, 0], green: "#00ff00", bleu: [0, 0, 255]
\`\`\`
//  ~~~~ The typo is now caught!

} satisfies Record<Colors, string | RGB>;

// toUpperCase() method is still accessible!

const greenNormalized = palette.green.toUpperCase();\`
`;

describe('real captured source excerpts', () => {
  it('keeps the NASA seasons myth and incorrect qualification in one passage', () => {
    // Origin: spaceplace.nasa.gov/seasons/en/ CRW snapshot, tilt section.
    const result = extractRelevantPassages(NASA_TILT_EXCERPT, 'Earth summer winter closer sun tilt', {
      topN: 3,
      contextWindow: 0,
    });

    expect(result.passages.some((p) => p.text.includes('Many people believe') && p.text.includes('incorrect'))).toBe(true);
  });

  it('keeps the captured TypeScript satisfies palette example in one passage', () => {
    // Origin: typescriptlang.org handbook 4.9 CRW snapshot. Fences are malformed upstream.
    const result = extractRelevantPassages(TS_SATISFIES_EXCERPT, 'satisfies operator inference palette', {
      topN: 3,
      contextWindow: 0,
    });

    expect(result.passages.some((p) => (
      p.text.includes('const palette = {')
      && p.text.includes('} satisfies Record<Colors')
      && p.text.includes('palette.green.toUpperCase()')
    ))).toBe(true);
  });
});
