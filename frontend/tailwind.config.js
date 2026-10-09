/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#000000",
        surface: "#101010",
        raised: "#202020",
        mid: "#303030",
        highlight: "#505050",
        logo: "#F0F0F0",
        primary: "#F5F5F5",
        muted: "#888888",
        border: "#2A2A2A",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "6px",
      },
    },
  },
  plugins: [],
};
