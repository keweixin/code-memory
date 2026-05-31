/**
 * Code Memory Graph — Token Counter
 *
 * Estimates token count for text content. Uses a heuristic
 * approximation based on character count, since exact tokenization
 * depends on the specific model's tokenizer.
 *
 * Rules of thumb:
 * - English text: ~4 characters per token
 * - Code: ~3.5 characters per token (more special characters)
 * - CJK text: ~1.5 characters per token
 */

// Approximate characters per token for different content types
const CHARS_PER_TOKEN_CODE = 3.5;
const CHARS_PER_TOKEN_TEXT = 4.0;
const CHARS_PER_TOKEN_CJK = 1.5;

// CJK Unicode ranges
const CJK_REGEX = /[一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯]/g;

/**
 * Estimate token count for a string.
 * Uses different heuristics based on content type detection.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Count CJK characters
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkLength = text.length - cjkCount;

  // Estimate tokens for each portion
  const cjkTokens = Math.ceil(cjkCount / CHARS_PER_TOKEN_CJK);
  const codeTokens = Math.ceil(nonCjkLength / CHARS_PER_TOKEN_CODE);

  return cjkTokens + codeTokens;
}

/**
 * Truncate text to fit within a token budget.
 * Returns the truncated text and the estimated token count.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): { text: string; tokenCount: number } {
  const tokenCount = estimateTokens(text);
  if (tokenCount <= maxTokens) {
    return { text, tokenCount };
  }

  // Estimate character budget based on content type
  const cjkMatches = text.match(CJK_REGEX);
  const cjkRatio = cjkMatches ? cjkMatches.length / text.length : 0;

  // Weighted average of chars per token
  const charsPerToken = cjkRatio * CHARS_PER_TOKEN_CJK + (1 - cjkRatio) * CHARS_PER_TOKEN_CODE;
  const charBudget = Math.floor(maxTokens * charsPerToken);

  // Truncate and add ellipsis
  const truncated = text.slice(0, charBudget - 3) + '...';
  return {
    text: truncated,
    tokenCount: estimateTokens(truncated),
  };
}

/**
 * Split text into chunks that fit within a token budget.
 * Tries to split on natural boundaries (newlines).
 */
export function chunkByTokenBudget(
  text: string,
  maxTokensPerChunk: number,
  overlapTokens: number = 0,
): { content: string; tokenCount: number }[] {
  const lines = text.split('\n');
  const chunks: { content: string; tokenCount: number }[] = [];
  let currentLines: string[] = [];
  let currentTokens = 0;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);

    if (currentTokens + lineTokens > maxTokensPerChunk && currentLines.length > 0) {
      // Save current chunk
      const content = currentLines.join('\n');
      chunks.push({ content, tokenCount: currentTokens });

      // Handle overlap
      if (overlapTokens > 0) {
        const overlapLines: string[] = [];
        let overlapCount = 0;
        for (let i = currentLines.length - 1; i >= 0; i--) {
          const lt = estimateTokens(currentLines[i]);
          if (overlapCount + lt > overlapTokens) break;
          overlapLines.unshift(currentLines[i]);
          overlapCount += lt;
        }
        currentLines = overlapLines;
        currentTokens = overlapCount;
      } else {
        currentLines = [];
        currentTokens = 0;
      }
    }

    currentLines.push(line);
    currentTokens += lineTokens;
  }

  // Don't forget the last chunk
  if (currentLines.length > 0) {
    const content = currentLines.join('\n');
    chunks.push({ content, tokenCount: currentTokens });
  }

  return chunks;
}
