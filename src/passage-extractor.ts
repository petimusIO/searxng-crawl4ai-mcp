/**
 * Passage Extractor: TF-IDF-based relevance scoring for scraped markdown.
 *
 * Splits markdown into paragraphs, scores each against a query using TF-IDF,
 * and returns the top-N most relevant passages with surrounding context.
 *
 * Zero dependencies, pure TypeScript. Designed for millisecond execution
 * on typical web pages.
 */

export interface PassageExtractionOptions {
  topN?: number;
  contextWindow?: number;
  minScore?: number;
}

export interface ScoredPassage {
  text: string;
  score: number;
  position: number;
}

export interface PassageExtractionResult {
  passages: ScoredPassage[];
  query: string;
  total_passages: number;
  top_n: number;
}

/**
 * Preprocess text: lowercase, strip punctuation, tokenize on whitespace.
 */
export function preprocessText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')  // strip punctuation
    .split(/\s+/)
    .filter(Boolean);              // remove empty tokens
}

/**
 * Extract relevant passages from markdown using TF-IDF scoring.
 */
export function extractRelevantPassages(
  markdown: string,
  query: string,
  options: PassageExtractionOptions = {}
): PassageExtractionResult {
  const topN = options.topN ?? 5;
  const contextWindow = options.contextWindow ?? 0;
  const minScore = options.minScore ?? 0.0;

  // 1. Split into paragraphs
  const rawParagraphs = markdown
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  if (rawParagraphs.length === 0) {
    return {
      passages: [],
      query,
      total_passages: 0,
      top_n: topN,
    };
  }

  // 2. Preprocess each paragraph
  const processed: string[][] = rawParagraphs.map(preprocessText);

  // 3. Preprocess query terms (exclude stop words)
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'shall', 'you', 'your',
    'we', 'they', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
    'me', 'my', 'he', 'she', 'him', 'her', 'what', 'which', 'who', 'how',
  ]);
  const queryTerms = preprocessText(query).filter(t => !STOP_WORDS.has(t));

  if (queryTerms.length === 0) {
    // No meaningful query terms — return first N paragraphs with zero scores
    return {
      passages: rawParagraphs.slice(0, topN).map((text, i) => ({
        text,
        score: 0,
        position: i,
      })),
      query,
      total_passages: rawParagraphs.length,
      top_n: topN,
    };
  }

  // 4. Compute IDF for each unique term across all paragraphs
  const totalParagraphs = rawParagraphs.length;
  const uniqueTerms = new Set<string>();
  const docFreq = new Map<string, number>();

  for (const tokens of processed) {
    const seen = new Set<string>();
    for (const token of tokens) {
      uniqueTerms.add(token);
      if (!seen.has(token)) {
        seen.add(token);
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }
  }

  const idf = new Map<string, number>();
  for (const term of uniqueTerms) {
    const df = docFreq.get(term) || 1;
    idf.set(term, Math.log(totalParagraphs / df));
  }

  // 5. Score each paragraph
  const scored: ScoredPassage[] = rawParagraphs.map((text, idx) => {
    const tokens = processed[idx];
    const totalTerms = tokens.length || 1; // avoid division by zero

    let score = 0;
    for (const queryTerm of queryTerms) {
      const tf = tokens.filter(t => t === queryTerm).length / totalTerms;
      const termIdf = idf.get(queryTerm) || 0;
      score += tf * termIdf;
    }

    return { text, score, position: idx };
  });

  // 6. Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const topPassages = scored.slice(0, topN).filter(p => p.score >= minScore);

  // 7. Add context window (surrounding paragraphs)
  if (contextWindow > 0 && topPassages.length > 0) {
    const included = new Set(topPassages.map(p => p.position));
    const withContext: ScoredPassage[] = [];

    for (const passage of topPassages) {
      // Add preceding context
      for (let offset = contextWindow; offset > 0; offset--) {
        const pos = passage.position - offset;
        if (pos >= 0 && !included.has(pos)) {
          included.add(pos);
          withContext.push({
            text: rawParagraphs[pos],
            score: passage.score * 0.1, // de-prioritize context paragraphs
            position: pos,
          });
        }
      }

      // Add the passage itself
      withContext.push(passage);

      // Add following context
      for (let offset = 1; offset <= contextWindow; offset++) {
        const pos = passage.position + offset;
        if (pos < rawParagraphs.length && !included.has(pos)) {
          included.add(pos);
          withContext.push({
            text: rawParagraphs[pos],
            score: passage.score * 0.1,
            position: pos,
          });
        }
      }
    }

    // Sort by position to maintain document order
    withContext.sort((a, b) => a.position - b.position);

    return {
      passages: withContext,
      query,
      total_passages: totalParagraphs,
      top_n: topN,
    };
  }

  return {
    passages: topPassages,
    query,
    total_passages: totalParagraphs,
    top_n: topN,
  };
}
