export function makeRedactor(patterns: string[]): (value: string) => string {
  const regexes = patterns.map((pattern) => new RegExp(pattern, "g"));
  return (value: string) => regexes.reduce((text, regex) => text.replace(regex, "[REDACTED]"), value);
}
