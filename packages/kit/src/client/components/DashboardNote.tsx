/** A dashboard note is authored guidance, with at most one available next room. */
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { Icon } from './Icon.js';
import { useListNavigation } from './listNavigation.js';
import type { AppLinkAction } from '@mistriwork/engine/shared/appLinks.js';
import { shell } from '../shellMode.js';

interface DashboardNoteProps {
  title?: string;
  text: string;
  icon?: AppIconName;
  action?: AppLinkAction;
  row?: Readonly<Record<string, unknown>>;
  /** A page's note is plain, quiet or a callout; a dashboard's may be its banner. */
  variant?: 'quiet' | 'callout' | 'banner';
  /** A banner's short tag over its title. */
  eyebrow?: string;
  /** A banner's picture, already an address. */
  image?: { src: string; alt: string };
}

export function DashboardNote({ title, text, icon, action, row, variant, eyebrow, image }: DashboardNoteProps) {
  /* The shell's navigation, not viewLink itself: a record page draws notes
     too, and viewLink reaches back into the page modules through the walk. */
  const navigate = useListNavigation();
  /* A call to action into another App of the suite is the App framework's (shellMode.ts): none where the shell has none. */
  const { TargetAction } = shell().slots;
  const link = action && 'view' in action ? navigate?.(action.view) : undefined;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const words = (
    <>
      {icon && <Icon name={icon} size={28} className="dashboard-note-icon" />}
      {eyebrow && <span className="dashboard-note-eyebrow">{eyebrow}</span>}
      {title && <h2 className="dashboard-note-title">{title}</h2>}
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="dashboard-note-text">
          {paragraph}
        </p>
      ))}
      {action && link && (
        <a className="dashboard-note-action" {...link}>
          {action.label}
          {variant === 'banner' && <Icon name="caret-right" size={14} />}
        </a>
      )}
      {action && 'to' in action && TargetAction && <TargetAction label={action.label} to={action.to} row={row} />}
    </>
  );
  /* A banner's words and its picture are two columns; the picture is sized by the banner, never by its file, so
     it arriving moves nothing. */
  if (variant === 'banner')
    return (
      <div className={`dashboard-note is-banner${image ? ' has-image' : ''}`}>
        <div className="dashboard-note-words">{words}</div>
        {image && (
          <span className="dashboard-note-picture">
            <img src={image.src} alt={image.alt} decoding="async" />
          </span>
        )}
      </div>
    );
  return <div className={`dashboard-note${variant ? ` is-${variant}` : ''}`}>{words}</div>;
}
