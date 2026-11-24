/** `@mistriwork/mistri/views`: generated self-contained declarations (`scripts/sync-ui-sdk.mjs`). @preview */
import * as React from 'react';
import type { ComponentProps, ReactNode, Ref } from 'react';
import { type Change, type TransferMove, type TransferReason, type TurnsReason } from './behaviors.js';
import { type AvatarStatus, type EmptyStateSpec, type Tone } from './kit.js';
import { type BreadcrumbItem, type MenuEntry } from './primitives.js';

export { type ControlSize, type EmptyStateSpec, PageHeader, type PageHeaderBack, type PageHeaderProps, type PageHeaderTab, SplitView, type SplitViewItem, type SplitViewItemsProps, type SplitViewPaneProps, type SplitViewProps, type Tone } from './kit.js';
/** Tab identifier for `AccountSettingsView`. */
export type AccountSettingsTab = 'profile' | 'sessions' | 'tokens' | 'team';
/** Workspace role option in `AccountSettingsView`. */
export type AccountTeamRole = 'Owner' | 'Admin' | 'Builder' | 'Viewer';
/** Personal profile and security settings data for `AccountSettingsView`. */
export interface AccountProfileData {
    name: string;
    email: string;
    role: AccountTeamRole;
    avatarUrl?: string;
    workspaceName?: string;
    twoFactorEnabled: boolean;
    passkeyRegistered: boolean;
    passkeyLabel?: string;
}
/** Active device session entry in `AccountSettingsView`. */
export interface AccountSessionItem {
    id: string;
    deviceType: 'laptop' | 'desktop' | 'mobile';
    client: string;
    ip: string;
    location: string;
    lastActive: string;
    current?: boolean;
}
/** Scoped API service token entry in `AccountSettingsView`. */
export interface AccountApiToken {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    createdAt: string;
    expiresAt: string;
    lastUsed: string;
}
/** Workspace team member entry in `AccountSettingsView`. */
export interface AccountTeamMember {
    id: string;
    name: string;
    email: string;
    role: AccountTeamRole;
    avatarUrl?: string;
    status?: 'active' | 'invited';
}
/** Verified custom domain entry in `AccountSettingsView`. */
export interface AccountDomainItem {
    id: string;
    domain: string;
    cnameTarget: string;
    verified: boolean;
    tlsStatus: 'active' | 'provisioning' | 'pending';
    primary?: boolean;
}
/** Props for the `AccountSettingsView` surface. */
export interface AccountSettingsViewProps {
    layout?: 'tabs' | 'stacked';
    activeTab?: AccountSettingsTab;
    defaultTab?: AccountSettingsTab;
    onTabChange?: (tab: AccountSettingsTab) => void;
    profile?: AccountProfileData;
    sessions?: ReadonlyArray<AccountSessionItem>;
    tokens?: ReadonlyArray<AccountApiToken>;
    availableScopes?: ReadonlyArray<{
        value: string;
        label: string;
    }>;
    members?: ReadonlyArray<AccountTeamMember>;
    domains?: ReadonlyArray<AccountDomainItem>;
    defaultCnameTarget?: string;
    onSaveProfile?: (next: AccountProfileData) => void | Promise<unknown>;
    onRevokeSession?: (sessionId: string) => void | Promise<unknown>;
    /**
     * Creates the token and returns (or resolves to) the secret to show once. The secret is the server's to mint: it
     * is what the server will later check, and the browser cannot be the one that knows it first. `rawSecret` is a
     * placeholder drawn in the browser, shown only when the host returns no secret of its own; a host that mints
     * its own ignores it.
     */
    onCreateToken?: (token: AccountApiToken, rawSecret: string) => string | void | Promise<string | void>;
    onRevokeToken?: (tokenId: string) => void | Promise<unknown>;
    onInviteMember?: (email: string, role: AccountTeamRole) => void | Promise<unknown>;
    onMemberRoleChange?: (memberId: string, role: AccountTeamRole) => void | Promise<unknown>;
    onRemoveMember?: (memberId: string) => void | Promise<unknown>;
    onAddDomain?: (domain: string) => void | Promise<unknown>;
    onRemoveDomain?: (domainId: string) => void | Promise<unknown>;
    framed?: boolean;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Tabbed account, security session, API token, verified domain, and team role settings surface. */
export declare function AccountSettingsView({ layout, activeTab: controlledTab, defaultTab, onTabChange, profile: initialProfile, sessions: initialSessions, tokens: initialTokens, availableScopes, members: initialMembers, domains: initialDomains, defaultCnameTarget, onSaveProfile, onRevokeSession, onCreateToken, onRevokeToken, onInviteMember, onMemberRoleChange, onRemoveMember, onAddDomain, onRemoveDomain, framed, className, ref, }: AccountSettingsViewProps): import("react").JSX.Element;
/** Author descriptor for an `ActivityItem` or `CommentComposer`. */
export interface ActivityAuthor {
    id?: string;
    name: string;
    handle?: string;
    avatarUrl?: string;
    initials?: string;
    role?: string;
}
/** Emoji reaction tally on an `ActivityItem`. */
export interface ActivityReaction {
    emoji: string;
    count: number;
    reacted?: boolean;
}
/** File attachment chip on an `ActivityItem`. */
export interface ActivityAttachment {
    id: string;
    name: string;
    size?: string;
    href?: string;
}
/** Comment or audit event entry in an `ActivityTimeline`. */
export interface ActivityItem {
    id: string;
    kind: 'comment' | 'event';
    author: ActivityAuthor;
    timestamp: string;
    dateTime?: string;
    body?: string;
    reactions?: ReadonlyArray<ActivityReaction>;
    attachments?: ReadonlyArray<ActivityAttachment>;
    action?: string;
    target?: string;
    tone?: Tone;
    icon?: ReactNode;
}
/** Mentionable user entry for `@` autocomplete in `CommentComposer`. */
export interface MentionUser {
    id: string;
    name: string;
    handle: string;
    role?: string;
    avatarUrl?: string;
    initials?: string;
}
/** Props for the `CommentComposer` component. */
export interface CommentComposerProps {
    mentionUsers?: ReadonlyArray<MentionUser>;
    placeholder?: string;
    submitLabel?: string;
    currentUser?: ActivityAuthor;
    onSubmit?: (body: string) => boolean | void | Promise<boolean | void>;
    onAttachClick?: () => void;
    className?: string;
    ref?: Ref<HTMLFormElement>;
}
/** Props for the `ActivityTimeline` component. */
export interface ActivityTimelineProps {
    items: ReadonlyArray<ActivityItem>;
    mentionUsers?: ReadonlyArray<MentionUser>;
    currentUser?: ActivityAuthor;
    showComposer?: boolean;
    composerPlaceholder?: string;
    onSubmitComment?: (body: string) => boolean | void | Promise<boolean | void>;
    /** Alias for onSubmitComment so Mistri command handlers wire naturally. */
    onAddComment?: (body: string) => boolean | void | Promise<boolean | void>;
    onToggleReaction?: (itemId: string, emoji: string) => void;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Rich comment input with `@mention` trigger suggestions and attachment button. */
export declare function CommentComposer({ mentionUsers, placeholder, submitLabel, onSubmit, onAttachClick, className, ref, }: CommentComposerProps): import("react").JSX.Element;
/** Chronological audit and comment feed with reactions, file chips, and `@mention` comment composer. */
export declare function ActivityTimeline({ items: propItems, mentionUsers, currentUser, showComposer, composerPlaceholder, onSubmitComment, onAddComment, onToggleReaction, empty, ariaLabel, className, ref, }: ActivityTimelineProps): import("react").JSX.Element;
/** Identifier string for an AI model option in `AiAssistantView`. */
export type AiModelId = 'claude-sonnet' | 'gemini-pro' | 'gpt-5' | (string & {});
/** Selectable AI model descriptor in `AiAssistantView`. */
export interface AiModelOption {
    value: string;
    label: string;
    provider?: string;
    badge?: string;
}
/** Execution lifecycle status of an `AiToolCall`. */
export type AiToolCallStatus = 'running' | 'done' | 'error';
/** Tool invocation trace rendered inside an assistant `AiMessage`. */
export interface AiToolCall {
    id: string;
    name: string;
    status: AiToolCallStatus;
    summary?: string;
    durationMs?: number;
    query?: string;
    output?: string;
}
/** Source citation chip attached to an assistant `AiMessage`. */
export interface AiCitation {
    id: string;
    label: string;
    source?: string;
    href?: string;
    snippet?: string;
}
/** Proposed field value change in an `AiProposalCard`. */
export interface AiFieldChange {
    field: string;
    from?: string;
    to: string;
}
/** Supporting evidence entry displayed on an `AiProposalCard`. */
export interface AiEvidenceItem {
    id?: string;
    label: string;
    detail?: string;
}
/** Review status of an `AiProposalCard`. */
export type AiProposalStatus = 'pending' | 'accepted' | 'dismissed';
/** Structured record-mutation proposal payload attached to an `AiMessage`. */
export interface AiProposalData {
    id: string;
    title: ReactNode;
    targetLabel?: string;
    changes: ReadonlyArray<AiFieldChange>;
    confidence?: number | string;
    rationale?: ReactNode;
    evidence?: ReadonlyArray<string | AiEvidenceItem>;
    status?: AiProposalStatus;
}
/** Pinned context entity attached to an assistant conversation or composer. */
export interface AiContextAttachment {
    id: string;
    label: string;
    kind?: 'table' | 'record' | 'file' | 'query';
    detail?: string;
}
/** Suggested starter prompt card shown in an empty `AiAssistantView`. */
export interface AiStarterPrompt {
    id: string;
    title: string;
    prompt: string;
    category?: string;
    icon?: ReactNode;
}
/** Author role of an `AiMessage` in `AiAssistantView`. */
export type AiMessageRole = 'user' | 'assistant';
/** Conversation message entry rendered in `AiAssistantView`. */
export interface AiMessage {
    id: string;
    role: AiMessageRole;
    content: ReactNode;
    plainText?: string;
    timestamp?: string;
    model?: string;
    streaming?: boolean;
    context?: ReadonlyArray<AiContextAttachment>;
    toolCalls?: ReadonlyArray<AiToolCall>;
    citations?: ReadonlyArray<AiCitation>;
    proposals?: ReadonlyArray<AiProposalData>;
}
/** Props for the `AiProposalCard` component. */
export interface AiProposalCardProps extends Omit<ComponentProps<'div'>, 'id' | 'title' | 'onChange' | 'aria-label' | 'inlist'> {
    id?: string;
    title: ReactNode;
    targetLabel?: string;
    changes: ReadonlyArray<AiFieldChange>;
    confidence?: number | string;
    rationale?: ReactNode;
    evidence?: ReadonlyArray<string | AiEvidenceItem>;
    status?: AiProposalStatus;
    defaultStatus?: AiProposalStatus;
    acceptLabel?: string;
    dismissLabel?: string;
    allowUndo?: boolean;
    ariaLabel?: string;
    onAccept?: (id?: string) => void;
    onDismiss?: (id?: string) => void;
    onUndo?: (id?: string) => void;
}
/** AI field-diff proposal review card with confidence badge, evidence pills, and accept/dismiss/undo actions. */
export declare function AiProposalCard({ id, title, targetLabel, changes, confidence, rationale, evidence, status, defaultStatus, acceptLabel, dismissLabel, allowUndo, ariaLabel, onAccept, onDismiss, onUndo, className, ...props }: AiProposalCardProps): import("react").JSX.Element;
/** Review state of an inline `DecisionChip`. */
export type DecisionChipStatus = 'suggested' | 'accepted' | 'reverted';
/** Props for the `DecisionChip` component. */
export interface DecisionChipProps {
    value: ReactNode;
    previousValue?: ReactNode;
    field?: string;
    confidence?: number | string;
    reason: ReactNode;
    model?: string;
    source?: string;
    status?: DecisionChipStatus;
    defaultStatus?: DecisionChipStatus;
    onAccept?: () => void;
    onRevert?: () => void;
    className?: string;
    ref?: Ref<HTMLButtonElement>;
}
/** Inline AI provenance chip that opens a rationale and accept/revert popover. */
export declare function DecisionChip({ value, previousValue, field, confidence, reason, model, source, status, defaultStatus, onAccept, onRevert, className, ref, }: DecisionChipProps): import("react").JSX.Element;
/** Props for the `AiPromptComposer` component. */
export interface AiPromptComposerProps {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    placeholder?: string;
    attachments?: ReadonlyArray<AiContextAttachment>;
    defaultAttachments?: ReadonlyArray<AiContextAttachment>;
    availableContexts?: ReadonlyArray<AiContextAttachment>;
    onRemoveAttachment?: (id: string) => void;
    onAddAttachment?: (item: AiContextAttachment) => void;
    isGenerating?: boolean;
    disabled?: boolean;
    onSubmit?: (prompt: string, attachments: AiContextAttachment[]) => void;
    onStop?: () => void;
    footerStart?: ReactNode;
    className?: string;
}
/** Multi-line AI prompt input bar with attachable workspace context pills and stop/send controls. */
export declare function AiPromptComposer({ value, defaultValue, onValueChange, placeholder, attachments, defaultAttachments, availableContexts, onRemoveAttachment, onAddAttachment, isGenerating, disabled, onSubmit, onStop, footerStart, className, }: AiPromptComposerProps): import("react").JSX.Element;
/** Props for the `AiAssistantPanel` component. */
export interface AiAssistantPanelProps extends Omit<ComponentProps<'section'>, 'title' | 'onChange' | 'aria-label' | 'inlist'> {
    title?: ReactNode;
    subtitle?: ReactNode;
    assistantLabel?: string;
    models?: ReadonlyArray<AiModelOption>;
    model?: string;
    defaultModel?: string;
    onModelChange?: (model: string) => void;
    messages?: ReadonlyArray<AiMessage>;
    defaultMessages?: ReadonlyArray<AiMessage>;
    starterPrompts?: ReadonlyArray<AiStarterPrompt>;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    attachments?: ReadonlyArray<AiContextAttachment>;
    defaultAttachments?: ReadonlyArray<AiContextAttachment>;
    availableContexts?: ReadonlyArray<AiContextAttachment>;
    composerPlaceholder?: string;
    isGenerating?: boolean;
    onSendMessage?: (prompt: string, context: AiContextAttachment[], model: string) => void;
    onSendPrompt?: (prompt: string, context: AiContextAttachment[], model: string) => void;
    onStopGenerating?: () => void;
    onNewThread?: () => void;
    onClear?: () => void;
    onRegenerate?: (messageId: string) => void;
    onCitationClick?: (citation: AiCitation) => void;
    onAcceptProposal?: (proposalId: string, messageId: string) => void;
    onDismissProposal?: (proposalId: string, messageId: string) => void;
}
/** Streaming conversational AI copilot panel with tool-call traces, citations, and field-mutation proposals. */
export declare function AiAssistantPanel(rawProps: AiAssistantPanelProps): import("react").JSX.Element;
/** Workspace switcher option rendered in `Sidebar`. */
export interface WorkspaceOption {
    id: string;
    name: string;
    plan?: string;
    monogram?: string;
    accentColor?: string;
}
/** Navigation item entry rendered in `Sidebar`. */
export interface NavItem {
    id: string;
    label: string;
    icon?: ReactNode;
    count?: number | string;
    tone?: Tone;
    href?: string;
    shortcut?: string;
    disabled?: boolean;
}
/** Collapsible navigation section rendered in `Sidebar`. */
export interface NavSection {
    id: string;
    label: string;
    items: ReadonlyArray<NavItem>;
    collapsible?: boolean;
    defaultOpen?: boolean;
}
/** Signed-in user profile summary rendered in the `Sidebar` footer. */
export interface SidebarUser {
    name: string;
    email?: string;
    role?: string;
    avatarUrl?: string;
    initials?: string;
    statusTone?: Tone;
}
/** Props for the `Sidebar` component. */
export interface SidebarProps {
    workspaces?: ReadonlyArray<WorkspaceOption>;
    activeWorkspaceId?: string;
    onWorkspaceChange?: (workspaceId: string) => void;
    onCreateWorkspace?: () => void;
    searchLabel?: string;
    searchShortcut?: string;
    onSearchTrigger?: () => void;
    items?: ReadonlyArray<NavItem>;
    favorites?: ReadonlyArray<NavItem>;
    sections?: ReadonlyArray<NavSection>;
    activeItemId?: string;
    onSelectItem?: (itemId: string, item: NavItem) => void;
    collapsed?: boolean;
    user?: SidebarUser;
    onSettingsClick?: () => void;
    footerSlot?: ReactNode;
    className?: string;
    ref?: Ref<HTMLElement>;
}
/** Props for the `TopBar` component. */
export interface TopBarProps {
    breadcrumbs?: ReadonlyArray<BreadcrumbItem>;
    onToggleSidebar?: () => void;
    sidebarCollapsed?: boolean;
    isMobile?: boolean;
    actions?: ReactNode;
    className?: string;
    ref?: Ref<HTMLElement>;
}
/** Props for the `AppShell` component. */
export interface AppShellProps {
    sidebarProps: SidebarProps;
    breadcrumbs?: ReadonlyArray<BreadcrumbItem>;
    topBarActions?: ReactNode;
    header?: ReactNode;
    collapsed?: boolean;
    defaultCollapsed?: boolean;
    onCollapsedChange?: (collapsed: boolean) => void;
    mobileBreakpoint?: number;
    children: ReactNode;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Collapsible workspace navigation rail with workspace switcher, pinned items, and user bar. */
export declare function Sidebar({ workspaces, activeWorkspaceId, onWorkspaceChange, onCreateWorkspace, searchLabel, searchShortcut, onSearchTrigger, items, favorites, sections, activeItemId, onSelectItem, collapsed, user, onSettingsClick, footerSlot, className, ref, }: SidebarProps): import("react").JSX.Element;
/** Top workspace header bar with sidebar toggle, breadcrumbs, and trailing actions. */
export declare function TopBar({ breadcrumbs, onToggleSidebar, sidebarCollapsed, isMobile, actions, className, ref }: TopBarProps): import("react").JSX.Element;
/** Responsive application workspace shell with desktop rail, mobile drawer, topbar, and main stage. */
export declare function AppShell({ sidebarProps, breadcrumbs, topBarActions, header, collapsed: controlledCollapsed, defaultCollapsed, onCollapsedChange, mobileBreakpoint, children, className, ref: externalRef, }: AppShellProps): import("react").JSX.Element;
/** Authentication method tab in `SignInCard`. */
export type SignInMode = 'password' | 'magic-link' | 'passkey' | 'otp';
/** External SSO or OAuth provider button option in `SignInCard`. */
export interface AuthProviderOption {
    id: string;
    label: string;
    kind?: 'github' | 'google' | 'saml' | 'custom';
    icon?: ReactNode;
}
/** Submitted credentials payload emitted by `SignInCard`. */
export interface SignInCredentials {
    mode: SignInMode;
    email?: string;
    password?: string;
    otpCode?: string;
    rememberDevice?: boolean;
}
/**
 * What a `SignInCard` handler reports of the attempt it was handed. The card knows nothing of an attempt's outcome
 * but this: `ok: false` (or an `error`) is shown as the failure, `next: '2fa'` moves on to the code step, and
 * `ok: true` is the only thing that makes it say the attempt succeeded (in `message`, where given).
 */
export interface SignInOutcome {
    ok?: boolean;
    error?: ReactNode;
    next?: '2fa';
    message?: ReactNode;
}
/** What a `SignInCard` handler may return: nothing (the card then claims nothing), an outcome, or a promise of either. */
export type SignInResult = void | SignInOutcome | Promise<void | SignInOutcome>;
/** Props for the `SignInCard` component. */
export interface SignInCardProps extends Omit<ComponentProps<'div'>, 'title' | 'onChange' | 'aria-label' | 'inlist'> {
    logo?: ReactNode;
    title?: ReactNode;
    subtitle?: ReactNode;
    providers?: ReadonlyArray<AuthProviderOption>;
    hideProviders?: boolean;
    mode?: SignInMode;
    defaultMode?: SignInMode;
    onModeChange?: (mode: SignInMode) => void;
    defaultEmail?: string;
    /**
     * Ask for a code after every password, without waiting to be told (default false). A host that learns from its
     * server whether an account has a second factor leaves this off and returns `{ next: '2fa' }` from `onSignIn`.
     */
    require2FA?: boolean;
    error?: ReactNode;
    securityNote?: ReactNode;
    footer?: ReactNode;
    ariaLabel?: string;
    onProviderClick?: (providerId: string) => void;
    /** Each handler may return a `SignInOutcome`, or a promise of one; the card waits for it and shows what it says. */
    onSignIn?: (credentials: SignInCredentials) => SignInResult;
    onVerifyOtp?: (code: string, email: string) => SignInResult;
    /** Sends a fresh code. "Resend code" is offered only where this is given: the card cannot send one itself. */
    onResendCode?: (email: string) => SignInResult;
    onForgotPassword?: (email: string) => SignInResult;
    onPasskeySignIn?: (email: string) => SignInResult;
}
/** Multi-mode sign-in card supporting SSO providers, password, magic link, WebAuthn passkeys, and TOTP 2FA. */
export declare function SignInCard({ logo, title, subtitle, providers, hideProviders, mode, defaultMode, onModeChange, defaultEmail, require2FA, error, securityNote, footer, ariaLabel, onProviderClick, onSignIn, onVerifyOtp, onResendCode, onForgotPassword, onPasskeySignIn, className, ...props }: SignInCardProps): import("react").JSX.Element;
/** Resolution status of an `InviteAcceptCard`. */
export type InviteAcceptStatus = 'pending' | 'accepted' | 'declined';
/** Workspace member preview avatar in `InviteAcceptCard`. */
export interface InviteTeamMember {
    id?: string;
    name: string;
    avatarSrc?: string;
}
/** Props for the `InviteAcceptCard` component. */
export interface InviteAcceptCardProps extends Omit<ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
    workspaceName: string;
    workspaceSlug?: string;
    workspaceMonogram?: string;
    workspacePlan?: string;
    inviterName: string;
    inviterEmail?: string;
    inviterAvatarSrc?: string;
    role?: string;
    memberCount?: number | string;
    locale?: string;
    teamMembers?: ReadonlyArray<InviteTeamMember>;
    expiresIn?: string;
    note?: ReactNode;
    status?: InviteAcceptStatus;
    defaultStatus?: InviteAcceptStatus;
    ariaLabel?: string;
    onAccept?: () => void;
    onDecline?: () => void;
}
/** Workspace invitation claim card displaying inviter details, assigned role, and accept/decline actions. */
export declare function InviteAcceptCard({ workspaceName, workspaceSlug, workspaceMonogram, workspacePlan, inviterName, inviterEmail, inviterAvatarSrc, role, memberCount, locale, teamMembers, expiresIn, note, status, defaultStatus, ariaLabel, onAccept, onDecline, className, ...props }: InviteAcceptCardProps): import("react").JSX.Element;
/** Risk classification for an `OAuthScopeItem`. */
export type OAuthScopeRisk = 'low' | 'elevated';
/** Requested permission scope item in `OAuthConsentCard`. */
export interface OAuthScopeItem {
    id: string;
    label: ReactNode;
    description?: ReactNode;
    icon?: ReactNode;
    required?: boolean;
    defaultGranted?: boolean;
    risk?: OAuthScopeRisk;
}
/** Resolution status of an `OAuthConsentCard`. */
export type OAuthConsentStatus = 'pending' | 'authorized' | 'denied';
/** Props for the `OAuthConsentCard` component. */
export interface OAuthConsentCardProps extends Omit<ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
    appName: string;
    appVendor?: string;
    appIcon?: ReactNode;
    clientType?: string;
    verified?: boolean;
    userName: string;
    userEmail: string;
    userAvatarSrc?: string;
    workspaceName?: string;
    workspaceIcon?: ReactNode;
    scopes?: ReadonlyArray<OAuthScopeItem>;
    redirectUri?: string;
    securityNote?: ReactNode;
    status?: OAuthConsentStatus;
    defaultStatus?: OAuthConsentStatus;
    ariaLabel?: string;
    onAuthorize?: (grantedScopeIds: string[]) => void;
    onDeny?: () => void;
    onSwitchAccount?: () => void;
}
/** OAuth 2.1 and MCP client permission consent card with granular optional scope toggles. */
export declare function OAuthConsentCard({ appName, appVendor, appIcon, clientType, verified, userName, userEmail, userAvatarSrc, workspaceName, workspaceIcon, scopes, redirectUri, securityNote, status, defaultStatus, ariaLabel, onAuthorize, onDeny, onSwitchAccount, className, ...props }: OAuthConsentCardProps): import("react").JSX.Element;
/** Schedule display mode for `CalendarView`. */
export type CalendarViewMode = 'month' | 'week' | 'day';
/** Scheduled event item rendered in `CalendarView`. */
export interface CalendarEvent {
    id: string;
    title: string;
    /** ISO date YYYY-MM-DD */
    date: string;
    /** Minutes from midnight (e.g. 540 = 09:00) */
    startMinutes?: number;
    /** Minutes from midnight (e.g. 600 = 10:00) */
    endMinutes?: number;
    allDay?: boolean;
    tone?: Tone;
    location?: string;
    locked?: boolean;
}
/** Localized UI strings and accessibility labels for `CalendarView`. */
export interface CalendarViewWords {
    navigationAriaLabel?: string;
    previousPeriodLabel?: string;
    todayLabel?: string;
    nextPeriodLabel?: string;
    viewModeAriaLabel?: string;
    monthLabel?: string;
    weekLabel?: string;
    dayLabel?: string;
    newEventLabel?: string;
    allDayLabel?: string;
    createEventOnDayLabel?: (day: string) => string;
    moreEventsLabel?: (count: number) => string;
    eventRangeLabel?: (title: string, day: string | undefined, start: string, end: string) => string;
}
/** Props for the `CalendarView` component. */
export interface CalendarViewProps {
    events: ReadonlyArray<CalendarEvent>;
    onEventsChange?: (events: CalendarEvent[]) => void;
    mode?: CalendarViewMode;
    defaultMode?: CalendarViewMode;
    onModeChange?: (mode: CalendarViewMode) => void;
    selectedDate?: string;
    defaultSelectedDate?: string;
    onSelectedDateChange?: (date: string) => void;
    onEventClick?: (event: CalendarEvent) => void;
    onCreateEvent?: (date: string, startMinutes?: number) => void;
    locale?: string;
    words?: CalendarViewWords;
    weekStart?: 0 | 1;
    today?: string;
    dayStartHour?: number;
    dayEndHour?: number;
    stepMinutes?: number;
    maxMonthEventsPerDay?: number;
    scheduleHeight?: number;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Month, week, and day schedule surface with timed event blocks and navigation controls. */
export declare function CalendarView({ events: propEvents, onEventsChange, mode: controlledMode, defaultMode, onModeChange, selectedDate: controlledDate, defaultSelectedDate, onSelectedDateChange, onEventClick, onCreateEvent, locale, words, weekStart, today: explicitToday, dayStartHour, dayEndHour, stepMinutes, maxMonthEventsPerDay, scheduleHeight, className, ref, }: CalendarViewProps): import("react").JSX.Element;
/** Supported desktop column count for `CardGridView`. */
export type CardGridColumns = 2 | 3 | 4;
/** Key/value metric cell displayed inside a `CardGridView` card. */
export interface CardGridMetric {
    label: string;
    value: ReactNode;
}
/** Tag badge descriptor displayed inside a `CardGridView` card. */
export type CardGridTag = string | {
    label: string;
    tone?: Tone;
};
/** Status indicator descriptor displayed in the top bar of a `CardGridView` card. */
export interface CardGridStatus {
    label: ReactNode;
    tone?: Tone;
    variant?: 'dot' | 'badge';
    pulse?: boolean;
}
/** Assignee identity summary displayed in the footer of a `CardGridView` card. */
export interface CardGridAssignee {
    name: string;
    role?: ReactNode;
    email?: string;
    src?: string;
    avatarUrl?: string;
    status?: AvatarStatus;
}
/** Overflow menu action descriptor for a single `CardGridView` card. */
export interface CardGridAction<T = unknown> {
    id?: string;
    label: ReactNode;
    icon?: ReactNode;
    shortcut?: string;
    danger?: boolean;
    disabled?: boolean;
    onSelect: (item: CardGridItem<T>) => void;
}
/** Multi-select bulk action descriptor for `CardGridView`. */
export interface CardGridBulkAction<T = unknown> {
    id: string;
    label: ReactNode;
    icon?: ReactNode;
    danger?: boolean;
    onAction: (selectedIds: string[], selectedItems: Array<CardGridItem<T>>) => void;
}
/** Record card item rendered in `CardGridView`. */
export interface CardGridItem<T = unknown> {
    id: string;
    code?: string;
    title: ReactNode;
    subtitle?: ReactNode;
    description?: ReactNode;
    status?: CardGridStatus | ReactNode;
    metrics?: ReadonlyArray<CardGridMetric>;
    tags?: ReadonlyArray<CardGridTag>;
    assignee?: CardGridAssignee;
    meta?: ReactNode;
    actions?: ReadonlyArray<MenuEntry>;
    tone?: Tone;
    data?: T;
}
/** Props for the `CardGridView` component. */
export interface CardGridViewProps<T = unknown> {
    items: ReadonlyArray<CardGridItem<T>>;
    columns?: CardGridColumns;
    selectable?: boolean;
    selectedIds?: ReadonlyArray<string>;
    defaultSelectedIds?: ReadonlyArray<string>;
    onSelectedIdsChange?: (ids: string[]) => void;
    bulkActions?: ReadonlyArray<CardGridBulkAction<T>>;
    onCardClick?: (item: CardGridItem<T>) => void;
    cardActions?: (item: CardGridItem<T>) => ReadonlyArray<CardGridAction<T>>;
    renderCard?: (item: CardGridItem<T>, selected: boolean) => ReactNode;
    toolbar?: ReactNode;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Responsive multi-column record card grid with multi-selection, overflow menus, and bulk actions. */
export declare function CardGridView<T = unknown>(props: CardGridViewProps<T>): import("react").JSX.Element;
/** Supported schema column data type in `CsvImportWizard`. */
export type CsvFieldType = 'string' | 'number' | 'date' | 'email';
/** Target schema field definition for `CsvImportWizard`. */
export interface CsvSchemaField {
    key: string;
    label: string;
    required?: boolean;
    type?: CsvFieldType;
    description?: string;
}
/** Mapping from 0-based CSV column index to target schema field key. */
export type CsvColumnMapping = Record<number, string>;
/** Severity level of a cell validation issue in `CsvImportWizard`. */
export type CsvIssueSeverity = 'warning' | 'critical';
/** Cell-level validation diagnostic emitted during `CsvImportWizard` dry-run checks. */
export interface CsvCellIssue {
    fieldKey: string;
    fieldLabel: string;
    severity: CsvIssueSeverity;
    message: string;
}
/** Validated CSV row record with coerced field values and cell diagnostics. */
export interface CsvValidatedRow {
    rowNumber: number;
    rawCells: string[];
    record: Record<string, string | number | null>;
    displayValues: Record<string, string>;
    issues: Record<string, CsvCellIssue>;
    valid: boolean;
}
/** Committed import payload emitted by `CsvImportWizard`. */
export interface CsvImportResult {
    records: Array<Record<string, string | number | null>>;
    validCount: number;
    issueRowCount: number;
    skippedCount: number;
    mapping: Record<string, string>;
}
/** Props for the `CsvImportWizard` component. */
export interface CsvImportWizardProps {
    schemaFields?: ReadonlyArray<CsvSchemaField>;
    sampleCsv?: string;
    initialCsv?: string;
    onCommitImport?: (result: CsvImportResult) => void;
    commitLabel?: string;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Three-step CSV import wizard with header auto-matching, cell type validation, and dry-run commit summary. */
export declare function CsvImportWizard({ schemaFields, sampleCsv, initialCsv, onCommitImport, commitLabel, className, ref, }: CsvImportWizardProps): import("react").JSX.Element;
/** Sort direction for a `DataTable` column. */
export type SortDirection = 'asc' | 'desc';
/** Active column sort state in `DataTable`. */
export interface DataTableSort {
    columnId: string;
    direction: SortDirection;
}
/** Column definition for `DataTable`. */
export interface DataTableColumn<T> {
    id: string;
    header: ReactNode;
    headerLabel?: string;
    accessor?: keyof T | ((row: T) => unknown);
    cell?: (row: T, rowIndex: number) => ReactNode;
    align?: 'left' | 'center' | 'right';
    width?: number;
    sortable?: boolean;
    /** What the column sorts by, where it is not the cell's own value. Dates sort by time and numbers by size without one. */
    sortValue?: (row: T) => string | number;
    editable?: boolean;
    editText?: (row: T) => string;
    hideable?: boolean;
    defaultHidden?: boolean;
    mono?: boolean;
}
/** Per-row overflow menu action descriptor in `DataTable`. */
export interface DataTableRowAction<T> {
    id: string;
    label: string;
    icon?: ReactNode;
    shortcut?: string;
    destructive?: boolean;
    disabled?: boolean;
    onSelect: (row: T) => void;
}
/** Multi-row bulk action descriptor in `DataTable`. */
export interface DataTableBulkAction<T> {
    id: string;
    label: string;
    icon?: ReactNode;
    destructive?: boolean;
    /**
     * `selectedIds` is the selection, whole. `selectedRows` is the row for each of those ids the table has been shown,
     * in the same order: every one of them when the table holds all the data, and under server paging (`totalCount`)
     * the rows of the pages the person selected on, as they were when last displayed. An id the host selected itself
     * (`selectedIds`, `defaultSelectedIds`) on a page never displayed has no row, so act on the ids where the two
     * can differ.
     */
    onAction: (selectedIds: string[], selectedRows: T[]) => void;
}
/** Props for the `DataTable` view. */
export interface DataTableProps<T> {
    data: T[];
    columns: DataTableColumn<T>[];
    /**
     * A row's identity, which selection and inline edits are kept by. Without it a row's own `id` is used, and a row
     * with neither is known only by its position: its selection and edits cannot follow it through a filter, a sort
     * upstream or a refetch, so they are cleared whenever `data` changes. Pass this for a selection that lasts.
     */
    getRowId?: (row: T, index: number) => string;
    /** The rows are being fetched: placeholder rows stand in for an empty table, and the table says it is busy. */
    loading?: boolean;
    sort?: DataTableSort | null;
    defaultSort?: DataTableSort | null;
    onSortChange?: (sort: DataTableSort | null) => void;
    manualSort?: boolean;
    selectable?: boolean;
    selectedIds?: string[];
    defaultSelectedIds?: string[];
    onSelectedIdsChange?: (ids: string[]) => void;
    bulkActions?: DataTableBulkAction<T>[];
    columnConfigurable?: boolean;
    columnWidths?: Record<string, number>;
    defaultColumnWidths?: Record<string, number>;
    onColumnWidthsChange?: (widths: Record<string, number>) => void;
    columnOrder?: string[];
    defaultColumnOrder?: string[];
    onColumnOrderChange?: (order: string[]) => void;
    hiddenColumnIds?: string[];
    defaultHiddenColumnIds?: string[];
    onHiddenColumnIdsChange?: (hiddenIds: string[]) => void;
    onCellEdit?: (rowId: string, columnId: string, nextValue: string, row: T) => boolean | void;
    groupBy?: keyof T | ((row: T) => string);
    renderGroupHeader?: (groupKey: string, count: number) => ReactNode;
    onRowClick?: (row: T) => void;
    rowActions?: (row: T) => DataTableRowAction<T>[];
    toolbar?: ReactNode;
    stickyHeader?: boolean;
    maxHeight?: number | string;
    empty?: EmptyStateSpec | ReactNode;
    paginated?: boolean;
    pageSize?: number;
    page?: number;
    defaultPage?: number;
    onPageChange?: (page: number) => void;
    totalCount?: number;
    /** Responsive behavior on narrow viewports (<= 640px): stacked labeled cards by default, or horizontal scroll. */
    mobileLayout?: 'cards' | 'scroll';
    ariaLabel?: string;
    words?: DataTableWords;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Localized UI strings for `DataTable` controls and menus. */
export interface DataTableWords {
    selectAllVisible?: string;
    rowActions?: string;
    actionsHeader?: string;
    sortAscending?: string;
    sortDescending?: string;
    clearSort?: string;
    hideColumn?: string;
    columnsButton?: string;
    displayColumns?: string;
    dragToReorder?: string;
    columnOrder?: string;
    bulkActionsRegion?: string;
    selectedSuffix?: string;
    clearSelection?: string;
    previousPage?: string;
    nextPage?: string;
    prevButton?: string;
    nextButton?: string;
}
/** Sortable, resizable, selectable data table with inline editing, grouping, bulk actions, and responsive card layout. */
export declare function DataTable<T>(props: DataTableProps<T>): import("react").JSX.Element;
/** Selectable option entry inside a `FilterFacet`. */
export interface FilterFacetOption {
    value: string;
    label: string;
    count?: number;
    icon?: ReactNode;
    tone?: Tone;
}
/** Facet dimension definition in `FilterBar`. */
export interface FilterFacet {
    id: string;
    label: string;
    icon?: ReactNode;
    options: FilterFacetOption[];
}
/** Map of facet IDs to selected option value arrays in `FilterBar`. */
export type FilterValues = Record<string, string[]>;
/** Localized UI strings for `FilterBar` controls and popovers. */
export interface FilterBarWords {
    regionLabel?: string;
    clearSearch?: string;
    addFilterButton?: string;
    addFilterPlaceholder?: string;
    availableFacets?: string;
    backToFacets?: string;
    clearFilterQuery?: string;
    noMatchingOptions?: string;
    noMatchingFilters?: string;
    clearFacet?: string;
}
/** Props for the `FilterBar` view. */
export interface FilterBarProps {
    facets?: FilterFacet[];
    value?: FilterValues;
    defaultValue?: FilterValues;
    onValueChange?: (filters: FilterValues) => void;
    filters?: FilterValues;
    defaultFilters?: FilterValues;
    onFiltersChange?: (filters: FilterValues) => void;
    search?: string;
    defaultSearch?: string;
    onSearchChange?: (search: string) => void;
    searchPlaceholder?: string;
    showSearch?: boolean;
    viewSwitcher?: ReactNode;
    actions?: ReactNode;
    onReset?: () => void;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    words?: FilterBarWords;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Search box, multi-select facet pills, active filter chips, and view-switcher toolbar for list and board screens. */
export declare function FilterBar({ facets, value, defaultValue, onValueChange, filters: controlledFiltersProp, defaultFilters, onFiltersChange, search: controlledSearch, defaultSearch, onSearchChange, searchPlaceholder, showSearch, viewSwitcher, actions, onReset, empty, ariaLabel, words, className, ref, }: FilterBarProps): import("react").JSX.Element;
/** Scheduled task bar descriptor in `GanttView`. */
export interface GanttTask {
    id: string;
    code?: string;
    name: string;
    owner?: string;
    ownerInitials?: string;
    status?: string;
    tone?: Tone;
    /** Start unit along timeline (e.g. day index from 0) */
    start: number;
    /** End unit along timeline (e.g. day index) */
    end: number;
    /** Completion percentage 0..100 */
    progress?: number;
    milestone?: boolean;
    locked?: boolean;
}
/** Highlighted or blocked timeline interval in `GanttView`. */
export interface GanttRegion {
    id?: string;
    from: number;
    to: number;
    label?: string;
    track?: string;
}
/** Props for the `GanttView` schedule roadmap component. */
export interface GanttViewProps {
    tasks: GanttTask[];
    onTasksChange?: (tasks: GanttTask[]) => void;
    onTaskClick?: (task: GanttTask) => void;
    /** Timeline start unit (default: 0) */
    min?: number;
    /** Timeline end unit (default: auto or 28) */
    max?: number;
    /** Drag/keyboard snap unit (default: 1) */
    step?: number;
    /** Header tick step (default: 2) */
    axisStep?: number;
    /** Present vertical line position (e.g. current day offset) */
    now?: number | (() => number);
    /** Blocked/weekend/freeze regions rendered via SpansRegion */
    regions?: GanttRegion[];
    /** Optional anchor calendar date (ISO YYYY-MM-DD or Date) for formatting day offsets as dates */
    startDate?: string | Date;
    locale?: string;
    /** Custom formatter for timeline header ticks (e.g. Day 1 -> "Nov 14") */
    formatTick?: (unit: number) => string;
    /** Custom formatter for task bar range readout */
    formatRange?: (start: number, end: number) => string;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    className?: string;
}
/** Interactive Gantt schedule pairing a task metadata sheet with draggable timeline bars. */
export declare function GanttView({ tasks: propTasks, onTasksChange, onTaskClick, min, max: explicitMax, step, axisStep, now, regions, startDate, locale, formatTick: explicitFormatTick, formatRange, ariaLabel, className, }: GanttViewProps): import("react").JSX.Element;
/** Hierarchical execution trace span item in `WaterfallView`. */
export interface WaterfallSpanItem {
    value: string;
    label: string;
    start: number;
    duration: number;
    service?: string;
    tone?: Tone;
    statusText?: string;
    children?: WaterfallSpanItem[];
}
/** Vertical timestamp marker line in `WaterfallView`. */
export interface WaterfallMarker {
    time: number;
    label?: string;
}
/** Props for the `WaterfallView` execution trace component. */
export interface WaterfallViewProps {
    items: WaterfallSpanItem[];
    range?: [number, number];
    marks?: WaterfallMarker[];
    value?: string | null;
    defaultValue?: string | null;
    onSelectSpan?: (span: WaterfallSpanItem | null, id: string | null) => void;
    expanded?: string[];
    defaultExpanded?: string[];
    onExpandedChange?: (expanded: string[]) => void;
    title?: string;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    className?: string;
}
/** Hierarchical distributed trace and request waterfall timeline with span inspector. */
export declare function WaterfallView({ items, range, marks, value: controlledValue, defaultValue, onSelectSpan, expanded: controlledExpanded, defaultExpanded, onExpandedChange, title, ariaLabel, className, }: WaterfallViewProps): import("react").JSX.Element;
/** Priority level of a `KanbanCard`. */
export type KanbanPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';
/** Tag badge attached to a `KanbanCard`. */
export interface KanbanTag {
    label: string;
    tone?: Tone;
}
/** Assignee identity summary on a `KanbanCard`. */
export interface KanbanAssignee {
    name: string;
    initials?: string;
    avatarUrl?: string;
}
/** Work item card rendered inside a `KanbanBoard` lane. */
export interface KanbanCard {
    id: string;
    code?: string;
    title: string;
    description?: string;
    priority?: KanbanPriority;
    tags?: KanbanTag[];
    assignee?: KanbanAssignee;
    dueDate?: string;
    metric?: number;
    tone?: Tone;
}
/** Lane column definition in `KanbanBoard`. */
export interface KanbanColumn {
    id: string;
    title: string;
    tone?: Tone;
    wipLimit?: number;
    metricUnit?: string;
}
/** Map of column IDs to ordered `KanbanCard` ID arrays. */
export type KanbanLaneMap = Record<string, string[]>;
/** Localized UI strings for `KanbanBoard` lanes and quick-add controls. */
export interface KanbanBoardWords {
    newCardLabel?: string;
    newCardPlaceholder?: string;
    wipReached?: string;
    cannotMove?: string;
    dropHere?: string;
    empty?: string;
    addItem?: string;
    add?: string;
    cancel?: string;
}
/** Props for the `KanbanBoard` component. */
export interface KanbanBoardProps {
    columns: KanbanColumn[];
    cards: KanbanCard[] | Record<string, KanbanCard>;
    value?: KanbanLaneMap;
    defaultValue?: KanbanLaneMap;
    onValueChange?: (value: KanbanLaneMap, details: Change<TransferReason, TransferMove>) => void;
    accepts?: (cardId: string, toColumnId: string) => boolean;
    onCardClick?: (card: KanbanCard) => void;
    allowCreate?: boolean;
    onCreateCard?: (columnId: string, title: string, createdCard: KanbanCard) => void;
    formatMetric?: (sum: number, column: KanbanColumn) => string;
    renderCard?: (card: KanbanCard) => ReactNode;
    empty?: EmptyStateSpec | ReactNode;
    words?: KanbanBoardWords;
    ariaLabel?: string;
    className?: string;
}
/** Multi-lane drag-and-drop Kanban board with WIP limits, priority tags, and inline card creation. */
export declare function KanbanBoard({ columns, cards, value: controlledLanes, defaultValue, onValueChange, accepts, onCardClick, allowCreate: allowCreateProp, onCreateCard, formatMetric, renderCard, empty, words, ariaLabel, className, }: KanbanBoardProps): import("react").JSX.Element;
/** Procedural SVG artwork motif index (`1..6`) for media fallbacks. */
export type MediaArtworkVariant = 1 | 2 | 3 | 4 | 5 | 6;
/** Supported attachment document or media kind in `AttachmentList`, `MediaGallery`, and `FileLightbox`. */
export type AttachmentFileKind = 'pdf' | 'sql' | 'json' | 'png' | 'csv' | 'svg' | 'code' | 'doc';
/** File or media attachment descriptor shared across `AttachmentList`, `MediaGallery`, and `FileLightbox`. */
export interface AttachmentItem {
    id: string;
    name: string;
    size: string | number;
    mimeType?: string;
    kind?: AttachmentFileKind;
    uploadedBy?: string;
    uploadedAt?: string;
    previewUrl?: string;
    artworkVariant?: MediaArtworkVariant;
    codePreview?: string;
    dimensions?: string;
    checksum?: string;
    category?: string;
    caption?: string;
}
/** Props for the `FileLightbox` component. */
export interface FileLightboxProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    items: ReadonlyArray<AttachmentItem>;
    activeIndex?: number;
    defaultIndex?: number;
    onIndexChange?: (index: number) => void;
    onDownload?: (item: AttachmentItem) => void;
    className?: string;
}
/** Fullscreen modal file preview lightbox with keyboard Left/Right navigation and code/metadata views. */
export declare function FileLightbox({ open, onOpenChange, items, activeIndex, defaultIndex, onIndexChange, onDownload, className, }: FileLightboxProps): import("react").JSX.Element | null;
/** Display mode for `AttachmentList`. */
export type AttachmentListLayout = 'list' | 'grid';
/** Props for the `AttachmentList` component. */
export interface AttachmentListProps extends Omit<ComponentProps<'div'>, 'title' | 'onSelect' | 'onChange' | 'aria-label' | 'inlist'> {
    title?: ReactNode;
    items?: ReadonlyArray<AttachmentItem>;
    defaultItems?: ReadonlyArray<AttachmentItem>;
    layout?: AttachmentListLayout;
    defaultLayout?: AttachmentListLayout;
    onLayoutChange?: (layout: AttachmentListLayout) => void;
    showLayoutToggle?: boolean;
    disableLightbox?: boolean;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    onSelect?: (item: AttachmentItem, index: number) => void;
    onDownload?: (item: AttachmentItem) => void;
    onDelete?: (id: string) => void;
}
/** File attachment list and thumbnail grid with download, delete, and modal preview lightbox. */
export declare function AttachmentList({ title, items, defaultItems, layout, defaultLayout, onLayoutChange, showLayoutToggle, disableLightbox, empty, ariaLabel, onSelect, onDownload, onDelete, className, ...props }: AttachmentListProps): import("react").JSX.Element;
/** Image tile descriptor rendered in `PhotoMosaic`. */
export interface PhotoMosaicTile {
    id: string;
    title: string;
    alt?: string;
    caption?: string;
    src?: string;
    artworkVariant?: MediaArtworkVariant;
    dimensions?: string;
    uploadedBy?: string;
    size?: string;
}
/** Props for the `PhotoMosaic` component. */
export interface PhotoMosaicProps extends Omit<ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
    tiles?: ReadonlyArray<PhotoMosaicTile>;
    disableLightbox?: boolean;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    onTileClick?: (tile: PhotoMosaicTile, index: number) => void;
}
/** Asymmetric two-to-four tile photo mosaic opening a full-screen `FileLightbox` on click. */
export declare function PhotoMosaic({ tiles, disableLightbox, empty, ariaLabel, onTileClick, className, ...props }: PhotoMosaicProps): import("react").JSX.Element;
/** Media asset item rendered in `MediaGallery`. */
export interface MediaGalleryItem {
    id: string;
    title: string;
    caption?: string;
    category?: string;
    src?: string;
    artworkVariant?: MediaArtworkVariant;
    dimensions?: string;
    size?: string;
    uploadedBy?: string;
    uploadedAt?: string;
}
/** Props for the `MediaGallery` component. */
export interface MediaGalleryProps extends Omit<ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
    items?: ReadonlyArray<MediaGalleryItem>;
    columns?: 2 | 3 | 4;
    showFilters?: boolean;
    disableLightbox?: boolean;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    onItemClick?: (item: MediaGalleryItem, index: number) => void;
}
/** Responsive category-filterable visual media gallery with modal `FileLightbox` preview. */
export declare function MediaGallery({ items, columns, showFilters, disableLightbox, empty, ariaLabel, onItemClick, className, ...props }: MediaGalleryProps): import("react").JSX.Element;
/** Setup task step rendered in `OnboardingChecklist`. */
export interface OnboardingStep {
    id: string;
    title: ReactNode;
    description?: ReactNode;
    completed?: boolean;
    estimatedTime?: string;
    actionLabel?: string;
    detailNote?: ReactNode;
}
/** Props for the `OnboardingChecklist` component. */
export interface OnboardingChecklistProps extends Omit<ComponentProps<'section'>, 'title' | 'onChange' | 'aria-label' | 'inlist'> {
    title?: ReactNode;
    subtitle?: ReactNode;
    steps?: ReadonlyArray<OnboardingStep>;
    completedIds?: ReadonlyArray<string>;
    defaultCompletedIds?: ReadonlyArray<string>;
    collapsed?: boolean;
    defaultCollapsed?: boolean;
    onCollapsedChange?: (collapsed: boolean) => void;
    dismissed?: boolean;
    ariaLabel?: string;
    onToggleStep?: (stepId: string, completed: boolean) => void;
    onStepAction?: (stepId: string) => void;
    onDismiss?: () => void;
}
/** Collapsible first-run setup checklist card with circular progress ring and expandable step actions. */
export declare function OnboardingChecklist({ title, subtitle, steps, completedIds, defaultCompletedIds, collapsed, defaultCollapsed, onCollapsedChange, dismissed, ariaLabel, onToggleStep, onStepAction, onDismiss, className, ...props }: OnboardingChecklistProps): import("react").JSX.Element | null;
/** Step card descriptor in `SpotlightTour`. */
export interface SpotlightTourStep {
    id: string;
    title: ReactNode;
    description: ReactNode;
    badge?: string;
    shortcut?: string;
    targetLabel?: string;
    media?: ReactNode;
}
/** Props for the `SpotlightTour` component. */
export interface SpotlightTourProps extends Omit<ComponentProps<'div'>, 'title' | 'onChange' | 'aria-label' | 'inlist'> {
    steps?: ReadonlyArray<SpotlightTourStep>;
    step?: number;
    defaultStep?: number;
    onStepChange?: (stepIndex: number) => void;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    trigger?: ReactNode;
    side?: 'top' | 'bottom' | 'left' | 'right';
    align?: 'start' | 'center' | 'end';
    allowRestart?: boolean;
    ariaLabel?: string;
    onFinish?: () => void;
    onSkip?: () => void;
}
/** Guided multi-step feature spotlight card or anchored popover tour. */
export declare function SpotlightTour({ steps, step, defaultStep, onStepChange, open, defaultOpen, onOpenChange, trigger, side, align, allowRestart, ariaLabel, onFinish, onSkip, className, ...props }: SpotlightTourProps): import("react").JSX.Element | null;
/** Triage decision outcome recorded in `ReviewQueueView`. */
export type ReviewQueueDecision = 'approved' | 'changes-requested';
/** Requester identity summary for a `ReviewQueueItem`. */
export interface ReviewQueueRequester {
    name: string;
    role?: ReactNode;
    email?: string;
    src?: string;
    status?: AvatarStatus;
}
/** Field-by-field before/after diff entry on a `ReviewQueueItem`. */
export interface ReviewQueueDiff {
    field: string;
    before?: ReactNode;
    after: ReactNode;
    changeType?: 'modified' | 'added' | 'removed';
}
/** Key/value context metadata entry on a `ReviewQueueItem`. */
export interface ReviewQueueMetaItem {
    label: ReactNode;
    value: ReactNode;
}
/** Queued approval or triage item rendered in `ReviewQueueView`. */
export interface ReviewQueueItem<T = unknown> {
    id: string;
    code?: string;
    title: string;
    category?: string;
    priority?: 'urgent' | 'high' | 'medium' | 'low';
    tone?: Tone;
    submittedAt?: string;
    requester: ReviewQueueRequester;
    summary: ReactNode;
    diffs?: ReviewQueueDiff[];
    metadata?: ReviewQueueMetaItem[];
    data?: T;
}
/** Recorded triage decision entry emitted by `ReviewQueueView`. */
export interface ReviewQueueDecisionRecord<T = unknown> {
    id: string;
    item: ReviewQueueItem<T>;
    decision: ReviewQueueDecision;
    note: string;
    decidedAt: string;
}
/** Props for the `ReviewQueueView` component. */
export interface ReviewQueueViewProps<T = unknown> {
    items: Array<ReviewQueueItem<T>>;
    value?: string[];
    defaultValue?: string[];
    onValueChange?: (handledIds: string[], details?: Change<TurnsReason>) => void;
    onApprove?: (item: ReviewQueueItem<T>, note: string) => void;
    onRequestChanges?: (item: ReviewQueueItem<T>, note: string) => void;
    onDecision?: (record: ReviewQueueDecisionRecord<T>) => void;
    onReset?: () => void;
    title?: ReactNode;
    allowNotes?: boolean;
    notePlaceholder?: string;
    enableShortcuts?: boolean;
    approveLabel?: ReactNode;
    requestChangesLabel?: ReactNode;
    skipLabel?: ReactNode;
    resetLabel?: ReactNode;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    locale?: string;
    words?: ReviewQueueWords;
    renderItemDetail?: (item: ReviewQueueItem<T>) => ReactNode;
    framed?: boolean;
    className?: string;
}
/** Localized UI strings for `ReviewQueueView` landmarks and progress indicators. */
export interface ReviewQueueWords {
    shortcutsLabel?: string;
    progressLabel?: string;
    overviewLabel?: string;
}
/** Split-pane approval triage queue pairing a filterable request list with field-by-field before/after diffs. */
export declare function ReviewQueueView<T = unknown>({ items, value: controlledHandled, defaultValue, onValueChange, onApprove, onRequestChanges, onDecision, onReset, title, allowNotes, notePlaceholder, enableShortcuts, approveLabel, requestChangesLabel, skipLabel, resetLabel, empty, ariaLabel, locale, words, renderItemDetail, framed, className, }: ReviewQueueViewProps<T>): import("react").JSX.Element;
/** Cascading check propagation mode for `TreeView`. */
export type TreeCheckStrategy = 'leaf' | 'trunk' | 'branch' | 'independent';
/** Hierarchical tree node item rendered in `TreeView`. */
export interface TreeNode {
    id: string;
    label: string;
    icon?: ReactNode;
    badge?: string | number;
    tone?: Tone;
    disabled?: boolean;
    href?: string;
    children?: ReadonlyArray<TreeNode>;
    data?: unknown;
}
/** Props for the `TreeView` component. */
export interface TreeViewProps {
    nodes: ReadonlyArray<TreeNode>;
    searchable?: boolean;
    search?: string;
    defaultSearch?: string;
    onSearchChange?: (query: string) => void;
    searchPlaceholder?: string;
    selectedId?: string | null;
    defaultSelectedId?: string | null;
    onSelectNode?: (node: TreeNode | null, id: string | null) => void;
    expandedIds?: ReadonlyArray<string>;
    defaultExpandedIds?: ReadonlyArray<string>;
    onExpandedIdsChange?: (expandedIds: string[]) => void;
    expandOnPress?: boolean;
    checkable?: boolean;
    checkStrategy?: TreeCheckStrategy;
    checkedIds?: ReadonlyArray<string>;
    defaultCheckedIds?: ReadonlyArray<string>;
    onCheckedIdsChange?: (checkedIds: string[]) => void;
    defaultIcons?: boolean;
    headerActions?: ReactNode;
    empty?: EmptyStateSpec | ReactNode;
    ariaLabel?: string;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Expandable hierarchical tree view with live search filtering, single selection, and checkable multi-selection. */
export declare function TreeView(props: TreeViewProps): import("react").JSX.Element;
