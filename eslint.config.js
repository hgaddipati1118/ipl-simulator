import tseslint from "typescript-eslint";
import tailwindBan from "eslint-plugin-tailwind-ban";

// Ban hardcoded gray/slate colors that break light/dark mode.
// Use th-* theme classes instead (th-primary, th-muted, th-body, th-raised, etc.)
const grayShades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const bannedPrefixes = ["bg-gray", "bg-slate", "text-gray", "text-slate", "border-gray", "border-slate"];
const denyList = bannedPrefixes.flatMap(prefix =>
  grayShades.map(shade => `${prefix}-${shade}`)
);

export default [
  ...tseslint.configs.recommended,
  {
    files: ["packages/app/src/**/*.tsx", "packages/app/src/**/*.ts"],
    plugins: {
      "tailwind-ban": tailwindBan,
    },
    rules: {
      // Ban hardcoded gray/slate — must use theme vars for light/dark mode
      "tailwind-ban/no-deny-tailwind-tokens": ["warn", { denyList }],
      // Disable noisy TS rules for existing code
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
