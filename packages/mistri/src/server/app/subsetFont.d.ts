/* `subset-font` ships no types; appFonts.ts uses this much of it. */
declare module 'subset-font' {
  export default function subsetFont(
    font: Buffer,
    text: string,
    options?: {
      targetFormat?: 'sfnt' | 'woff' | 'woff2';
      preserveNameIds?: number[];
      keepAllGlyphs?: boolean;
      variationAxes?: Record<string, number | { min: number; max: number; default?: number }>;
    },
  ): Promise<Buffer>;
}
