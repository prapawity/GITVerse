module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // one type scale for the whole app: 11 / 12 / 13 / 15 / 18 / 28
    fontSize: {
      '2xs': ['calc(11px * var(--ui-font-scale, 1))', '1.46'],
      xs: ['calc(12px * var(--ui-font-scale, 1))', '1.34'],
      sm: ['calc(13px * var(--ui-font-scale, 1))', '1.54'],
      base: ['calc(15px * var(--ui-font-scale, 1))', '1.47'],
      lg: ['calc(18px * var(--ui-font-scale, 1))', '1.45'],
      '2xl': ['calc(28px * var(--ui-font-scale, 1))', '1.22'],
    },
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        mantle: 'rgb(var(--mantle) / <alpha-value>)',
        crust: 'rgb(var(--crust) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        text: 'rgb(var(--text) / <alpha-value>)',
        sub: 'rgb(var(--sub) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
        ai: 'rgb(var(--ai) / <alpha-value>)',
      },
    },
  },
};
