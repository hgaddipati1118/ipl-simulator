/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ipl: {
          blue: "#004BA0",
          orange: "#FF822A",
          gold: "#D1AB3E",
        },
      },
    },
  },
  plugins: [],
};
