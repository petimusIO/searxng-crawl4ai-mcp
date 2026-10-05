import { describe, expect, it } from 'vitest';
import {
  dedupeSearchImages,
  normalizeFourgetImage,
  normalizeSearxngImage,
} from '../src/image-normalize.js';

describe('normalizeFourgetImage', () => {
  it('uses the last source variant as the thumbnail and the first usable as full-size', () => {
    const image = normalizeFourgetImage({
      title: 'Saturn',
      url: 'https://solarsystem.nasa.gov/saturn',
      source: [
        { url: 'https://cdn.nasa.gov/saturn-full.jpg', width: 1600, height: 1200 },
        { url: 'https://cdn.nasa.gov/saturn-mid.jpg', width: 800, height: 600 },
        { url: 'https://cdn.nasa.gov/saturn-thumb.jpg', width: 200, height: 150 },
      ],
    });

    expect(image).toMatchObject({
      title: 'Saturn',
      sourcePageUrl: 'https://solarsystem.nasa.gov/saturn',
      imageUrl: 'https://cdn.nasa.gov/saturn-full.jpg',
      thumbnailUrl: 'https://cdn.nasa.gov/saturn-thumb.jpg',
      width: 1600,
      height: 1200,
      engine: 'fourget',
    });
  });

  it('skips non-http variants when choosing the full-size image', () => {
    const image = normalizeFourgetImage({
      title: 'Ringed planet',
      url: 'https://example.com/saturn',
      source: [
        { url: 'data:image/jpeg;base64,abc', width: 1600, height: 1200 },
        { url: 'https://cdn.example.com/saturn.jpg', width: 900, height: 700 },
        { url: 'https://cdn.example.com/saturn-thumb.jpg', width: 120, height: 90 },
      ],
    });

    expect(image?.imageUrl).toBe('https://cdn.example.com/saturn.jpg');
    expect(image?.thumbnailUrl).toBe('https://cdn.example.com/saturn-thumb.jpg');
    expect(image?.width).toBe(900);
  });

  it('rejects records without a usable image URL or source page', () => {
    expect(normalizeFourgetImage({ title: 'No sources', url: 'https://example.com', source: [] })).toBeNull();
    expect(normalizeFourgetImage({
      title: 'Bad page',
      url: 'javascript:alert(1)',
      source: [{ url: 'https://cdn.example.com/a.jpg', width: 10, height: 10 }],
    })).toBeNull();
  });
});

describe('normalizeSearxngImage', () => {
  it('maps img_src to the full image and thumbnail_src to the thumbnail', () => {
    const image = normalizeSearxngImage({
      title: 'Saturn photo',
      url: 'https://commons.wikimedia.org/saturn',
      img_src: 'https://upload.wikimedia.org/saturn.jpg',
      thumbnail_src: 'https://upload.wikimedia.org/saturn-thumb.jpg',
      engine: 'wikicommons',
    });

    expect(image).toMatchObject({
      title: 'Saturn photo',
      sourcePageUrl: 'https://commons.wikimedia.org/saturn',
      imageUrl: 'https://upload.wikimedia.org/saturn.jpg',
      thumbnailUrl: 'https://upload.wikimedia.org/saturn-thumb.jpg',
      engine: 'wikicommons',
    });
  });

  it('falls back to img_src when no thumbnail is provided', () => {
    const image = normalizeSearxngImage({
      title: 'Only full',
      url: 'https://example.com/page',
      img_src: 'https://cdn.example.com/only.jpg',
    });

    expect(image?.thumbnailUrl).toBe('https://cdn.example.com/only.jpg');
  });
});

describe('dedupeSearchImages', () => {
  it('dedupes by normalized image URL and keeps the first title', () => {
    const images = dedupeSearchImages([
      {
        title: 'First',
        sourcePageUrl: 'https://a.example/1?utm_source=x',
        imageUrl: 'https://cdn.example.com/pic.jpg?utm_campaign=1',
        thumbnailUrl: 'https://cdn.example.com/pic-t.jpg',
        engine: 'fourget',
      },
      {
        title: 'Duplicate',
        sourcePageUrl: 'https://b.example/2',
        imageUrl: 'https://cdn.example.com/pic.jpg',
        thumbnailUrl: 'https://cdn.example.com/other-t.jpg',
        engine: 'searxng',
      },
    ]);

    expect(images).toHaveLength(1);
    expect(images[0].title).toBe('First');
  });
});
