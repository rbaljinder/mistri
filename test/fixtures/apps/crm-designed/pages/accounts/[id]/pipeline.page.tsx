/**
 * An account's pipeline as its own tab, at /compass/accounts/13/pipeline: what is still open, how it stands by
 * stage, and the open deals in the order they are due to close. A free-form page placed by its folder
 * (pages/accounts/[id]/), so the account's record page draws it beside Contacts and Opportunities; the record it
 * is on comes from page.useRecordKey, typed by the account's key.
 */
import type { ReactNode } from 'react';
import { Breakdown, definePage, Empty, Grid, List, Metric, Panel, Row, Scope, useFormat } from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Pipeline',
  description: 'The account’s open deals by stage, and which close next.',
  icon: 'chart-line',
  reads: ['account', 'opportunity'],
  component: Pipeline,
});
export default page;

/* The open stages as the opportunity's own stage field says them. */
const STAGE: Record<string, string> = {
  prospecting: 'Prospecting',
  qualification: 'Qualification',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
};
const OPEN = { stage: { not: ['closed_won', 'closed_lost'] } } as const;

function Pipeline(): ReactNode {
  const format = useFormat();
  const account = page.useRecordKey('account');
  return (
    <Scope from="opportunity" where={{ account_id: account.id }}>
      <Grid>
        <Metric title="Open pipeline" where={OPEN} measure="sum amount" format="money" width="third" />
        <Metric title="Open deals" where={OPEN} measure="count" width="third" />
        <Metric title="Won" where={{ stage: 'closed_won' }} measure="sum amount" format="money" width="third" />
        <Breakdown title="Open by stage" where={OPEN} by="stage" measure="sum amount" format="money" width="half" />
        <Panel title="Closing next" width="half">
          <List
            where={OPEN}
            show={['name', 'stage', 'amount', 'close_date']}
            sort="close_date"
            limit={8}
            label="Open deals by close date"
            empty={<Empty title="No open deals" description="Every deal with this account is won or lost." />}
          >
            {(deal) => (
              <Row align="center">
                <span>
                  <strong>{deal.name}</strong> · {STAGE[deal.stage] ?? deal.stage}
                </span>
                <span>
                  {format.money(deal.amount)} · {format.date(deal.close_date)}
                </span>
              </Row>
            )}
          </List>
        </Panel>
      </Grid>
    </Scope>
  );
}
