/** Decide where the Queue header pill should take the user.
 *
 * The pill is a toggle: from anywhere it goes to /queue and remembers the
 * origin; from /queue it returns to the remembered origin (home if the queue
 * was the entry point). Pure so it is trivially testable — the caller owns
 * the remembered value.
 */
export function resolveQueueToggle(
  currentPathname: string,
  remembered: string | null,
): { to: string; remember: string | null } {
  if (currentPathname === "/queue") {
    return { to: remembered ?? "/", remember: remembered }
  }
  return { to: "/queue", remember: currentPathname }
}
