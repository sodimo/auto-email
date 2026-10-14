// Vite `?raw` imports (used by tests/dormant.test.ts to read wrangler.jsonc).
declare module "*?raw" {
  const content: string;
  export default content;
}
