import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountSettingsView } from './views/AccountSettingsView.js';
import { AiAssistantPanel, AiPromptComposer } from './views/AiAssistantView.js';
import { DecisionChip } from './views/AiProposalAndChip.js';
import { InviteAcceptCard, OAuthConsentCard, SignInCard } from './views/AuthSurfaces.js';
import { CsvImportWizard } from './views/CsvImportWizard.js';
import { AttachmentList, MediaGallery, PhotoMosaic } from './views/MediaViews.js';
import { OnboardingChecklist, SpotlightTour } from './views/OnboardingViews.js';

afterEach(cleanup);

const BANNED_INVENTED_STRINGS = [
  'Maya Lin',
  'Acme',
  'Mistri Copilot',
  'Claude Sonnet',
  'Gemini Pro',
  'GPT-5',
  'Postgres or ClickHouse',
  'Priya Nair',
  'Marcus Vance',
  'acmelogistics',
  'mistri-dns.net',
  'msk_live_',
  'SOC 2',
] as const;

function assertNoInventedContent(container: HTMLElement) {
  const snapshot = `${container.innerHTML}\n${document.body.textContent ?? ''}`;
  for (const banned of BANNED_INVENTED_STRINGS) {
    expect(snapshot).not.toContain(banned);
  }
}

describe('A5 — Product views render zero invented default content when mounted with only required props', () => {
  it('AccountSettingsView renders clean empty states across all sections without invented profile, sessions, tokens, members, or domains', () => {
    const { container: stacked } = render(<AccountSettingsView layout="stacked" />);
    assertNoInventedContent(stacked);
    expect(stacked.textContent).toContain('No active sessions.');
    expect(stacked.textContent).toContain('No active tokens.');
    expect(stacked.textContent).toContain('No team members.');
    expect(stacked.textContent).toContain('No custom domains configured.');

    const { container: tabbed } = render(<AccountSettingsView />);
    assertNoInventedContent(tabbed);
  });

  it('SignInCard renders without brand mark, SSO providers, or SOC 2 footer by default and keeps primary Sign in button enabled', () => {
    const { container: host } = render(<SignInCard />);
    assertNoInventedContent(host);
    expect(host.querySelector('.nx-auth-brand-mark')).toBeNull();
    expect(host.querySelector('.nx-auth-providers')).toBeNull();
    expect(host.querySelector('.nx-auth-footer')).toBeNull();

    const submitBtn = Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('type') === 'submit')!;
    expect(submitBtn).toBeDefined();
    expect(submitBtn.disabled).toBe(false);

    fireEvent.click(submitBtn);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Enter your email address and password');
  });

  it('InviteAcceptCard renders only required workspaceName and inviterName without invented plan, role, member count, or expiry', () => {
    const { container: host } = render(<InviteAcceptCard workspaceName="Core Platform" inviterName="Jordan Taylor" />);
    assertNoInventedContent(host);
    expect(host.textContent).toContain('Core Platform');
    expect(host.textContent).toContain('Jordan Taylor');
    expect(host.querySelector('.nx-invite-facts')).toBeNull();
  });

  it('OAuthConsentCard renders only required appName, userName, and userEmail without invented vendor, scopes, redirect URI, or verified badge', () => {
    const { container: host } = render(<OAuthConsentCard appName="Sync Worker" userName="Jordan Taylor" userEmail="jordan@example.com" />);
    assertNoInventedContent(host);
    expect(host.textContent).toContain('Sync Worker');
    expect(host.querySelector('.nx-consent-verified')).toBeNull();
    expect(host.querySelector('.nx-consent-redirect')).toBeNull();
    expect(host.querySelector('.nx-consent-security-note')).toBeNull();
  });

  it('OnboardingChecklist and SpotlightTour render without invented steps', () => {
    const { container: checklist } = render(<OnboardingChecklist />);
    assertNoInventedContent(checklist);
    expect(checklist.textContent).toContain('Getting started');
    expect(checklist.textContent).toContain('0 of 0 completed');

    const { container: tour } = render(<SpotlightTour />);
    assertNoInventedContent(tour);
    expect(tour.innerHTML).toBe('');
  });

  it('CsvImportWizard hides Load sample dataset unless sampleCsv is explicitly provided and uses generic CSV placeholder', () => {
    const { container: host } = render(<CsvImportWizard />);
    assertNoInventedContent(host);
    expect(host.textContent).not.toContain('Load sample dataset');
    const textarea = host.querySelector('textarea');
    expect(textarea?.getAttribute('placeholder')).toBe('column_a,column_b\nvalue_1,value_2');

    const { container: withSample } = render(<CsvImportWizard sampleCsv={'col_a,col_b\n1,2'} />);
    expect(withSample.textContent).toContain('Load sample dataset');
  });

  it('AttachmentList, PhotoMosaic, and MediaGallery render clean empty states without sample files or artworks', () => {
    const { container: attachments } = render(<AttachmentList />);
    assertNoInventedContent(attachments);
    expect(attachments.textContent).toContain('No attachments in this record.');

    const { container: mosaic } = render(<PhotoMosaic />);
    assertNoInventedContent(mosaic);
    expect(mosaic.textContent).toContain('No photos to display.');

    const { container: gallery } = render(<MediaGallery />);
    assertNoInventedContent(gallery);
    expect(gallery.textContent).toContain('No media items to display.');
  });

  it('AiAssistantPanel, AiPromptComposer, and DecisionChip omit invented models, starter prompts, context chips, and canned tool replies', () => {
    const { container: composer } = render(<AiPromptComposer />);
    assertNoInventedContent(composer);
    expect(composer.querySelector('.nx-ai-composer-context')).toBeNull();

    const { container: panel } = render(<AiAssistantPanel />);
    assertNoInventedContent(panel);
    expect(panel.querySelector('.nx-ai-model-trigger')).toBeNull();

    // Submitting a prompt without onSendPrompt records only the user turn and never fabricates a fake assistant reply
    const textarea = panel.querySelector<HTMLTextAreaElement>('textarea.nx-ai-composer-input')!;
    fireEvent.change(textarea, { target: { value: 'Summarize open items' } });
    const sendBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Send')!;
    expect(sendBtn).toBeDefined();
    fireEvent.click(sendBtn);
    expect(panel.textContent).toContain('Summarize open items');
    expect(panel.textContent).not.toContain('workspace.inspect_context');

    const { container: chip } = render(<DecisionChip value="Net 30" reason="Matched supplier contract" />);
    assertNoInventedContent(chip);
    const chipBtn = chip.querySelector<HTMLButtonElement>('[data-slot="decision-chip"]')!;
    fireEvent.click(chipBtn);
    assertNoInventedContent(chip);
  });
});
