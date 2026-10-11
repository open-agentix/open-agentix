import { describe, expect, it } from 'vitest';
import { navigateTo } from '../src/lib/navigate';

describe('navigateTo', () => {
  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url'])(
    'refuses %s',
    (url) => {
      expect(() => navigateTo(url)).toThrow();
    },
  );
});
