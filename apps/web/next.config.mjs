/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@sul/shared"],
  webpack: (config) => {
    // packages/shared is consumed as TypeScript source and uses explicit `.js`
    // specifiers (required by NodeNext, and what tsx/tsc resolve). Webpack does
    // not apply that mapping on its own, so `./personas.js` fails to resolve
    // against `personas.ts`. This teaches it the same rule.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
