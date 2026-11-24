/** Chronological audit and comment feed with reactions, file chips, and @mention comment composer. */
import { Icon } from '../Icon.js';
import { Avatar, AvatarFallback, AvatarImage } from '@ui-sdk/react/avatar';
import { Button } from '@ui-sdk/react/button';
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import {
  Timeline,
  TimelineConnector,
  TimelineDescription,
  TimelineItem,
  TimelineMarker,
  TimelineTime,
  TimelineTitle,
} from '@ui-sdk/react/timeline';
import {
  createTriggerMenuController,
  type TriggerDefinition,
  TriggerMenu,
  TriggerMenuContent,
  TriggerMenuEmpty,
  TriggerMenuInput,
  TriggerMenuItem,
  TriggerMenuList,
} from '@ui-sdk/react/trigger-menu';
import { type FormEvent, Fragment, type ReactNode, type Ref, useMemo, useRef, useState } from 'react';
import { cx, isEmptyStateSpec, toDataTone, type EmptyStateSpec, type Tone } from '../internal/cx.js';

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
  /* Comment fields */
  body?: string;
  reactions?: ReadonlyArray<ActivityReaction>;
  attachments?: ReadonlyArray<ActivityAttachment>;
  /* Event fields */
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

const QUICK_EMOJIS = ['👍', '🎉', '🚀', '❤️', '👀', '🔥'] as const;

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

function renderFormattedBody(text: string): ReactNode {
  const parts = text.split(/(@[a-zA-Z0-9_.-]+)/g);
  return parts.map((segment, idx) => {
    if (segment.startsWith('@') && segment.length > 1) {
      return (
        <span key={idx} className="nx-activity-mention">
          {segment}
        </span>
      );
    }
    return <Fragment key={idx}>{segment}</Fragment>;
  });
}

/** Rich comment input with `@mention` trigger suggestions and attachment button. */
export function CommentComposer({
  mentionUsers = [],
  placeholder = 'Leave a comment… Type @ to mention a teammate',
  submitLabel = 'Comment',
  onSubmit,
  onAttachClick,
  className,
  ref,
}: CommentComposerProps) {
  const [body, setBody] = useState('');
  const controllerRef = useRef(createTriggerMenuController());

  const triggers = useMemo<TriggerDefinition<string>[]>(
    () => [
      {
        char: '@',
        boundary: 'word',
        insert: (item) => `@${item.value} `,
      },
    ],
    [],
  );

  const [submitting, setSubmitting] = useState(false);

  const submitNow = async () => {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const result = await onSubmit?.(trimmed);
      if (result !== false) setBody('');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitNow();
  };

  return (
    <form ref={ref} className={cx('nx-comment-composer', className)} onSubmit={handleFormSubmit}>
      <TriggerMenu triggers={triggers} controller={controllerRef.current}>
        <TriggerMenuInput
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submitNow();
            }
          }}
          placeholder={placeholder}
          rows={3}
          aria-label="Write a comment"
          className="nx-comment-textarea"
        />

        {mentionUsers.length > 0 && (
          <TriggerMenuContent side="top" align="start" sideOffset={6} className="nx-mention-popup">
            <TriggerMenuEmpty className="nx-mention-empty">No matching teammates</TriggerMenuEmpty>
            <TriggerMenuList aria-label="Mention suggestions" className="nx-mention-list">
              {mentionUsers.map((user) => (
                <TriggerMenuItem
                  key={user.id}
                  value={user.handle}
                  label={user.name}
                  keywords={[user.handle, user.role ?? '']}
                  className="nx-mention-item"
                >
                  <Avatar className="nx-mention-avatar">
                    {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.name} />}
                    <AvatarFallback className="nx-mention-avatar-fallback">{user.initials ?? initialsOf(user.name)}</AvatarFallback>
                  </Avatar>
                  <span className="nx-mention-name">{user.name}</span>
                  <span className="nx-mention-handle">@{user.handle}</span>
                  {user.role && <span className="nx-mention-role">{user.role}</span>}
                </TriggerMenuItem>
              ))}
            </TriggerMenuList>
          </TriggerMenuContent>
        )}
      </TriggerMenu>

      <div className="nx-comment-composer-bar">
        <div className="nx-comment-composer-tools">
          {mentionUsers.length > 0 && (
            <button
              type="button"
              className="nx-comment-tool-btn"
              title="Mention teammate (@)"
              onClick={() => {
                controllerRef.current.focus();
                controllerRef.current.insert('@');
              }}
            >
              <Icon name="at" size={14} weight="bold" />
              <span>Mention</span>
            </button>
          )}
          {onAttachClick && (
            <button type="button" className="nx-comment-tool-btn" title="Attach file" onClick={onAttachClick}>
              <Icon name="paperclip" size={14} />
              <span>Attach</span>
            </button>
          )}
          <span className="nx-comment-shortcut-hint">
            <kbd className="nx-kbd">⌘</kbd>
            <kbd className="nx-kbd">↵</kbd>
          </span>
        </div>

        <Button type="submit" data-size="sm" data-variant="primary" disabled={body.trim().length === 0}>
          <span>{submitLabel}</span>
          <Icon name="paper-plane-tilt" size={13} weight="bold" />
        </Button>
      </div>
    </form>
  );
}

