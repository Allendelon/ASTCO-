// Tailwind CDN theme shared by every page (loaded right after cdn.tailwindcss.com).
if (window.tailwind) tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: { 50: '#f0f7ff', 100: '#e0effe', 200: '#bae0fd', 400: '#38bdf8', 500: '#2563eb', 600: '#1d4ed8', 700: '#1e40af', 800: '#1e3a8a', 900: '#172554' },
        industrial: { 700: '#1e293b', 750: '#172033', 800: '#131b2e', 850: '#0f172a', 900: '#0a0f1d', 950: '#060a14' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Menlo', 'monospace'],
      },
    },
  },
};
