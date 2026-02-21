/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        teal: {
          400: '#3AAFA9',
          500: '#2E9E98',
        },
        gold: {
          400: '#C9A96E',
        }
      }
    },
  },
  plugins: [],
}
