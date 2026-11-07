/**
 * A list's own second lines, by column, where its columns are inferred (shared/listInference.ts inferListSubtitles):
 * a job's number under its title. Said by the list (AppList.tsx) to the grid it draws, and nowhere else, so a list an
 * author arranged and every record page keep the display rules they were given.
 */
import { createContext } from 'react';

export const ListSubtitles = createContext<Readonly<Record<string, string>> | undefined>(undefined);
