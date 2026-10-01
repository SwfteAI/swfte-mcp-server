import { swfte } from '@/lib/swfte';

/** Workspace settings: shows how many new members finished onboarding. */
export default async function SettingsPage() {
  const stats = await swfte.chatflows.stats('cf_Onb7Rz');
  const pct = Math.round(stats.completionRate * 100);

  return (
    <section>
      <h2>Onboarding</h2>
      <p>
        {stats.completed} of {stats.sessions} members finished onboarding ({pct}%).
      </p>
    </section>
  );
}
