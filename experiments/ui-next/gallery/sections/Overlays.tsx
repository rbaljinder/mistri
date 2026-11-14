import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@ui-sdk/react/alert-dialog';
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@ui-sdk/react/dialog';
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from '@ui-sdk/react/drawer';
import { Field, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover';
import { toast } from '@ui-sdk/react/toast';
import { Button } from '../../src';
import { CommandPalette } from '../CommandPalette';
import { Section, Specimen } from '../Specimen';

export function Overlays() {
  return (
    <Section id="overlays" title="Overlays" lede="Popups enter with ease-out and leave at once. Focus goes in, and comes back.">
      <Specimen name="Dialog">
        <Dialog>
          <DialogTrigger>Rename lead</DialogTrigger>
          <DialogBackdrop />
          <DialogContent>
            <DialogTitle>Rename lead</DialogTitle>
            <DialogDescription>The new name shows everywhere this lead is listed.</DialogDescription>
            <Field name="name">
              <FieldLabel>Name</FieldLabel>
              <Input defaultValue="Stonebridge Supply" />
            </Field>
            <div data-part="dialog-actions">
              <DialogClose data-variant="quiet">Cancel</DialogClose>
              <DialogClose data-variant="solid">Rename</DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      </Specimen>
      <Specimen name="Alert dialog">
        <AlertDialog>
          <AlertDialogTrigger data-variant="destructive">Delete lead</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Delete Stonebridge Supply?</AlertDialogTitle>
            <AlertDialogDescription>
              The lead, its notes and its activity are deleted for everyone. This cannot be undone.
            </AlertDialogDescription>
            <div data-part="dialog-actions">
              <AlertDialogClose data-variant="quiet">Keep it</AlertDialogClose>
              <AlertDialogClose value="confirm" data-variant="destructive">
                Delete
              </AlertDialogClose>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      </Specimen>
      <Specimen name="Drawer">
        <Drawer side="right">
          <DrawerTrigger>Open filters</DrawerTrigger>
          <DrawerBackdrop />
          <DrawerContent>
            <DrawerTitle>Filters</DrawerTitle>
            <DrawerDescription>Narrow the list to the leads you are working.</DrawerDescription>
            <Field name="city">
              <FieldLabel>City</FieldLabel>
              <Input placeholder="Any" />
            </Field>
            <div data-part="dialog-actions">
              <DrawerClose data-variant="solid">Apply</DrawerClose>
            </div>
          </DrawerContent>
        </Drawer>
      </Specimen>
      <Specimen name="Popover">
        <Popover>
          <PopoverTrigger>Share</PopoverTrigger>
          <PopoverContent sideOffset={8}>
            <PopoverTitle>Share this view</PopoverTitle>
            <PopoverDescription>Anyone on the team with the link sees the same filters.</PopoverDescription>
            <PopoverClose>Done</PopoverClose>
          </PopoverContent>
        </Popover>
      </Specimen>
      <Specimen name="Toast">
        <div data-part="row">
          <Button onClick={() => toast('Lead assigned', { description: 'Ada Okafor owns it now.' })}>Plain</Button>
          <Button onClick={() => toast.success('Changes saved')}>Success</Button>
          <Button onClick={() => toast.warning('Storage is almost full')}>Warning</Button>
          <Button onClick={() => toast.error('Could not save changes')}>Error</Button>
        </div>
      </Specimen>
      <Specimen name="Command palette">
        <CommandPalette />
      </Specimen>
    </Section>
  );
}
