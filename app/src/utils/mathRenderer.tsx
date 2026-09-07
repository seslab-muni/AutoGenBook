import React, { useMemo } from 'react';
import katex from 'katex';

interface MathRendererProps {
  content: string;
  className?: string;
}

export const MathRenderer: React.FC<MathRendererProps> = ({ content, className = '' }) => {
  const renderedContent = useMemo(() => {
    if (!content) return null;

    const lines = content.split('\n');
    const parsedElements: React.ReactNode[] = [];

    let insideBlockMath = false;
    let blockMathBuffer: string[] = [];
    let insideCodeBlock = false;
    let codeBlockBuffer: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();

      // Code blocks ```
      if (trimmed.startsWith('```')) {
        if (insideCodeBlock) {
          insideCodeBlock = false;
          parsedElements.push(
            <pre key={`code-${i}`} className="my-3 p-3.5 bg-slate-900 text-indigo-200 font-mono text-xs rounded-xl overflow-x-auto border border-slate-800 shadow-inner">
              <code>{codeBlockBuffer.join('\n')}</code>
            </pre>
          );
          codeBlockBuffer = [];
        } else {
          insideCodeBlock = true;
          codeBlockBuffer = [];
        }
        continue;
      }

      if (insideCodeBlock) {
        codeBlockBuffer.push(line);
        continue;
      }

      // Check standalone inline-block math $$...$$ on a single line
      if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 2) {
        const mathExpr = trimmed.slice(2, -2).trim();
        try {
          const html = katex.renderToString(mathExpr, { displayMode: true, throwOnError: false });
          parsedElements.push(
            <div
              key={`block-math-${i}`}
              className="my-4 p-3.5 bg-slate-50 border border-slate-200 rounded-lg overflow-x-auto text-center font-serif text-slate-900 shadow-2xs"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        } catch {
          parsedElements.push(
            <pre key={`err-math-${i}`} className="my-3 p-3 bg-slate-100 text-amber-700 font-mono text-xs rounded border border-amber-200">
              {mathExpr}
            </pre>
          );
        }
        continue;
      }

      // Multiline block math opener/closer $$
      if (trimmed === '$$') {
        if (insideBlockMath) {
          insideBlockMath = false;
          const mathExpr = blockMathBuffer.join('\n');
          try {
            const html = katex.renderToString(mathExpr, { displayMode: true, throwOnError: false });
            parsedElements.push(
              <div
                key={`block-math-buf-${i}`}
                className="my-4 p-3.5 bg-slate-50 border border-slate-200 rounded-lg overflow-x-auto text-center font-serif text-slate-900 shadow-2xs"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          } catch {
            parsedElements.push(
              <pre key={`err-math-buf-${i}`} className="my-3 p-3 bg-slate-100 text-amber-700 font-mono text-xs rounded border border-amber-200">
                {mathExpr}
              </pre>
            );
          }
          blockMathBuffer = [];
        } else {
          insideBlockMath = true;
          blockMathBuffer = [];
        }
        continue;
      }

      if (insideBlockMath) {
        blockMathBuffer.push(line);
        continue;
      }

      // Headers
      if (line.startsWith('# ')) {
        parsedElements.push(
          <h1 key={`h1-${i}`} className="text-2xl font-bold font-serif text-slate-900 mt-6 mb-3 tracking-tight border-b border-slate-200 pb-2">
            {renderFormattedText(line.replace(/^#\s+/, ''))}
          </h1>
        );
        continue;
      }
      if (line.startsWith('## ')) {
        parsedElements.push(
          <h2 key={`h2-${i}`} className="text-xl font-semibold font-serif text-slate-900 mt-5 mb-2 tracking-tight">
            {renderFormattedText(line.replace(/^##\s+/, ''))}
          </h2>
        );
        continue;
      }
      if (line.startsWith('### ')) {
        parsedElements.push(
          <h3 key={`h3-${i}`} className="text-lg font-medium font-serif text-slate-800 mt-4 mb-2">
            {renderFormattedText(line.replace(/^###\s+/, ''))}
          </h3>
        );
        continue;
      }

      // Theorem or Definition Callout box
      if (
        line.startsWith('> **Theorem') || 
        line.startsWith('> **Definition') || 
        line.startsWith('> **Lemma') || 
        line.startsWith('**Theorem') || 
        line.startsWith('**Definition') || 
        line.startsWith('**Lemma')
      ) {
        const parts = line.split('**');
        const heading = parts[1] || 'Formal Theorem';
        const body = parts.slice(2).join('**').replace(/^[:\s-]+/, '');
        parsedElements.push(
          <div key={`thm-${i}`} className="my-4 p-4 rounded-xl bg-indigo-50/70 border-l-4 border-indigo-600 text-slate-800 shadow-2xs">
            <div className="font-semibold text-indigo-900 text-xs tracking-wide uppercase mb-1 flex items-center gap-1.5 font-sans">
              <span className="w-2 h-2 rounded-full bg-indigo-600"></span>
              {heading}
            </div>
            <div className="text-sm italic font-serif leading-relaxed text-slate-700">
              {renderFormattedText(body)}
            </div>
          </div>
        );
        continue;
      }

      // Blockquotes
      if (line.startsWith('> ')) {
        parsedElements.push(
          <blockquote key={`bq-${i}`} className="my-3 pl-4 border-l-2 border-slate-300 italic text-slate-600 text-sm">
            {renderFormattedText(line.replace(/^>\s*/, ''))}
          </blockquote>
        );
        continue;
      }

      // Unordered List
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        parsedElements.push(
          <li key={`li-${i}`} className="ml-5 list-disc text-slate-700 leading-relaxed text-sm my-1">
            {renderFormattedText(trimmed.replace(/^[-*]\s+/, ''))}
          </li>
        );
        continue;
      }

      // Ordered List
      if (/^\d+\.\s+/.test(trimmed)) {
        parsedElements.push(
          <li key={`oli-${i}`} className="ml-5 list-decimal text-slate-700 leading-relaxed text-sm my-1">
            {renderFormattedText(trimmed.replace(/^\d+\.\s+/, ''))}
          </li>
        );
        continue;
      }

      // Empty line
      if (!trimmed) {
        parsedElements.push(<div key={`sp-${i}`} className="h-2.5" />);
        continue;
      }

      // Normal paragraph with rich formatting & inline math
      parsedElements.push(
        <p key={`p-${i}`} className="text-slate-700 leading-relaxed text-sm font-sans my-2.5">
          {renderFormattedText(line)}
        </p>
      );
    }

    return parsedElements;
  }, [content]);

  return <div className={`math-document prose-slate ${className}`}>{renderedContent}</div>;
};

// Helper to render inline formatting (bold, italic, code, and $...$ KaTeX math)
export function renderFormattedText(text: string): React.ReactNode {
  if (!text) return '';

  // First split by math tokens $...$
  const mathSegments = text.split(/(\$[^$]+\$)/g);

  return mathSegments.map((segment, idx) => {
    // If it is inline math $...$
    if (segment.startsWith('$') && segment.endsWith('$') && segment.length > 2) {
      const math = segment.slice(1, -1);
      try {
        const html = katex.renderToString(math, { displayMode: false, throwOnError: false });
        return (
          <span
            key={`math-${idx}`}
            className="font-serif inline-math px-1 text-indigo-700 font-semibold align-baseline"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      } catch {
        return (
          <code key={`math-err-${idx}`} className="font-mono text-xs text-amber-700 bg-slate-100 px-1 py-0.5 rounded border border-slate-200">
            {math}
          </code>
        );
      }
    }

    // Otherwise render standard inline markdown formatting (bold, code, italic)
    return <span key={`txt-${idx}`}>{renderInlineFormatting(segment)}</span>;
  });
}

function renderInlineFormatting(str: string): React.ReactNode {
  // Simple parser for bold **text**, italic *text*, and `code`
  const tokens = str.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);

  return tokens.map((token, idx) => {
    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      return <strong key={idx} className="font-bold text-slate-900">{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      return <em key={idx} className="italic text-slate-800">{token.slice(1, -1)}</em>;
    }
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      return <code key={idx} className="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-100 text-indigo-700 border border-slate-200">{token.slice(1, -1)}</code>;
    }
    return token;
  });
}
