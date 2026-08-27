/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Segoe UI Variable', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'monospace'],
      },
      colors: {
        ink: '#111813',
        canvas: '#f4f5ef',
        signal: '#d7ff3f',
        cyan: '#5fe1e7',
        coral: '#ff735c',
      },
      boxShadow: {
        panel: '0 18px 60px rgba(17, 24, 19, 0.08)',
      },
    },
  },
  plugins: [],
};
