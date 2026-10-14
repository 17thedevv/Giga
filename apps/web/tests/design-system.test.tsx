import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { GigaLogo } from '../src/components/GigaLogo.js';
import { GigaIcon } from '../src/components/GigaIcon.js';
import { Button } from '../src/components/Button.js';
import { Badge } from '../src/components/Badge.js';
import { Card, CardHeader, CardBody, CardFooter } from '../src/components/Card.js';
import { Alert } from '../src/components/Alert.js';
import { Input } from '../src/components/Input.js';
import { ThemeProvider, useTheme } from '../src/app/context/ThemeContext.js';

describe('GIGA Design System Primitives & Assets', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  describe('GigaLogo', () => {
    it('renders horizontal color logo by default', () => {
      render(<GigaLogo />);
      const img = screen.getByRole('img', { name: 'GIGA AI Cloud' });
      expect(img).toBeDefined();
      expect(img.getAttribute('src')).toBe('/giga/brand/logo/svg/giga-horizontal-color.svg');
    });

    it('renders mark variant with custom size', () => {
      render(<GigaLogo variant="mark" tone="color" width={32} height={32} />);
      const img = screen.getByRole('img', { name: 'GIGA AI Cloud' });
      expect(img.getAttribute('src')).toBe('/giga/brand/logo/svg/giga-mark-color.svg');
      expect(img.getAttribute('width')).toBe('32');
      expect(img.getAttribute('height')).toBe('32');
    });

    it('renders white tone variant for dark backgrounds', () => {
      render(<GigaLogo variant="wordmark" tone="white" />);
      const img = screen.getByRole('img', { name: 'GIGA AI Cloud' });
      expect(img.getAttribute('src')).toBe('/giga/brand/logo/svg/giga-wordmark-white.svg');
    });
  });

  describe('GigaIcon', () => {
    it('renders SVG icon referencing official sprite symbol', () => {
      const { container } = render(<GigaIcon name="copy" size={20} className="custom-icon" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeDefined();
      expect(svg?.getAttribute('width')).toBe('20');
      expect(svg?.getAttribute('height')).toBe('20');
      expect(svg?.classList.contains('g-icon')).toBe(true);
      expect(svg?.classList.contains('custom-icon')).toBe(true);

      const useElement = svg?.querySelector('use');
      expect(useElement?.getAttribute('href')).toBe('/giga/icons/icons-sprite.svg#icon-copy');
    });

    it('renders terminal and check icons properly', () => {
      const { container } = render(
        <>
          <GigaIcon name="terminal" />
          <GigaIcon name="check" />
        </>
      );
      const useElements = container.querySelectorAll('use');
      expect(useElements[0].getAttribute('href')).toBe('/giga/icons/icons-sprite.svg#icon-terminal');
      expect(useElements[1].getAttribute('href')).toBe('/giga/icons/icons-sprite.svg#icon-check');
    });
  });

  describe('Theme Management (ThemeContext)', () => {
    const TestThemeConsumer: React.FC = () => {
      const { theme, toggleTheme } = useTheme();
      return (
        <div>
          <span data-testid="current-theme">{theme}</span>
          <button data-testid="toggle-btn" onClick={toggleTheme}>
            Toggle
          </button>
        </div>
      );
    };

    it('initializes to dark theme by default and updates document data-theme', () => {
      render(
        <ThemeProvider>
          <TestThemeConsumer />
        </ThemeProvider>
      );

      expect(screen.getByTestId('current-theme').textContent).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(localStorage.getItem('giga-theme')).toBe('dark');
    });

    it('toggles theme to light and updates DOM and localStorage', () => {
      render(
        <ThemeProvider>
          <TestThemeConsumer />
        </ThemeProvider>
      );

      fireEvent.click(screen.getByTestId('toggle-btn'));

      expect(screen.getByTestId('current-theme').textContent).toBe('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(localStorage.getItem('giga-theme')).toBe('light');

      fireEvent.click(screen.getByTestId('toggle-btn'));

      expect(screen.getByTestId('current-theme').textContent).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  describe('GIGA UI Primitives', () => {
    it('renders Button with .g-btn and variant classes', () => {
      render(<Button variant="primary">Click Me</Button>);
      const btn = screen.getByRole('button', { name: 'Click Me' });
      expect(btn.classList.contains('g-btn')).toBe(true);
      expect(btn.classList.contains('g-btn--primary')).toBe(true);
    });

    it('renders Badge with .g-badge class and status text', () => {
      render(<Badge status="running" />);
      const badge = screen.getByText('Running...');
      expect(badge.classList.contains('g-badge')).toBe(true);
    });

    it('renders Card with .g-card and sections', () => {
      const { container } = render(
        <Card>
          <CardHeader><h3>Card Title</h3></CardHeader>
          <CardBody><p>Card Body</p></CardBody>
          <CardFooter><span>Footer</span></CardFooter>
        </Card>
      );
      expect(container.querySelector('.g-card')).toBeDefined();
      expect(container.querySelector('.g-card__header')).toBeDefined();
      expect(container.querySelector('.g-card__body')).toBeDefined();
      expect(container.querySelector('.g-card__footer')).toBeDefined();
      expect(screen.getByText('Card Title')).toBeDefined();
    });

    it('renders Input with .g-input class and labels', () => {
      render(<Input label="API Key" placeholder="sk-..." helperText="Your private key" />);
      expect(screen.getByText('API Key')).toBeDefined();
      expect(screen.getByText('Your private key')).toBeDefined();
      const input = screen.getByPlaceholderText('sk-...');
      expect(input.classList.contains('g-input')).toBe(true);
    });

    it('renders Alert with .g-alert and type class', () => {
      render(<Alert type="success" title="Success" message="Operation finished" />);
      const alert = screen.getByRole('alert');
      expect(alert.classList.contains('g-alert')).toBe(true);
      expect(alert.classList.contains('g-alert--success')).toBe(true);
      expect(screen.getByText('Success')).toBeDefined();
      expect(screen.getByText('Operation finished')).toBeDefined();
    });
  });
});
