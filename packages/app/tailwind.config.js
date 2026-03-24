/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        display: ["Outfit", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      colors: {
        ipl: {
          blue: "#004BA0",
          orange: "#FF822A",
          gold: "#D1AB3E",
        },
        // Theme-aware colors via CSS variables
        th: {
          body: "var(--th-body)",
          surface: "var(--th-surface)",
          raised: "var(--th-raised)",
          overlay: "var(--th-overlay)",
          primary: "var(--th-text-primary)",
          secondary: "var(--th-text-secondary)",
          muted: "var(--th-text-muted)",
          faint: "var(--th-text-faint)",
          border: "var(--th-border)",
          "border-strong": "var(--th-border-strong)",
        },
      },
      textColor: {
        th: {
          primary: "var(--th-text-primary)",
          secondary: "var(--th-text-secondary)",
          muted: "var(--th-text-muted)",
          faint: "var(--th-text-faint)",
        },
      },
      backgroundColor: {
        th: {
          body: "var(--th-body)",
          surface: "var(--th-surface)",
          raised: "var(--th-raised)",
          overlay: "var(--th-overlay)",
          hover: "var(--th-hover)",
        },
      },
      borderColor: {
        th: {
          DEFAULT: "var(--th-border)",
          strong: "var(--th-border-strong)",
        },
      },
      placeholderColor: {
        th: {
          DEFAULT: "var(--th-text-faint)",
        },
      },
      animation: {
        "fade-in": "fadeIn 0.4s ease-out",
        "slide-up": "slideUp 0.4s ease-out",
        "slide-in": "slideIn 0.25s ease-out",
        "slide-in-left": "slideInLeft 0.3s ease-out",
        "pulse-glow": "pulseGlow 2s ease-in-out infinite",
        "shimmer": "shimmer 2s linear infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideIn: {
          "0%": { opacity: "0", transform: "translateX(12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        slideInLeft: {
          "0%": { opacity: "0", transform: "translateX(-8px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        pulseGlow: {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};
