const MAX_SLUG_LENGTH = 48
const MAX_ALLOC_ATTEMPTS = 1000

/**
 * Slugs double as directory names and as the tail of a git ref, so they are
 * restricted to what both accept: lowercase alphanumerics separated by dashes.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return slug === '' ? 'untitled' : slug
}

/** Disambiguates names that differ only in punctuation and therefore share a slug. */
export function allocateSlug(base: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(base)) return base
  for (let n = 2; n <= MAX_ALLOC_ATTEMPTS; n += 1) {
    const candidate = `${base}-${n}`
    if (!isTaken(candidate)) return candidate
  }
  throw new Error(`could not allocate a unique slug from "${base}"`)
}
