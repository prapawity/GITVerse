module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        mantle: 'rgb(var(--mantle) / <alpha-value>)',
        crust: 'rgb(var(--crust) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        text: 'rgb(var(--text) / <alpha-value>)',
        sub: 'rgb(var(--sub) / <alpha-value>)',
      },
    },
  },
};
