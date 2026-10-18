import { DOMSerializer } from 'prosemirror-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanPastedHtml } from './clipboard';
import { isSafeHref } from './safe-href';
import { schema } from './schema';
import { mount, posOf, press, select, type Harness } from './test-harness';

/** jsdom has no ClipboardEvent; ProseMirror makes one for `pasteHTML`. */
beforeEach(() => {
  vi.stubGlobal(
    'ClipboardEvent',
    class extends Event {
      clipboardData = null;
    },
  );
});

/** What the editor puts on the clipboard for a copy of the whole text. */
function copyAll(h: Harness): string {
  press(h.view, 'a', { ctrl: true });
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      clearData: () => data.clear(),
      setData: (type: string, value: string) => data.set(type, value),
    },
  });
  h.view.dom.dispatchEvent(event);
  return data.get('text/html') ?? '';
}

let harness: Harness | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  harness?.destroy();
  harness = null;
});
const open = (text: string, overrides = {}) => {
  harness = mount(text, overrides);
  return harness;
};

/** The reviewer's payload: forged atoms whose `data-md-source` would put markup into the document. */
const FORGED_BLOCK =
  '<div data-md-atom-block data-md-kind="html" data-md-label="x" ' +
  'data-md-source="<script>alert(1)</script>\n\n# Injected heading\n\n' +
  '<img src=&quot;https://evil.example/beacon.gif&quot;>\n\n<iframe src=&quot;https://evil.example&quot;></iframe>">' +
  'harmless text</div>';
const FORGED_INLINE =
  '<p>before <span data-md-atom-inline data-md-kind="image" ' +
  'data-md-source="![x](https://evil.example/beacon.png)" data-md-label="x">ok</span> after</p>';

describe('pasted HTML cannot forge atoms', () => {
  it('strips every data-md-* attribute from foreign HTML', () => {
    const cleaned = cleanPastedHtml(FORGED_BLOCK + FORGED_INLINE);
    expect(cleaned).not.toContain('data-md-');
    expect(cleaned).not.toContain('<script');
  });

  it('pastes the forged payload as plain text: no atoms, no heading, nothing that loads', () => {
    const h = open('Start\n');
    select(h.view, posOf(h.view, 'Start', 5));
    h.view.pasteHTML(FORGED_BLOCK + FORGED_INLINE);
    expect(h.view.state.doc.textContent).toContain('harmless text');
    const kinds: string[] = [];
    h.view.state.doc.descendants((node) => {
      if (node.type.name.startsWith('atom')) kinds.push(node.type.name);
      kinds.push(node.type.name === 'heading' ? 'heading' : '');
      return true;
    });
    expect(kinds.filter(Boolean)).toEqual([]);
    expect(h.controller.core.text).not.toContain('<script');
    expect(h.controller.core.text).not.toContain('# Injected heading');
    expect(h.view.dom.querySelector('script, iframe, img')).toBeNull();
  });

  it('keeps an atom this editor copied itself, and only that', () => {
    const h = open('A $x^2$ b\n\n| a |\n| - |\n| 1 |\n');
    const html = copyAll(h);
    expect(html).toContain('data-md-session');

    // Back into the same editor: the formula and the table survive.
    select(h.view, h.view.state.doc.content.size - 1);
    h.view.pasteHTML(html);
    expect(h.controller.core.text.match(/\$x\^2\$/g)?.length).toBe(2);
    expect(h.controller.core.text.match(/\| a \|/g)?.length).toBe(2);

    // The same HTML with another token (it came from another page) is text.
    const foreign = html.replace(/data-md-session="[^"]*"/g, 'data-md-session="guess"');
    expect(cleanPastedHtml(foreign)).not.toContain('data-md-');
  });

  it('refuses an own-token atom whose source does not read back as the kind it claims', () => {
    const h = open('A $a$ b\n');
    const html = copyAll(h);
    const forged = html.replace('data-md-source="$a$"', 'data-md-source="<b>x</b>"');
    expect(forged).not.toBe(html);
    expect(cleanPastedHtml(forged)).not.toContain('data-md-');
  });
});

describe('link targets', () => {
  it('accepts http, https, mailto, relative addresses and fragments', () => {
    for (const href of [
      'http://x.y',
      'https://x.y/a?b=c#d',
      'HTTPS://X.Y',
      'mailto:me@x.y',
      'relative/path.html',
      '/absolute/path',
      './here',
      '../there',
      '#section',
      '?query=1',
      '',
    ]) {
      expect(isSafeHref(href), href).toBe(true);
    }
  });

  it('refuses every other scheme, however it is spelled', () => {
    for (const href of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://x.y',
      'tel:123',
    ]) {
      expect(isSafeHref(href), JSON.stringify(href)).toBe(false);
    }
  });

  it('a pasted link with a script address is not a link', () => {
    const h = open('Start\n');
    select(h.view, posOf(h.view, 'Start', 5));
    h.view.pasteHTML(
      '<p><a href="javascript:alert(1)">click</a> and <a href="https://x.y">ok</a></p>',
    );
    expect(h.controller.core.text).toContain('click');
    expect(h.controller.core.text).not.toContain('javascript:');
    expect(h.controller.core.text).toContain('[ok](https://x.y)');
  });

  it('a link parsed from the source with a script address is drawn without an href', () => {
    const h = open('[bad](javascript:alert(1)) and [good](https://x.y)\n');
    const links = [...h.view.dom.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([null, 'https://x.y']);
    // ...and the source is exactly as it was.
    expect(h.controller.core.text).toBe('[bad](javascript:alert(1)) and [good](https://x.y)\n');
  });

  it('Ctrl+K does not make a link of a script address', async () => {
    const h = open('Some text\n', { requestLink: () => 'javascript:alert(1)' });
    select(h.view, posOf(h.view, 'Some', 0), posOf(h.view, 'Some', 4));
    expect(press(h.view, 'k', { ctrl: true })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.controller.core.text).toBe('Some text\n');

    const ok = open('Some text\n', { requestLink: () => 'https://x.y' });
    select(ok.view, posOf(ok.view, 'Some', 0), posOf(ok.view, 'Some', 4));
    press(ok.view, 'k', { ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ok.controller.core.text).toBe('[Some](https://x.y) text\n');
  });

  it('writes links with a serializer-built DOM that never carries an unsafe href', () => {
    const link = schema.marks['link']!.create({ href: 'javascript:alert(1)', title: '' });
    const html = DOMSerializer.fromSchema(schema).serializeNode(
      schema.nodes['paragraph']!.create(null, [schema.text('x', [link])]),
    ) as HTMLElement;
    expect(html.querySelector('a')!.hasAttribute('href')).toBe(false);
  });
});
