import * as cheerio from "cheerio";

export interface ExtractedContent {
  title: string | null;
  text: string;
}

export function extractPageContent(html: string, maxCharacters: number): ExtractedContent {
  const $ = cheerio.load(html);

  $("script, style, noscript, template, svg, canvas, iframe").remove();
  $("nav, footer").remove();

  const title = normalizeInlineText($("title").first().text()) || null;
  const preferredRoot = $("main").first();
  const root = preferredRoot.length > 0 ? preferredRoot : $("body").first();

  const blocks: string[] = [];
  root.find("h1, h2, h3, h4, p, li, dt, dd, button, a, time, td, th, [role=\"status\"]")
    .each((_index, element) => {
      const text = normalizeInlineText($(element).text());
      if (text.length > 0 && blocks.at(-1) !== text) {
        blocks.push(text);
      }
    });

  const fallback = normalizeMultilineText(root.text());
  const combined = blocks.length > 0 ? blocks.join("\n") : fallback;
  const text = combined.slice(0, maxCharacters).trim();

  if (text.length === 0) {
    throw new Error("The page does not contain readable text.");
  }

  return { title, text };
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeMultilineText(value: string): string {
  return value
    .split(/\r?\n/)
    .map(normalizeInlineText)
    .filter(Boolean)
    .join("\n");
}
