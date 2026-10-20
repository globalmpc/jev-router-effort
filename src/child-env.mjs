// The routing proxy runs in this process, so only this process needs the Jev credential.
// A launched CLI and every shell command its agent runs would otherwise inherit it.
export const ROUTER_KEYS = Object.freeze(["JEV_API_KEY", "TYPESAFE_API_KEY"]);

/** A copy of `base` plus `overrides`, without the router credentials. */
export function childEnv(base = process.env, overrides = {}) {
  const env = { ...base, ...overrides };
  for (const key of ROUTER_KEYS) delete env[key];
  return env;
}