/** Chronological audit and comment feed with reactions, file chips, and `@mention` comment composer. */
export function ActivityTimeline({
  items: propItems,
  mentionUsers = [],
  currentUser = { name: 'You', initials: 'YO' },
  showComposer = true,
  composerPlaceholder,
  onSubmitComment,
  onAddComment,
  onToggleReaction,
  empty,
  ariaLabel = 'Activity feed',
  className,
  ref,
}: ActivityTimelineProps) {
  const submitComment = onSubmitComment ?? onAddComment;
  const [appendedComments, setAppendedComments] = useState<ActivityItem[]>([]);
  const [reactionOverrides, setReactionOverrides] = useState<Record<string, ActivityReaction[]>>({});

  const allItems = useMemo(
    () => (submitComment ? propItems : [...propItems, ...appendedComments]),
    [propItems, appendedComments, submitComment],
  );

  const handleToggleReaction = (item: ActivityItem, emoji: string) => {
    onToggleReaction?.(item.id, emoji);
    setReactionOverrides((prev) => {
      const current = prev[item.id] ?? item.reactions ?? [];
      const existing = current.find((r) => r.emoji === emoji);
      let next: ActivityReaction[];
      if (existing) {
        const nextCount = existing.reacted ? existing.count - 1 : existing.count + 1;
        next =
          nextCount <= 0
            ? current.filter((r) => r.emoji !== emoji)
            : current.map((r) => (r.emoji === emoji ? { ...r, count: nextCount, reacted: !r.reacted } : r));
      } else {
        next = [...current, { emoji, count: 1, reacted: true }];
      }
      return { ...prev, [item.id]: next };
    });
  };

  const handleCommentSubmit = (body: string) => {
    if (!submitComment) {
      setAppendedComments((prev) => [
        ...prev,
        {
          id: `comment-${Date.now().toString(36)}`,
          kind: 'comment',
          author: currentUser,
          timestamp: 'Just now',
          body,
          reactions: [],
        },
      ]);
    }
    return submitComment?.(body);
  };

  return (
    <div ref={ref} className={cx('nx-activity-wrap', className)}>
      <Timeline orientation="vertical" feed aria-label={ariaLabel} className="nx-activity-timeline">
        {allItems.map((item, idx) => {
          const isLast = idx === allItems.length - 1;
          const reactions = reactionOverrides[item.id] ?? item.reactions ?? [];

          if (item.kind === 'event') {
            return (
              <TimelineItem key={item.id} value={item.id} status="complete" className="nx-activity-item nx-activity-item-event">
                <div className="nx-activity-rail">
                  <TimelineMarker className="nx-activity-marker nx-activity-marker-event" data-tone={toDataTone(item.tone ?? 'neutral')}>
                    {item.icon ?? <Icon name="git-commit" size={13} weight="bold" />}
                  </TimelineMarker>
                  {!isLast && <TimelineConnector className="nx-activity-connector" />}
                </div>

                <div className="nx-activity-event-row">
                  <TimelineTitle className="nx-activity-event-title">
                    <strong className="nx-activity-author-inline">{item.author.name}</strong>{' '}
                    <span className="nx-activity-action-text">{item.action ?? 'updated'}</span>
                    {item.target && (
                      <>
                        {' '}
                        <span className="nx-badge" data-tone={toDataTone(item.tone)}>
                          {item.target}
                        </span>
                      </>
                    )}
                  </TimelineTitle>
                  <TimelineTime dateTime={item.dateTime} className="nx-activity-time">
                    {item.timestamp}
                  </TimelineTime>
                </div>
              </TimelineItem>
            );
          }

          /* Comment Item */
          return (
            <TimelineItem key={item.id} value={item.id} status="complete" className="nx-activity-item nx-activity-item-comment">
              <div className="nx-activity-rail">
                <TimelineMarker className="nx-activity-marker nx-activity-marker-avatar">
                  <Avatar className="nx-activity-avatar">
                    {item.author.avatarUrl && <AvatarImage src={item.author.avatarUrl} alt={item.author.name} />}
                    <AvatarFallback className="nx-activity-avatar-fallback">
                      {item.author.initials ?? initialsOf(item.author.name)}
                    </AvatarFallback>
                  </Avatar>
                </TimelineMarker>
                {!isLast && <TimelineConnector className="nx-activity-connector" />}
              </div>

              <div className="nx-activity-comment-card">
                <div className="nx-activity-comment-head">
                  <TimelineTitle className="nx-activity-comment-author">
                    <span>{item.author.name}</span>
                    {item.author.role && <span className="nx-activity-author-role">{item.author.role}</span>}
                  </TimelineTitle>
                  <TimelineTime dateTime={item.dateTime} className="nx-activity-time">
                    {item.timestamp}
                  </TimelineTime>
                </div>

                {item.body && (
                  <TimelineDescription className="nx-activity-comment-body">{renderFormattedBody(item.body)}</TimelineDescription>
                )}

                {item.attachments && item.attachments.length > 0 && (
                  <div className="nx-activity-attachments">
                    {item.attachments.map((att) => (
                      <a
                        key={att.id}
                        href={att.href ?? '#'}
                        onClick={(e) => {
                          if (!att.href) e.preventDefault();
                        }}
                        className="nx-activity-attachment"
                      >
                        <Icon name="file-text" size={14} />
                        <span className="nx-activity-attachment-name">{att.name}</span>
                        {att.size && <span className="nx-activity-attachment-size">{att.size}</span>}
                      </a>
                    ))}
                  </div>
                )}

                <div className="nx-activity-reactions">
                  {reactions.map((r) => (
                    <button
                      key={r.emoji}
                      type="button"
                      className="nx-reaction-pill"
                      data-reacted={r.reacted ? '' : undefined}
                      aria-pressed={Boolean(r.reacted)}
                      onClick={() => handleToggleReaction(item, r.emoji)}
                    >
                      <span>{r.emoji}</span>
                      <span className="nx-reaction-count">{r.count}</span>
                    </button>
                  ))}

                  <Popover>
                    <PopoverTrigger className="nx-reaction-add-btn" aria-label="Add emoji reaction">
                      <Icon name="smiley" size={13} />
                    </PopoverTrigger>
                    <PopoverContent side="top" align="start" sideOffset={4} className="nx-reaction-picker">
                      {QUICK_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          className="nx-reaction-emoji-btn"
                          onClick={() => handleToggleReaction(item, emoji)}
                        >
                          {emoji}
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            </TimelineItem>
          );
        })}

        {allItems.length === 0 && (
          <TimelineItem value="empty" className="nx-activity-empty-item">
            <TimelineMarker className="nx-activity-marker nx-activity-marker-event">
              <Icon name="chat-circle" size={14} />
            </TimelineMarker>
            <TimelineTitle className="nx-activity-empty-text">
              {isEmptyStateSpec(empty) ? (
                <>
                  <span>{empty.title}</span>
                  {empty.body ? <span> {empty.body}</span> : null}
                  {empty.action ?? null}
                </>
              ) : (
                (empty ?? 'No activity recorded yet.')
              )}
            </TimelineTitle>
          </TimelineItem>
        )}
      </Timeline>

      {showComposer && (
        <CommentComposer
          mentionUsers={mentionUsers}
          placeholder={composerPlaceholder}
          currentUser={currentUser}
          onSubmit={handleCommentSubmit}
        />
      )}
    </div>
  );
}
