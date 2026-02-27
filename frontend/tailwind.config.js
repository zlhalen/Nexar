/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'editor-bg': '#1e1e1e',
        'sidebar-bg': '#252526',
        'panel-bg': '#1e1e1e',
        'active-bg': '#37373d',
        'hover-bg': '#2a2d2e',
        'border-color': '#3e3e42',
        'text-primary': '#cccccc',
        'text-secondary': '#858585',
        'accent': '#007acc',
        'accent-hover': '#1a8ad4',
        'success': '#4ec9b0',
        'warning': '#dcdcaa',
        'error': '#f44747',
      },
    },
  },
  plugins: [],
}
