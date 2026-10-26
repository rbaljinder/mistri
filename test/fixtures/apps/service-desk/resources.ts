import { action } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

/* What Service Atlas says about each resource, once. `access: 'write'` is
   the server-enforced table write scope; everything else — inventory,
   catalog definitions, the directory and SLA policies — declares none and
   stays read-only. Then how values dress, the New forms and record actions. */
export const resources = {
  incident: {
    segments: {
      active: 'status != resolved and status != closed',
      critical: 'priority = critical and status != closed',
      resolved_incidents: { query: 'status = resolved', label: 'Resolved' },
    },
    access: 'write',
    machine: {
      column: 'status',
      states: {
        new: { on: { triageIncident: 'triage' } },
        triage: { on: { startInvestigation: 'in_progress' } },
        in_progress: { on: { pendIncident: 'pending', resolveIncident: 'resolved' } },
        pending: { on: { resolveIncident: 'resolved', resumeInvestigation: 'in_progress' } },
        resolved: { on: { closeIncident: 'closed' } },
        closed: { final: true },
      },
    },
    display: {
      priority: {
        tone: {
          critical: 'bad',
          high: 'warn',
          normal: 'info',
          low: 'neutral',
        },
      },
      status: {
        tone: {
          new: 'info',
          triage: 'info',
          in_progress: 'info',
          pending: 'warn',
          resolved: 'info',
          closed: 'good',
        },
      },
    },
    form: {
      show: ['name', 'description', 'priority', 'caller_id', 'service_id', 'team_id', 'assignee_id', 'sla_id'],
      defaults: {
        status: 'new',
        priority: 'normal',
        sla_id: 3,
      },
    },
  },
  incident_note: { access: 'write' },
  problem: { access: 'write' },
  change_request: {
    segments: {
      active: 'status != closed and status != canceled',
      under_review: { query: 'status = authorize', label: 'Review' },
    },
    noun: 'change',
    access: 'write',
    machine: {
      column: 'status',
      states: {
        draft: { on: { submitAssessment: 'assess', cancelChange: 'canceled' } },
        assess: { on: { requestAuthorization: 'authorize', cancelChange: 'canceled' } },
        authorize: { on: { scheduleChange: 'scheduled', cancelChange: 'canceled' } },
        scheduled: { on: { startImplementation: 'implement', cancelChange: 'canceled' } },
        implement: { on: { beginReview: 'review' } },
        review: { on: { closeChange: 'closed' } },
        closed: { final: true },
        canceled: { final: true },
      },
    },
    display: {
      risk: {
        tone: {
          high: 'bad',
          medium: 'warn',
          low: 'good',
        },
      },
      status: {
        tone: {
          draft: 'info',
          assess: 'info',
          authorize: 'warn',
          scheduled: 'info',
          implement: 'info',
          review: 'info',
          closed: 'good',
          canceled: 'neutral',
        },
      },
    },
    form: {
      show: [
        'name',
        'service_id',
        'owner_id',
        'team_id',
        'kind',
        'risk',
        'reason',
        'starts_at',
        'ends_at',
        'implementation_plan',
        'rollback_plan',
        'validation_plan',
      ],
      defaults: {
        status: 'draft',
        kind: 'normal',
        risk: 'medium',
      },
    },
  },
  change_task: { access: 'write' },
  change_approval: {
    access: 'write',
    display: {
      decision: {
        tone: {
          pending: 'warn',
          approved: 'good',
          rejected: 'bad',
        },
      },
    },
    actions: {
      recordApproval: action('Record approval', {
        set: {
          decision: 'approved',
        },
        when: 'decision = pending',
      }),
      recordRejection: action('Record rejection', {
        set: {
          decision: 'rejected',
        },
        when: 'decision = pending',
      }),
    },
  },
  change_note: { access: 'write' },
  service_request: {
    noun: 'request',
    access: 'write',
    machine: {
      column: 'status',
      states: {
        submitted: { on: { requestApproval: 'awaiting_approval', cancelRequest: 'canceled' } },
        awaiting_approval: { on: { approveRequest: 'approved', cancelRequest: 'canceled' } },
        approved: { on: { fulfillRequest: 'fulfilling', cancelRequest: 'canceled' } },
        fulfilling: { on: { completeRequest: 'completed' } },
        completed: { final: true },
        canceled: { final: true },
      },
    },
    display: {
      status: {
        tone: {
          submitted: 'info',
          awaiting_approval: 'warn',
          approved: 'info',
          fulfilling: 'info',
          completed: 'good',
          canceled: 'neutral',
        },
      },
    },
    form: {
      show: ['name', 'requested_for', 'department_id', 'justification', 'needed_on'],
      defaults: {
        status: 'submitted',
      },
    },
  },
  request_item: { access: 'write' },
  request_approval: {
    access: 'write',
    display: {
      decision: {
        tone: {
          pending: 'warn',
          approved: 'good',
          rejected: 'bad',
        },
      },
    },
    actions: {
      recordApproval: action('Record approval', {
        set: {
          decision: 'approved',
        },
        when: 'decision = pending',
      }),
      recordRejection: action('Record rejection', {
        set: {
          decision: 'rejected',
        },
        when: 'decision = pending',
      }),
    },
  },
  purchase_order: {
    noun: 'order',
    access: 'write',
    machine: {
      column: 'status',
      states: {
        draft: { on: { issueOrder: 'issued', cancelOrder: 'canceled' } },
        issued: { on: { receivePartialOrder: 'part_received', receiveOrder: 'received', cancelOrder: 'canceled' } },
        part_received: { on: { receiveOrder: 'received' } },
        received: { final: true },
        canceled: { final: true },
      },
    },
    display: {
      status: {
        tone: {
          draft: 'info',
          issued: 'info',
          part_received: 'warn',
          received: 'good',
          canceled: 'neutral',
        },
      },
    },
    form: {
      show: ['name', 'vendor_id', 'buyer_id', 'shipping_location_id', 'ordered_on', 'expected_on'],
      defaults: {
        status: 'draft',
      },
    },
  },
  order_line: {
    access: 'write',
    display: { unit_price: { format: 'money' } },
  },
  fulfillment_task: {
    access: 'write',
    actions: {
      startTask: action('Start task', {
        set: {
          status: 'in_progress',
        },
        when: 'status = open',
      }),
      completeTask: action('Complete task', {
        set: {
          status: 'done',
        },
        when: 'status = in_progress',
      }),
    },
  },
  knowledge_article: { noun: 'knowledge', access: 'write' },
  service: {
    display: {
      status: {
        tone: {
          operational: 'good',
          degraded: 'bad',
          maintenance: 'warn',
        },
      },
    },
  },
  catalog_item: {
    display: { price: { format: 'money' } },
  },
  // Read-only lookups a view lists: declared, with nothing more to say.
  asset: {},
  person: {},
  support_team: {},
  department: {},
  location: {},
  vendor: {},
  sla_policy: {},
  asset_relation: {},
} satisfies NonNullable<App['resources']>;
