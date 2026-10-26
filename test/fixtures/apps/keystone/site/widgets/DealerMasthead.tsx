/**
 * The dealer's masthead: its mark (the two or three letters of logo_text on
 * its accent color), its headline and tagline on a band of its brand color
 * (the page's title already says its name), then
 * where it is, when it is open and how to reach it, and what it says about
 * itself.
 *
 * The colors are the dealer's data (dealer_site, edited in /dealer), not the
 * look's: that is the whole reason this is a component (SUITE.md G6). The
 * ink on each color is chosen from the color's own luminance, so a dealer
 * who picks a pale brand still reads; everything outside the band wears the
 * look's tokens. It only draws, and it runs signed out over the public grant.
 */
import { Button, Icon, useLook, useNavigate, useSectionSize, type SectionProps } from '@mistriwork/mistri/ui';
import type { Rows } from '../mistri-schema.d.ts';
import type { masthead } from '../pages/dealer.ts';
import './DealerMasthead.css';

type Props = SectionProps<typeof masthead, Rows, 'dealer'>;

const HEX = /^#[0-9a-f]{6}$/i;

/** Dark or light ink for text on a stored color: WCAG relative luminance against the midpoint. */
function inkOn(color: string): 'dark' | 'light' {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? 'dark' : 'light';
}

export default function DealerMasthead({ record, rows }: Props) {
  const { compact } = useSectionSize();
  const { mode } = useLook();
  const { openForm, openView } = useNavigate();
  const site = rows.site[0];
  if (!record || !site) return null;
  const brand = HEX.test(site.brand_color) ? site.brand_color : undefined;
  const accent = HEX.test(site.accent_color) ? site.accent_color : undefined;
  const phone = site.contact_phone || record.phone;
  const tel = `tel:+1${phone.replace(/\D/g, '')}`;
  const hours = site.hours.split(/,\s*/);
  return (
    <div className="c-dealer-masthead" data-compact={compact || undefined} data-mode={mode}>
      <div
        className="c-dealer-masthead-band"
        data-ink={brand ? inkOn(brand) : undefined}
        style={brand ? { backgroundColor: brand, borderBottomColor: accent } : undefined}
      >
        <span
          className="c-dealer-masthead-mark"
          aria-hidden="true"
          data-ink={accent ? inkOn(accent) : undefined}
          style={accent ? { backgroundColor: accent } : undefined}
        >
          {site.logo_text}
        </span>
        <div className="c-dealer-masthead-title">
          <p className="c-dealer-masthead-headline">{site.headline}</p>
          {site.tagline && <p className="c-dealer-masthead-tagline">{site.tagline}</p>}
        </div>
        <div className="c-dealer-masthead-actions">
          <Button intent="secondary" size="large" onClick={() => openView('inventory')}>
            Shop inventory
          </Button>
          <Button intent="secondary" size="large" onClick={() => openForm('apply', {})}>
            Get pre-approved
          </Button>
        </div>
      </div>
      <dl className="c-dealer-masthead-facts">
        <div>
          <dt>
            <Icon name="map-pin" size={16} /> Visit
          </dt>
          <dd>
            {record.street}
            <br />
            {record.city}, {record.state} {record.zip}
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="clock" size={16} /> Hours
          </dt>
          <dd>
            {hours.map((line, i) => (
              <span key={i}>
                {line}
                <br />
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="phone" size={16} /> Call or write
          </dt>
          <dd>
            <a href={tel}>{phone}</a>
            <br />
            <a href={`mailto:${site.contact_email}`}>{site.contact_email}</a>
          </dd>
        </div>
      </dl>
      {site.about && <p className="c-dealer-masthead-about">{site.about}</p>}
    </div>
  );
}
