function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatInline(escaped: string) {
  return escaped
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function inline(raw: string, allowPartial: boolean) {
  const escaped = escapeHtml(raw);
  if (!allowPartial) return formatInline(escaped);
  const bolds = raw.split("**").length - 1;
  const openLink = raw.lastIndexOf("[") > raw.lastIndexOf("]");
  if (bolds % 2 === 1 || openLink) return escaped;
  return formatInline(escaped);
}

function blocks(source: string, allowPartial: boolean) {
  const html: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    html.push(`<ul>${list.join("")}</ul>`);
    list = [];
  };
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    const bullet = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(trimmed);
    if (bullet) {
      list.push(`<li>${inline(bullet[1] ?? "", allowPartial)}</li>`);
      continue;
    }
    flush();
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      html.push(`<h3>${inline(heading[2] ?? "", allowPartial)}</h3>`);
      continue;
    }
    html.push(`<p>${inline(trimmed, allowPartial)}</p>`);
  }
  flush();
  return html.join("");
}

// Complete lines become Markdown. A trailing partial line stays escaped text so a half written ** or link does not flash.
export function renderMarkdown(source: string, streaming = false) {
  if (!streaming) return blocks(source, false);
  const end = source.lastIndexOf("\n");
  if (end === -1) return blocks(source, true);
  const done = blocks(source.slice(0, end), false);
  const partial = source.slice(end + 1);
  if (!partial) return done;
  return `${done}${blocks(partial, true)}`;
}
