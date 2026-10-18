import { describe, expect, it } from 'vitest';

import {
  agrees,
  atSource,
  dump,
  makeDriver,
  meanings,
  meaningsOfSource,
  pressKey,
  setSelection,
  typeText,
  type Driver,
} from './core-driver';

/**
 * Edits are verified in context (issue #182, phase 5 review): the blocks next to an edit keep
 * their meaning. Each case here was a corruption the editor and the source disagreed about until
 * the section was loaded again - the oracle is a parse of the WHOLE resulting source.
 */
function open(text: string, needle: string, offset = 0, length = 0): Driver {
  const driver = makeDriver(text);
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no ${needle}`);
  setSelection(
    driver.core,
    atSource(driver.core, at + offset),
    length ? atSource(driver.core, at + offset + length) : undefined,
  );
  return driver;
}

const check = (driver: Driver) => {
  const message = `${JSON.stringify(driver.core.text)}\n${dump(driver.core.doc)}`;
  expect(agrees(driver.core), message).toBe(true);
  expect(driver.core.model.join()).toBe(driver.core.text);
};

describe('edits next to a block written with a single newline', () => {
  const tight = 'Intro text\n- item one\n- item two\n\nEnd.';

  it('Enter at the start of the first item does not turn the paragraph above into a heading', () => {
    const driver = open(tight, 'item one');
    const { handled, result } = pressKey(driver, 'Enter');
    expect(handled && result?.ok).toBe(true);
    check(driver);
    expect(meanings(driver.core.doc)[0]).toContain('"p"');
  });

  it('deleting the only character of the first item does not either', () => {
    const driver = open('Intro text\n- a\n- b\n\nEnd.', 'a', 0, 1);
    const result = driver.core.apply(driver.core.state.tr.deleteSelection());
    expect(result.ok).toBe(true);
    check(driver);
    expect(meanings(driver.core.doc)[0]).toContain('"p"');
  });

  it('Backspace at the start of the first item does not glue its text to the paragraph above', () => {
    const driver = open(tight, 'item one');
    pressKey(driver, 'Backspace');
    check(driver);
  });

  it('Enter at the end of a heading and typing does not merge into the next paragraph', () => {
    const driver = open('### Results\nThe system works.\n\nEnd.', 'Results', 7);
    pressKey(driver, 'Enter');
    typeText(driver, 'We found that');
    check(driver);
    // Four blocks: the heading, the new paragraph, and the two that were there.
    expect(meanings(driver.core.doc)).toHaveLength(4);
    expect(driver.core.text).toContain('We found that');
  });

  it('spaces typed at the start of the paragraph after a list do not make it part of the list', () => {
    const driver = open('- item one\n- item two\n\nAfter the list.', 'After', 0);
    typeText(driver, '  ');
    check(driver);
    expect(meanings(driver.core.doc)).toHaveLength(2);
    expect(driver.core.text.endsWith('\n\nAfter the list.')).toBe(true);
  });

  it('typing "- " on a paragraph before indented code keeps the code a code block', () => {
    const driver = open('Intro\n\n    indented code\n', 'Intro', 0);
    typeText(driver, '- ');
    check(driver);
    expect(meaningsOfSource(driver.core.text).join('')).toContain('"c"');
  });

  it('a list typed next to a task list (shown as an atom) does not merge into it', () => {
    const driver = open('- [ ] task\n- [x] done\n\nText', 'Text', 0);
    typeText(driver, '- ');
    check(driver);
    expect(meanings(driver.core.doc)).toHaveLength(2);
  });

  it('a list indented by one to three spaces next to a list with the same marker stays apart', () => {
    const driver = open('   - one\n   - two\n\nText', 'Text', 0);
    typeText(driver, '- ');
    check(driver);
    expect(meanings(driver.core.doc)).toHaveLength(2);
  });
});

describe('typing syntax that would swallow the rest of the section', () => {
  it('$$ typed in a new paragraph does not turn everything after it into display math', () => {
    const driver = open('One.\n\nTwo.\n\nThree.', 'One.', 4);
    pressKey(driver, 'Enter');
    typeText(driver, '$$');
    check(driver);
    expect(meanings(driver.core.doc)).toHaveLength(4);
    expect(driver.core.text).toContain('Two.');
    expect(driver.core.text).toContain('Three.');
  });

  it('$$, a line of text and $$ typed as three paragraphs stay three paragraphs', () => {
    const driver = open('Start', 'Start', 5);
    for (const line of ['$$', 'x = 1', '$$']) {
      pressKey(driver, 'Enter');
      typeText(driver, line);
      check(driver);
    }
    expect(meanings(driver.core.doc)).toHaveLength(4);
  });

  it('an opening code fence typed as a paragraph is text, not a code block to the end', () => {
    const driver = open('One.\n\nTwo.', 'One.', 4);
    pressKey(driver, 'Enter');
    typeText(driver, '```');
    check(driver);
    expect(meanings(driver.core.doc)).toHaveLength(3);
  });

  it('an HTML comment opener typed as a paragraph does not comment out the rest', () => {
    const driver = open('One.\n\nTwo.', 'One.', 4);
    pressKey(driver, 'Enter');
    typeText(driver, '<!--');
    check(driver);
    expect(meanings(driver.core.doc)).toHaveLength(3);
  });
});
