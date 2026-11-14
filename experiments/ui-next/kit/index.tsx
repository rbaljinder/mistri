import { defineUiKit } from '@mistriwork/mistri/page';
import { Button, ButtonLink } from './buttons';
import { CheckCards, Checkbox, ChoiceCards, Consent, Slider, Switch, YesNo } from './choices';
import { DateField } from './DateField';
import { Avatar, Pagination, Tabs } from './display';
import { Dropdown, MultiDropdown, MultiSelect, Select } from './lists';
import { DropGroup, DropItem, DropMenu, DropSeparator } from './menu';
import { Drawer, Modal, Popover, Tooltip } from './overlays';
import { MaskedField, MoneyField, SensitiveField, TextField } from './text';
import { Typeahead } from './Typeahead';

/* ui-next as a control kit for mistri: every slot @mistriwork/ui declares (packages/ui/src/UiKit.tsx), drawn over
   UI SDK with the props the platform already hands each one. An App installs it where it would install any kit
   (`uiKit: './ui/kit.tsx'`), with `styles.ts` beside it for what the slots are dressed by.

   It is written as an App's kit has to be: `defineUiKit` comes from the page (`@mistriwork/mistri/page`), React is
   the page's, and nothing else of mistri's is imported but types, which are gone before it runs. */
export default defineUiKit({
  Button,
  ButtonLink,
  TextField,
  MaskedField,
  MoneyField,
  SensitiveField,
  Select,
  MultiSelect,
  Dropdown,
  MultiDropdown,
  Typeahead,
  DateField,
  Checkbox,
  YesNo,
  ChoiceCards,
  CheckCards,
  Consent,
  Switch,
  Slider,
  Modal,
  Drawer,
  Popover,
  Tooltip,
  DropMenu,
  DropGroup,
  DropItem,
  DropSeparator,
  Tabs,
  Pagination,
  Avatar,
});
