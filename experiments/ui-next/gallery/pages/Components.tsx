import { Actions } from '../sections/Actions';
import { Behaviors } from '../sections/Behaviors';
import { Display } from '../sections/Display';
import { Forms } from '../sections/Forms';
import { Foundations } from '../sections/Foundations';
import { More } from '../sections/More';
import { Overlays } from '../sections/Overlays';
import { Presentations } from '../sections/Presentations';

export function Components() {
  return (
    <div data-part="components">
      <header data-slot="list-head">
        <h1>Components</h1>
      </header>
      <Foundations />
      <Actions />
      <Forms />
      <Overlays />
      <Display />
      <Behaviors />
      <Presentations />
      <More />
    </div>
  );
}
