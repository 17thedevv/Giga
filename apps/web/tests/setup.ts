// Vitest test setup file
import '@testing-library/dom';
import { vi } from 'vitest';

if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}
