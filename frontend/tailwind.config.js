/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#0066ff',
          hover: '#0052cc',
          soft: 'rgba(0, 102, 255, 0.1)',
          glow: 'rgba(0, 102, 255, 0.28)',
        },
        navy: {
          dark: '#182232',
        },
        danger: {
          DEFAULT: '#ff3b30',
          soft: 'rgba(255, 59, 48, 0.1)',
        },
      },
      borderRadius: {
        xs: '8px',
        sm: '14px',
        md: '20px',
        lg: '28px',
        full: '9999px',
      },
    },
  },
  plugins: [],
};
