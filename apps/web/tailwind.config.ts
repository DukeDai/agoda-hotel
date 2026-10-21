import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Single accent: deep teal. Dark-on-light, one hue, no purple gradient.
        brand: {
          50: '#eff9f7',
          100: '#d6f0ec',
          200: '#afe1da',
          300: '#7fcdc3',
          400: '#4bb2a6',
          500: '#2e968b',
          600: '#227a72',
          700: '#1e625d',
          800: '#1c4f4b',
          900: '#1a423f',
          950: '#082725',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px -14px rgba(15, 23, 42, 0.16)',
        pop: '0 12px 32px -12px rgba(15, 23, 42, 0.25)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 240ms ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
