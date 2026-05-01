/**
 * Root domain extraction utility for the audit log.
 *
 * Uses a two-part hostname heuristic (last two labels of the hostname) to
 * derive a stable storage key from any URL or domain string.
 *
 * Known limitation: ccSLD domains (e.g. .co.uk, .com.au) produce an incorrect
 * two-label result (e.g. www.bbc.co.uk → co.uk). See APPENDIX-DOMAIN-EXCEPTIONS.md
 * (follow-on) for the full list of affected cases.
 */

/**
 * Normalize a URL or domain string to its two-part root domain.
 *
 * Accepts:
 *   - Full URLs:    "https://www.gap.com/jeans?q=1" → "gap.com"
 *   - Subdomains:  "shop.gap.com"                   → "gap.com"
 *   - Root domain: "gap.com"                        → "gap.com"
 *
 * Returns null for input that cannot be parsed as a URL or hostname.
 */
export function extractRootDomain(input: string): string | null {
  let hostname: string;
  try {
    // Prepend a scheme if none is present so the WHATWG URL parser can handle
    // bare hostnames and domain strings (e.g. "gap.com", "www.gap.com").
    const toParse = input.includes('://') ? input : `https://${input}`;
    hostname = new URL(toParse).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (!hostname) return null;

  const parts = hostname.split('.');
  if (parts.length < 2) return null;

  // Two-part heuristic: take the last two labels.
  return parts.slice(-2).join('.');
}
