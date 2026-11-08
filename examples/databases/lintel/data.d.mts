/** Lintel's rows, by table (data.mjs), as the carrier test reads them. */
export declare function lintelToday(now?: Date): string;
export declare function generate(options: { today: string; photos?: boolean }): { tables: Record<string, Array<Record<string, any>>> };
