import { installSurfaceSeam, type UiSurfaceSeam } from '@mistriwork/ui';

type DefaultWords = NonNullable<ReturnType<NonNullable<UiSurfaceSeam['defaultWords']>>>;

const wordSources: Array<() => DefaultWords> = [];
const seam: UiSurfaceSeam = {
  defaultWords: () => Object.assign({}, ...wordSources.map((source) => source())),
};

export function registerDefaultWords(source: () => DefaultWords): void {
  wordSources.push(source);
  installSurfaceSeam(seam);
}

export function registerAiLabel(aiLabel: () => string): void {
  seam.aiLabel = aiLabel;
  installSurfaceSeam(seam);
}
