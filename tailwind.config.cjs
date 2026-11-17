module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // one type scale for the whole app: 11 / 12 / 13 / 15 / 18 / 28
    fontSize: {
      '2xs': ['11px', '16px'],
      xs: ['12px', '16px'],
      sm: ['13px', '20px'],
      base: ['15px', '22px'],
      lg: ['18px', '26px'],
      '2xl': ['28px', '34px'],
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
