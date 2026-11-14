import { DotsThree, FloppyDisk, Plus, TextB, TextItalic, TextUnderline } from '@phosphor-icons/react';
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuShortcut, MenuTrigger } from '@ui-sdk/react/menu';
import { toast } from '@ui-sdk/react/toast';
import { Toggle, ToggleGroup } from '@ui-sdk/react/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';
import { Button } from '../../src';
import { Section, Specimen } from '../Specimen';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function Actions() {
  return (
    <Section id="actions" title="Actions" lede="One action is primary and filled; the rest are quiet. Delete is never the loud one.">
      <Specimen name="Button intents">
        <div data-part="row">
          <Button intent="primary">
            <Plus aria-hidden="true" weight="bold" />
            New lead
          </Button>
          <Button>Export</Button>
          <Button intent="quiet">Cancel</Button>
          <Button intent="danger">Delete</Button>
        </div>
      </Specimen>
      <Specimen name="Sizes and states">
        <div data-part="row">
          <Button size="sm">Small</Button>
          <Button>Medium</Button>
          <Button size="lg">Large</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Specimen>
      <Specimen name="Pending (a promise from onClick)">
        <div data-part="row">
          <Button
            intent="primary"
            pendingAnnouncement="Saving"
            onClick={async () => {
              await wait(1500);
              toast.success('Changes saved');
            }}
          >
            <FloppyDisk aria-hidden="true" />
            Save changes
          </Button>
        </div>
      </Specimen>
      <Specimen name="Toggle group">
        <ToggleGroup aria-label="Text style" defaultValue={['bold']}>
          <Toggle value="bold" aria-label="Bold">
            <TextB aria-hidden="true" />
          </Toggle>
          <Toggle value="italic" aria-label="Italic">
            <TextItalic aria-hidden="true" />
          </Toggle>
          <Toggle value="underline" aria-label="Underline">
            <TextUnderline aria-hidden="true" />
          </Toggle>
        </ToggleGroup>
      </Specimen>
      <Specimen name="Menu">
        <Menu onAction={(value) => toast(`Chose “${value}”`)}>
          <MenuTrigger>
            Actions
            <DotsThree aria-hidden="true" weight="bold" />
          </MenuTrigger>
          <MenuContent>
            <MenuGroup>
              <MenuGroupLabel>Lead</MenuGroupLabel>
              <MenuItem value="assign">
                Assign to me <MenuShortcut>A</MenuShortcut>
              </MenuItem>
              <MenuItem value="convert">Convert to account</MenuItem>
              <MenuItem value="duplicate">Duplicate</MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuItem value="archive">Archive</MenuItem>
          </MenuContent>
        </Menu>
      </Specimen>
      <Specimen name="Tooltip">
        <Tooltip>
          <TooltipTrigger>Hover or focus me</TooltipTrigger>
          <TooltipContent>Anyone with the link can view</TooltipContent>
        </Tooltip>
      </Specimen>
    </Section>
  );
}
