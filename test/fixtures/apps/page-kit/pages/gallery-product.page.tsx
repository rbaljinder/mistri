/** Runtime gallery page for product, auth, onboarding, CSV import, AI, and media views (`/gallery-product`). */
import { Card, Stack, definePage } from '@mistriwork/mistri/page';
import { FormColumns } from '@mistriwork/mistri/primitives';
import {
  AccountSettingsView,
  AiAssistantPanel,
  AiProposalCard,
  AttachmentList,
  CsvImportWizard,
  DecisionChip,
  InviteAcceptCard,
  MediaGallery,
  OAuthConsentCard,
  OnboardingChecklist,
  PhotoMosaic,
  SignInCard,
} from '@mistriwork/mistri/views';

export default definePage({
  label: 'Gallery product',
  nav: false,
  reads: ['deal'],
  component: GalleryProduct,
});

function GalleryProduct() {
  return (
    <Stack>
      <FormColumns columns={2}>
        <Card title="SignInCard">
          <SignInCard
            title="Sign in to Fieldline"
            subtitle="Enter your operator credentials"
            providers={[{ id: 'sso', label: 'Continue with SAML SSO', kind: 'saml' }]}
            defaultEmail="ana.ruiz@fieldline.example"
          />
        </Card>
        <Card title="InviteAcceptCard (>2^53 exact member count)">
          <InviteAcceptCard
            workspaceName="Fieldline North"
            workspaceMonogram="FN"
            inviterName="Ana Ruiz"
            inviterEmail="ana.ruiz@fieldline.example"
            role="Dispatcher"
            memberCount="9007199254740993"
            expiresIn="48 hours"
          />
        </Card>
      </FormColumns>

      <FormColumns columns={2}>
        <Card title="OAuthConsentCard">
          <OAuthConsentCard
            appName="Dispatch CLI"
            appVendor="Fieldline Ops"
            verified
            userName="Ana Ruiz"
            userEmail="ana.ruiz@fieldline.example"
            workspaceName="Fieldline North"
            scopes={[
              { id: 'read', label: 'Read work orders', description: 'View schedules and asset logs', required: true },
              { id: 'write', label: 'Update dispatch status', description: 'Assign technicians to visits', defaultGranted: true },
            ]}
          />
        </Card>
        <Card title="OnboardingChecklist">
          <OnboardingChecklist
            title="Station readiness"
            subtitle="Complete initial dispatch configuration"
            defaultCompletedIds={['s1']}
            steps={[
              { id: 's1', title: 'Connect asset registry', description: 'Synced 48 plant assets', estimatedTime: '2 min' },
              { id: 's2', title: 'Configure on-call rotation', description: 'Assign primary and backup leads', actionLabel: 'Configure' },
            ]}
          />
        </Card>
      </FormColumns>

      <Card title="AccountSettingsView">
        <AccountSettingsView
          profile={{
            name: 'Ana Ruiz',
            email: 'ana.ruiz@fieldline.example',
            role: 'Admin',
            workspaceName: 'Fieldline North',
            twoFactorEnabled: true,
            passkeyRegistered: true,
          }}
          sessions={[
            {
              id: 'sess-1',
              deviceType: 'laptop',
              client: 'Chromium · Linux',
              ip: '10.24.8.12',
              location: 'Oakland, CA',
              lastActive: 'Active now',
              current: true,
            },
          ]}
          tokens={[
            {
              id: 'tok-1',
              name: 'Telemetry collector',
              prefix: 'fl_live_98a7',
              scopes: ['orders:read'],
              createdAt: '2026-08-01',
              expiresAt: '2027-08-01',
              lastUsed: '2m ago',
            },
          ]}
          members={[
            { id: 'u1', name: 'Ana Ruiz', email: 'ana.ruiz@fieldline.example', role: 'Admin', status: 'active' },
            { id: 'u2', name: 'Ben Okafor', email: 'ben@fieldline.example', role: 'Builder', status: 'active' },
          ]}
        />
      </Card>

      <Card title="CsvImportWizard">
        <CsvImportWizard
          schemaFields={[
            { key: 'code', label: 'Asset code', required: true },
            { key: 'name', label: 'Asset name', required: true },
            { key: 'interval', label: 'Interval days', type: 'number' },
          ]}
          initialCsv={'code,name,interval\nPUMP-01,Boiler Feed Pump A,90\nVALVE-04,Chiller Bypass Valve,180'}
        />
      </Card>

      <FormColumns columns={2}>
        <Card title="AiProposalCard & DecisionChip">
          <DecisionChip
            field="Priority"
            previousValue="Medium"
            value="High"
            confidence="94%"
            reason="Vibration exceeded 6.5 mm/s threshold on bearing housing."
          />
          <AiProposalCard
            title="Escalate Boiler Feed Pump A"
            targetLabel="WO-101"
            confidence="94%"
            rationale="Bearing temperature rose 14 °C over baseline within two hours."
            changes={[
              { field: 'Assignee', from: 'Ben Okafor', to: 'Ana Ruiz' },
              { field: 'Window', from: 'Next week', to: 'Today 14:00' },
            ]}
          />
        </Card>
        <Card title="AiAssistantPanel">
          <AiAssistantPanel
            title="Fieldline Copilot"
            models={[{ value: 'ops-fast', label: 'Ops Fast' }]}
            defaultModel="ops-fast"
            messages={[
              { id: '1', role: 'user', content: 'Which inspections need lockout tags today?' },
              { id: '2', role: 'assistant', content: 'WO-101 (Boiler Feed Pump A) requires main breaker lockout.' },
            ]}
          />
        </Card>
      </FormColumns>

      <Card title="AttachmentList (exabyte scale), PhotoMosaic & MediaGallery">
        <AttachmentList
          disableLightbox
          items={[
            { id: 'f1', name: 'vibration-archive.parquet', size: '9007199254740992', kind: 'doc', uploadedBy: 'Ana Ruiz' },
            { id: 'f2', name: 'loop-schematic.pdf', size: 245760, kind: 'pdf', uploadedBy: 'Ben Okafor' },
          ]}
        />
        <PhotoMosaic
          disableLightbox
          tiles={[
            { id: 'p1', title: 'Pump skid north', artworkVariant: 1, dimensions: '1600×1200' },
            { id: 'p2', title: 'Manifold gauge', artworkVariant: 2, dimensions: '1200×900' },
          ]}
        />
        <MediaGallery
          disableLightbox
          columns={3}
          items={[
            { id: 'm1', title: 'Thermal scan A', category: 'Thermography', artworkVariant: 3 },
            { id: 'm2', title: 'Seal face inspection', category: 'Mechanical', artworkVariant: 4 },
          ]}
        />
      </Card>
    </Stack>
  );
}
