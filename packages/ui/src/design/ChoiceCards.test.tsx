import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { AppWindow, Globe, MousePointerClick } from 'lucide-react';
import { ChoiceCards } from './ChoiceCards';

afterEach(cleanup);

function SiteAccess({
  initial = null,
  labelled = true,
}: {
  initial?: 'tab' | 'site' | 'all' | null;
  labelled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <button type="button">Before</button>
      <h2 id="q">Turn on a site</h2>
      <ChoiceCards
        labelledBy={labelled ? 'q' : undefined}
        label={labelled ? undefined : 'Site access'}
        invalid={value === null}
        describedBy={value === null ? 'err' : undefined}
        value={value}
        onChange={setValue}
        options={[
          { value: 'tab', label: 'This tab', hint: 'When you click', icon: MousePointerClick },
          { value: 'site', label: 'One site', hint: 'Every visit', icon: AppWindow },
          { value: 'all', label: 'All sites', hint: 'Everywhere', icon: Globe, tone: 'warning' },
        ]}
      />
      <p id="err">Pick one</p>
      <button type="button">After</button>
    </>
  );
}

const radio = (name: string) =>
  screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(`^${name}`) });
const checkedNames = () =>
  screen
    .getAllByRole<HTMLInputElement>('radio')
    .filter((r) => r.checked)
    .map((r) => r.value);

describe('ChoiceCards', () => {
  it('is a named group of native radios; the meta line is part of each name', () => {
    render(<SiteAccess />);
    const group = screen.getByRole('radiogroup', { name: 'Turn on a site' });
    expect(group.tagName).toBe('FIELDSET');
    const radios = screen.getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((r) => r.type)).toEqual(['radio', 'radio', 'radio']);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1); // one group: the browser's arrow keys
    expect(radio('One site').closest('label')?.textContent).toContain('Every visit');
  });

  it('falls back to a visually hidden legend when there is no visible heading', () => {
    render(<SiteAccess labelled={false} />);
    expect(screen.getByRole('radiogroup', { name: 'Site access' })).toBeTruthy();
    expect(document.querySelector('legend')?.className).toBe('sv-vh');
  });

  it('marks the group invalid and points at the error until a card is picked', async () => {
    const user = userEvent.setup();
    render(<SiteAccess />);
    const group = screen.getByRole('radiogroup');
    expect(group.getAttribute('aria-invalid')).toBe('true');
    expect(group.getAttribute('aria-describedby')).toBe('err');
    await user.click(screen.getByText('All sites'));
    expect(checkedNames()).toEqual(['all']);
    expect(group.hasAttribute('aria-invalid')).toBe(false);
    expect(group.hasAttribute('aria-describedby')).toBe(false);
  });

  it('Tab enters on the checked card and leaves after one stop; arrows move and select', async () => {
    const user = userEvent.setup();
    render(<SiteAccess initial="site" />);
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(radio('One site'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));

    radio('One site').focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(radio('All sites'));
    expect(checkedNames()).toEqual(['all']);
    await user.keyboard('{ArrowRight}'); // wraps like a native group
    expect(checkedNames()).toEqual(['tab']);
    await user.keyboard('{ArrowLeft}');
    expect(checkedNames()).toEqual(['all']);
  });

  it('a click anywhere on the card selects it', async () => {
    const user = userEvent.setup();
    render(<SiteAccess initial="tab" />);
    await user.click(screen.getByText('Every visit'));
    expect(checkedNames()).toEqual(['site']);
  });
});
