/** The locked plugin exports these two configurations but ships no declarations. */
declare module 'eslint-plugin-security' {
  import type { ESLint, Linter } from 'eslint';

  const plugin: ESLint.Plugin & {
    configs: {
      recommended: Linter.Config;
      'recommended-legacy': Linter.LegacyConfig;
    };
  };

  export default plugin;
}
