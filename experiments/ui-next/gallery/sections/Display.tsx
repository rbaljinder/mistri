import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from '@ui-sdk/react/accordion';
import { Avatar, AvatarFallback } from '@ui-sdk/react/avatar';
import { Meter, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from '@ui-sdk/react/meter';
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue } from '@ui-sdk/react/progress';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { Board, Pager, Stats, Worklist } from '../../src';
import { Section, Specimen } from '../Specimen';
import { Status } from '../../src';

export function Display() {
  return (
    <Section id="display" title="Navigation and display" lede="Rules, not boxes. Meaning is a dot and its word.">
      <Specimen name="Tabs">
        <Tabs defaultValue="details">
          <TabsList aria-label="Lead">
            <TabsTab value="details">Details</TabsTab>
            <TabsTab value="activity">Activity</TabsTab>
            <TabsTab value="files">Files</TabsTab>
          </TabsList>
          <TabsPanel value="details">Owner, stage and the next step.</TabsPanel>
          <TabsPanel value="activity">Calls, emails and notes, newest first.</TabsPanel>
          <TabsPanel value="files">Quotes and contracts.</TabsPanel>
        </Tabs>
      </Specimen>
      <Specimen name="Accordion">
        <Accordion defaultValue={['billing']}>
          <AccordionItem value="billing">
            <AccordionHeader>
              <AccordionTrigger>Billing</AccordionTrigger>
            </AccordionHeader>
            <AccordionPanel>Net 30, invoiced on the first of the month.</AccordionPanel>
          </AccordionItem>
          <AccordionItem value="shipping">
            <AccordionHeader>
              <AccordionTrigger>Shipping</AccordionTrigger>
            </AccordionHeader>
            <AccordionPanel>Two depots: Leeds and Rotterdam.</AccordionPanel>
          </AccordionItem>
        </Accordion>
      </Specimen>
      <Specimen name="Status">
        <div data-part="row">
          <Status>New</Status>
          <Status tone="info">Working</Status>
          <Status tone="good">Qualified</Status>
          <Status tone="warning">Stalled</Status>
          <Status tone="critical">Lost</Status>
        </div>
      </Specimen>
      <Specimen name="Avatars">
        <div data-part="row">
          {['AO', 'BV', 'CL'].map((initials) => (
            <Avatar key={initials}>
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
          ))}
        </div>
      </Specimen>
      <Specimen name="Progress and meter">
        <div data-part="stack">
          <Progress value={64}>
            <ProgressLabel>Importing leads</ProgressLabel>
            <ProgressValue />
            <ProgressTrack>
              <ProgressIndicator />
            </ProgressTrack>
          </Progress>
          <Meter value={82}>
            <MeterLabel>Storage used</MeterLabel>
            <MeterValue />
            <MeterTrack>
              <MeterIndicator />
            </MeterTrack>
          </Meter>
        </div>
      </Specimen>
      <Specimen name="Pagination">
        <Pager pageCount={12} />
      </Specimen>
      <Specimen name="Waiting, in the page's own shape" wide>
        <div data-part="waiting">
          <Stats
            loading
            items={[
              { label: 'Occupancy', value: '' },
              { label: 'Vacant', value: '' },
              { label: 'Rent this month', value: '' },
            ]}
          />
          <Worklist loading label="Waiting" items={[]} />
          <Board
            loading
            label="Waiting"
            lanes={[
              { value: 'new', label: 'New' },
              { value: 'site', label: 'On site', tone: 'warning' },
              { value: 'done', label: 'Done', tone: 'good' },
            ]}
            cards={[] as string[]}
            cardKey={(card) => card}
            cardName={(card) => card}
            laneOf={() => 'new'}
            card={() => null}
          />
        </div>
      </Specimen>
    </Section>
  );
}
