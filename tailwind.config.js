/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        sidebar: 'var(--color-sidebar)',
        surface: 'var(--color-surface)',
        border: 'var(--color-border)',
        accent: 'var(--color-accent)'
      }
    }
  },
  plugins: []
}
