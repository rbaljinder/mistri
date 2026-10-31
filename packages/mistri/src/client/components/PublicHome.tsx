/**
 * A public view as a signed-in visitor's home: the landing or a public form,
 * drawn in the content pane with the App's menu beside it — the front page
 * staff also see at `/{app}/welcome`, without leaving the App. The served
 * home is a view key; the landing's answer carries its own, so one read
 * says whether this is the landing, and any other public home is a public
 * form under that key. A public form submits as the public here too, even
 * for someone signed in: staff acting for someone use a signed-in form
 * their role is granted.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@mistriwork/kit/client/core.js';
import { LandingSurface } from '@mistriwork/kit/client/components/LandingSurface.js';
import { landingImage, landingSection } from './LandingData.js';
import { viewLink } from '@mistriwork/kit/client/components/viewLink.js';
import { FormSurface, formArrives, submitPublicForm, type FormPresentation } from './FormSurface.js';
import { LoadErrorNote } from '@mistriwork/kit/client/components/Landing.js';
import type { AppLanding } from '../../shared/app.js';
import { say } from '../copy/public/components/PublicHome.js';

type PublicApp = { id: string; name: string };
type Found = { kind: 'landing'; app: PublicApp; landing: AppLanding } | { kind: 'form'; app: PublicApp; form: FormPresentation };

/**
 * The landing's view key as `/api/app` served it, or null when that payload says the App declares no landing;
 * undefined when no payload key was passed, and the landing is probed as before. A home the payload says is not
 * the landing is a public form, so the landing is not probed for it — an App without a landing answered that
 * probe 404, on every signed-in visit to a form home.
 */
async function publicView(view: string, landingView?: string | null): Promise<Found> {
  const landing = (
    landingView === undefined ? await api('/api/landing').catch(() => null) : landingView === view ? await api('/api/landing') : null
  ) as { view?: string; app: PublicApp; landing: AppLanding } | null;
  if (landing?.view === view) {
    // The hero's rules are not the shell's first stylesheet (landingHero.css): they arrive before the landing is drawn.
    await import('../landingHeroShell.js');
    return { kind: 'landing', app: landing.app, landing: landing.landing };
  }
  const found = (await api(`/api/forms/${encodeURIComponent(view)}`)) as { app: PublicApp; form: FormPresentation };
  // What the form asks beyond its fields — its human check's slot, its input components — comes with it, as on its own page.
  await formArrives(found.form);
  return { kind: 'form', app: found.app, form: found.form };
}

export function PublicHome({ view, loadError, landingView }: { view: string; loadError: string; landingView?: string | null }) {
  const found = useQuery({
    queryKey: ['public-home', view, landingView ?? null],
    queryFn: () => publicView(view, landingView),
    retry: false,
    staleTime: Infinity,
  });
  const data = found.data;
  return (
    <div className="public-home">
      <LoadErrorNote error={loadError} />
      {data?.kind === 'landing' ? (
        /* Drawn inside the shell's content pane, which puts the App's footer under every room (Content.tsx). */
        <LandingSurface
          landing={data.landing}
          app={data.app}
          renderSection={landingSection}
          openView={viewLink}
          imageSrc={landingImage}
          footer={false}
        />
      ) : data?.kind === 'form' ? (
        <FormSurface
          form={data.form}
          appName={data.app.name}
          visitor={{ app: data.app.id }}
          submit={(submission, input, guard) => submitPublicForm(data.form.id, submission, input, undefined, guard)}
        />
      ) : found.error ? (
        <p className="note">{say('thisAppsStartPage', { message: found.error.message })}</p>
      ) : null}
    </div>
  );
}
