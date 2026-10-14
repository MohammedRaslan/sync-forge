import { useTheme } from '../theme';
import { Icon } from './Icon';

/** Top bar button that switches between the dark and light theme; the icon shows the theme it switches to. */
export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button type="button" className="icon-button" onClick={toggle} aria-label={label} title={label}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}
