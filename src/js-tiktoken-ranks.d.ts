declare module 'js-tiktoken/ranks/o200k_base' {
  const o200k_base: {
    pat_str: string;
    special_tokens: Record<string, number>;
    bpe_ranks: string;
  };
  export default o200k_base;
}
