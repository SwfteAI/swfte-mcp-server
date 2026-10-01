/**
 * Turn an article title into a URL slug.
 *
 * @example
 *   const res = await invokeContentPipeline({ sources, topic });
 *   const slugs = res.output?.articles?.map((a) => slugify(String(a.title)));
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
