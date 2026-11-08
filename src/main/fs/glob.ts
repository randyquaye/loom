// gitignore-style subset: star, double-star and question mark; a double-star
// followed by a slash also matches zero directories. (No block comment here:
// the slash-star-slash sequence inside one would terminate it early.)
export function globToRegex(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string
    if (ch === '*') {
      if (glob.slice(i, i + 3) === '**/') {
        out += '(?:.*/)?'
        i += 2
      } else if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}
